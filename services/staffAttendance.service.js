import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * StaffAttendanceService — clock in/out, attendance history, punctuality
 * reporting, and daily reconciliation against the clinician's declared
 * schedule.
 *
 * Status derivation rules — ALL writes route through `_deriveStatus` so
 * the rules are defined exactly once:
 *
 *  - LEAVE   : a full-day BlockedSlot with kind='LEAVE' covers the shift.
 *  - WFH     : a BlockedSlot with kind='WFH' covers any part of the shift.
 *              Clock-in is still allowed (and recommended) but not required.
 *  - ABSENT  : (a) no clock-in by end-of-day AND no leave/WFH block AND
 *              the clinician had a scheduled shift that day, OR
 *              (b) clocked-out with worked time < MIN_WORKED_MIN_FOR_HALFDAY
 *              (a "token" clock-in/out doesn't count as half-day).
 *  - HALF_DAY: clocked out with MIN_WORKED_MIN_FOR_HALFDAY ≤ worked <
 *              HALF_DAY_THRESHOLD_MIN.
 *  - LATE    : worked ≥ HALF_DAY_THRESHOLD_MIN AND clocked in more than
 *              LATE_GRACE_MINUTES after scheduledStart.
 *              `lateMinutes` is set to (clockIn - scheduledStart).
 *  - PRESENT : worked ≥ HALF_DAY_THRESHOLD_MIN AND on-time (within grace).
 *
 * Clinicians with no declared schedule for the day (therapist Availability
 * is empty AND the branch is closed via Branch.weeklyClosedDays) are
 * skipped — no attendance row is created, so "off day" doesn't pollute
 * punctuality stats.
 *
 * All wall-clock date / time arithmetic is anchored in the clinic
 * timezone (CLINIC_TZ_OFFSET) so the service behaves identically whether
 * deployed on an IST server or a UTC one.
 */

// India Standard Time. Matches the constant in routes/availability.js —
// kept in sync so slot windows and attendance days agree about "today".
// If the platform ever serves clinics outside India this becomes a
// per-Hospital/Branch column.
const CLINIC_TZ_OFFSET = '+05:30';
const TZ_OFFSET_MIN    = 5 * 60 + 30;   // minutes east of UTC

export class StaffAttendanceService {
    static LATE_GRACE_MINUTES = 10;
    static HALF_DAY_THRESHOLD_MIN = 240; // 4 hours
    // A clock-in/out span shorter than this is treated as a token entry
    // (forgot to clock out earlier, accidental press, etc.) and downgraded
    // to ABSENT rather than dignified as HALF_DAY. Audit fix #3.
    static MIN_WORKED_MIN_FOR_HALFDAY = 30;
    static DEFAULT_SHIFT_START = '09:00';
    static DEFAULT_SHIFT_END = '18:00';

    /**
     * Clock in for today.
     *
     * Derives the scheduled start from the clinician's Availability (or
     * branch operating hours as a fallback) and stamps status accordingly.
     * If a WFH blocked slot covers the day, the record is flagged WFH
     * (still counts as worked — the user can optionally clock in to log
     * the start time).
     */
    static async clockIn(userId, branchId) {
        const now = new Date();
        const today = _startOfDay(now);

        const existing = await prisma.staffAttendance.findUnique({
            where: { userId_date: { userId, date: today } },
        });

        // Don't overwrite a real clock-in with a second one — admin tooling
        // can edit the record directly if a correction is needed.
        if (existing?.clockIn) {
            throw new Error('Already clocked in for today');
        }

        const schedule = await _resolveScheduledWindow(userId, today, branchId);
        const blocks   = await _getBlocksForDate(userId, today);

        const leaveBlock = blocks.find((b) => (b.kind || '').toUpperCase() === 'LEAVE' && _isFullDay(b, schedule));
        if (leaveBlock) {
            throw new Error(`On approved leave today (${leaveBlock.reason || 'LEAVE'}) — cannot clock in`);
        }

        const wfhBlock = blocks.find((b) => (b.kind || '').toUpperCase() === 'WFH');
        const { status, lateMinutes } = _deriveStatus({
            schedule, clockIn: now, clockOut: null, leaveBlock: null, wfhBlock,
        });

        const record = await prisma.staffAttendance.upsert({
            where:  { userId_date: { userId, date: today } },
            create: {
                userId,
                branchId,
                date: today,
                scheduledStart: schedule?.start || null,
                scheduledEnd:   schedule?.end   || null,
                clockIn: now,
                status,
                lateMinutes,
            },
            update: {
                clockIn: now,
                branchId,
                scheduledStart: schedule?.start || null,
                scheduledEnd:   schedule?.end   || null,
                status,
                lateMinutes,
            },
            include: {
                user: { select: { id: true, email: true, role: true } },
                branch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[Attendance] Clock-in: user=${userId} status=${status} late=${lateMinutes}m`);
        return record;
    }

    /**
     * Clock out for today.
     *
     * Requires a prior clock-in. Downgrades status to HALF_DAY when the
     * total worked time is below HALF_DAY_THRESHOLD_MIN — except when the
     * day is WFH (remote hours are trusted) or LEAVE (already terminal).
     */
    static async clockOut(userId) {
        const now = new Date();
        const today = _startOfDay(now);

        const existing = await prisma.staffAttendance.findUnique({
            where: { userId_date: { userId, date: today } },
        });
        if (!existing || !existing.clockIn) {
            throw new Error('No active clock-in found for today');
        }
        if (existing.clockOut) {
            throw new Error('Already clocked out for today');
        }

        // Honour the original LEAVE/WFH classification regardless of how
        // long the user "worked" — both are administratively-set states.
        let status, lateMinutes;
        if (existing.status === 'LEAVE' || existing.status === 'WFH') {
            status = existing.status;
            lateMinutes = existing.lateMinutes;
        } else {
            const schedule = existing.scheduledStart
                ? { start: existing.scheduledStart, end: existing.scheduledEnd }
                : null;
            ({ status, lateMinutes } = _deriveStatus({
                schedule,
                clockIn:  existing.clockIn,
                clockOut: now,
                leaveBlock: null,
                wfhBlock: null,
            }));
        }

        const workedMin = Math.max(0, Math.round((now.getTime() - existing.clockIn.getTime()) / 60_000));

        const record = await prisma.staffAttendance.update({
            where: { userId_date: { userId, date: today } },
            data:  { clockOut: now, status, lateMinutes },
            include: {
                user: { select: { id: true, email: true, role: true } },
                branch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[Attendance] Clock-out: user=${userId} worked=${workedMin}m status=${status}`);
        return record;
    }

    /**
     * Admin override — upsert an attendance row for an arbitrary staff
     * member on an arbitrary date. Used by ADMIN / ADMIN_DOCTOR to:
     *   - correct a missed clock-in/out after the fact
     *   - back-fill attendance for a clinician who forgot
     *   - force a status (e.g. LEAVE retroactively without a block)
     *
     * Rules:
     *   - `clockIn` / `clockOut` are HH:mm strings interpreted on `date`.
     *   - If `clockOut` is provided without `clockIn`, reject.
     *   - If both provided, `clockIn` must be strictly before `clockOut`.
     *   - When `status` is omitted, we re-derive it using the exact same
     *     rules as self-service clock-in/out so the record stays
     *     internally consistent (PRESENT/LATE/HALF_DAY based on schedule
     *     + worked minutes; WFH/LEAVE when blocks cover the day).
     *   - When `status` is provided, it wins — the admin knows something
     *     the rules don't (e.g. off-site training day).
     *   - An audit trail line is appended to `notes` so the next reader
     *     can see the row was edited rather than self-clocked.
     */
    static async setAttendance({ actorId, actorEmail, targetUserId, date, clockIn, clockOut, status, notes }) {
        if (!targetUserId) throw new Error('targetUserId is required');
        if (!date) throw new Error('date is required');
        if (clockOut && !clockIn) throw new Error('clockOut requires clockIn');

        const timeRe = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
        if (clockIn  && !timeRe.test(clockIn))  throw new Error('clockIn must be HH:mm');
        if (clockOut && !timeRe.test(clockOut)) throw new Error('clockOut must be HH:mm');
        if (clockIn && clockOut && clockIn >= clockOut) {
            throw new Error('clockIn must be before clockOut');
        }

        const target = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { id: true, role: true, branchId: true, email: true },
        });
        if (!target) throw new Error('Target user not found');

        const day = _startOfDay(date);
        const clockInDate  = clockIn  ? _combineDateAndTime(day, clockIn)  : null;
        const clockOutDate = clockOut ? _combineDateAndTime(day, clockOut) : null;

        const schedule = await _resolveScheduledWindow(targetUserId, day, target.branchId);
        const blocks   = await _getBlocksForDate(targetUserId, day);

        const leaveBlock = blocks.find((b) => (b.kind || '').toUpperCase() === 'LEAVE' && _isFullDay(b, schedule));
        const wfhBlock   = blocks.find((b) => (b.kind || '').toUpperCase() === 'WFH');

        // Single source of truth — same rules as clockIn/clockOut.
        const derived = _deriveStatus({
            schedule, clockIn: clockInDate, clockOut: clockOutDate, leaveBlock, wfhBlock,
        });
        const finalStatus = status || derived.status;
        const lateMinutes = derived.lateMinutes;

        // Audit-trail append. Previously this stomped the prior `notes`
        // column on every edit (the comment claimed "appended" but the
        // code wrote a fresh string). Now we read the existing row's notes
        // first and stack edits chronologically. Audit fix #2.
        const previous = await prisma.staffAttendance.findUnique({
            where:  { userId_date: { userId: targetUserId, date: day } },
            select: { notes: true },
        });
        const auditLine = `Edited by ${actorEmail || actorId} at ${new Date().toISOString()}`;
        const newSegment = notes ? `${notes} | ${auditLine}` : auditLine;
        const finalNotes = previous?.notes
            ? `${previous.notes} || ${newSegment}`
            : newSegment;

        const record = await prisma.staffAttendance.upsert({
            where:  { userId_date: { userId: targetUserId, date: day } },
            create: {
                userId: targetUserId,
                branchId: target.branchId,
                date: day,
                scheduledStart: schedule?.start || null,
                scheduledEnd:   schedule?.end   || null,
                clockIn:  clockInDate,
                clockOut: clockOutDate,
                status: finalStatus,
                lateMinutes,
                notes: finalNotes,
            },
            update: {
                branchId: target.branchId,
                scheduledStart: schedule?.start || null,
                scheduledEnd:   schedule?.end   || null,
                clockIn:  clockInDate,
                clockOut: clockOutDate,
                status: finalStatus,
                lateMinutes,
                notes: finalNotes,
            },
            include: {
                user: { select: { id: true, email: true, role: true } },
                branch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[Attendance] Admin edit by ${actorId}: target=${targetUserId} date=${day.toISOString().slice(0, 10)} ` +
                    `status=${finalStatus} clockIn=${clockIn || '--'} clockOut=${clockOut || '--'}`);
        return record;
    }

    /**
     * Admin override — delete an attendance row. Handy when a duplicate
     * or wrong-day record slipped in; the nightly reconcile will recreate
     * it correctly on the next run.
     *
     * Writes an `AuditLog` row capturing the deleted state so the action
     * is auditable. Previously the delete was silent — audit fix #16.
     */
    static async deleteAttendance({ actorId, targetUserId, date }) {
        const day = _startOfDay(date);
        // Snapshot the row BEFORE deleting so the audit log carries the
        // exact data that was removed.
        const existing = await prisma.staffAttendance.findUnique({
            where: { userId_date: { userId: targetUserId, date: day } },
        });
        await prisma.staffAttendance.delete({
            where: { userId_date: { userId: targetUserId, date: day } },
        });
        try {
            await prisma.auditLog.create({
                data: {
                    userId: actorId,
                    action: 'DELETE_STAFF_ATTENDANCE',
                    entityType: 'StaffAttendance',
                    entityId: existing?.id || null,
                    oldData: existing
                        ? {
                            userId:    existing.userId,
                            branchId:  existing.branchId,
                            date:      existing.date.toISOString(),
                            clockIn:   existing.clockIn  ? existing.clockIn.toISOString()  : null,
                            clockOut:  existing.clockOut ? existing.clockOut.toISOString() : null,
                            status:    existing.status,
                            lateMinutes: existing.lateMinutes,
                            notes:     existing.notes,
                        }
                        : { targetUserId, date: day.toISOString() },
                    newData: null,
                },
            });
        } catch (auditErr) {
            // Audit failure must not abort the delete — log and move on.
            logger.warn('[Attendance] audit log skipped:', auditErr.message);
        }
        logger.info(`[Attendance] Admin delete by ${actorId}: target=${targetUserId} date=${day.toISOString().slice(0, 10)}`);
        return { deleted: true };
    }

    /**
     * Get attendance history for a user.
     */
    static async getAttendance(userId, { startDate, endDate }) {
        const where = { userId };
        if (startDate || endDate) {
            where.date = {};
            if (startDate) where.date.gte = new Date(startDate);
            if (endDate) where.date.lte = new Date(endDate);
        }

        return prisma.staffAttendance.findMany({
            where,
            orderBy: { date: 'desc' },
            include: {
                branch: { select: { id: true, name: true } },
            },
        });
    }

    /**
     * Get all staff attendance for a branch on a specific date.
     */
    static async getBranchAttendance(branchId, date) {
        const day = _startOfDay(date);

        const records = await prisma.staffAttendance.findMany({
            where: { branchId, date: day },
            include: {
                user: {
                    select: {
                        id: true, email: true, role: true,
                        doctor:     { select: { fullName: true } },
                        therapist:  { select: { fullName: true } },
                        pharmacist: { select: { fullName: true } },
                        patient:    { select: { fullName: true } },
                    },
                },
            },
            orderBy: { clockIn: 'asc' },
        });

        return records.map((r) => ({
            ...r,
            fullName: _extractFullName(r.user),
        }));
    }

    /**
     * Get attendance stats for a user over a date range.
     *
     * Counting rules (audit fix #10 + #12):
     *  - presentDays counts ONLY status==='PRESENT'. WFH stays in its own
     *    bucket; the previous "Present + WFH" sum disagreed with how
     *    getPunctualityReport and the UI presented those two states
     *    separately. The dashboard's "on-time" rate is computed by the
     *    caller via (presentDays + wfhDays) / scheduledDays.
     *  - avgLateMinutes filters by status==='LATE', not by lateMinutes>0.
     *    The old filter pulled in PRESENT records that happened to be
     *    inside the 10-minute grace, dragging the displayed average
     *    toward zero and making it inconsistent with the "Late: N" count.
     */
    static async getAttendanceStats(userId, { startDate, endDate }) {
        const where = { userId };
        if (startDate || endDate) {
            where.date = {};
            if (startDate) where.date.gte = new Date(startDate);
            if (endDate) where.date.lte = new Date(endDate);
        }

        const records = await prisma.staffAttendance.findMany({ where });

        const presentDays = records.filter((r) => r.status === 'PRESENT').length;
        const lateDays    = records.filter((r) => r.status === 'LATE').length;
        const absentDays  = records.filter((r) => r.status === 'ABSENT').length;
        const halfDays    = records.filter((r) => r.status === 'HALF_DAY').length;
        const leaveDays   = records.filter((r) => r.status === 'LEAVE').length;
        const wfhDays     = records.filter((r) => r.status === 'WFH').length;

        const lateRecords = records.filter((r) => r.status === 'LATE');
        const avgLateMinutes =
            lateRecords.length > 0
                ? lateRecords.reduce((sum, r) => sum + r.lateMinutes, 0) / lateRecords.length
                : 0;

        return {
            totalDays: records.length,
            presentDays,
            lateDays,
            absentDays,
            halfDays,
            leaveDays,
            wfhDays,
            avgLateMinutes: Math.round(avgLateMinutes * 10) / 10,
        };
    }

    /**
     * Get punctuality report for all staff in a branch.
     */
    static async getPunctualityReport(branchId, { startDate, endDate }) {
        const where = { branchId };
        if (startDate || endDate) {
            where.date = {};
            if (startDate) where.date.gte = new Date(startDate);
            if (endDate) where.date.lte = new Date(endDate);
        }

        const records = await prisma.staffAttendance.findMany({
            where,
            include: {
                user: {
                    select: {
                        id: true, email: true, role: true,
                        doctor:     { select: { fullName: true } },
                        therapist:  { select: { fullName: true } },
                        pharmacist: { select: { fullName: true } },
                        patient:    { select: { fullName: true } },
                    },
                },
            },
        });

        // Bucket counts must add up to totalDays — the previous version
        // bumped totalDays for HALF_DAY records but never tracked them in a
        // per-status counter, so the dashboard math silently lost rows.
        // Audit fix #11. WFH is its own bucket here too (consistent with
        // getAttendanceStats — audit fix #12).
        const grouped = {};
        for (const record of records) {
            const uid = record.userId;
            if (!grouped[uid]) {
                grouped[uid] = {
                    user: record.user,
                    fullName: _extractFullName(record.user),
                    totalDays: 0,
                    presentDays: 0,
                    lateDays: 0,
                    absentDays: 0,
                    halfDays: 0,
                    wfhDays: 0,
                    leaveDays: 0,
                    totalLateMinutes: 0,
                };
            }
            grouped[uid].totalDays++;
            if (record.status === 'PRESENT')  grouped[uid].presentDays++;
            if (record.status === 'LATE')     grouped[uid].lateDays++;
            if (record.status === 'ABSENT')   grouped[uid].absentDays++;
            if (record.status === 'HALF_DAY') grouped[uid].halfDays++;
            if (record.status === 'WFH')      grouped[uid].wfhDays++;
            if (record.status === 'LEAVE')    grouped[uid].leaveDays++;
            if (record.status === 'LATE') grouped[uid].totalLateMinutes += record.lateMinutes;
        }

        return Object.values(grouped).map((entry) => ({
            ...entry,
            avgLateMinutes:
                entry.lateDays > 0
                    ? Math.round((entry.totalLateMinutes / entry.lateDays) * 10) / 10
                    : 0,
            // On-time rate — present+WFH out of scheduled days
            // (excluding leave). LATE/HALF_DAY/ABSENT all count against
            // punctuality, which is the intent.
            punctualityRate: (() => {
                const scheduled = entry.totalDays - entry.leaveDays;
                const onTime = entry.presentDays + entry.wfhDays;
                return scheduled > 0
                    ? Math.round((onTime / scheduled) * 1000) / 10
                    : 0;
            })(),
        }));
    }

    /**
     * Reconcile attendance for a single date across a branch (or globally
     * when branchId is null). Runs nightly via the `attendance-reconcile`
     * cron, but also callable on-demand from the admin UI.
     *
     * For every user who *had a scheduled shift* and no attendance row yet:
     *  - LEAVE block covering the shift  → row with status=LEAVE
     *  - WFH block covering the shift    → row with status=WFH
     *  - otherwise                       → row with status=ABSENT
     *
     * For every user who clocked in but never clocked out, auto-close at
     * scheduledEnd and flag HALF_DAY if the resulting shift is short.
     */
    static async reconcileDay({ date, branchId = null }) {
        const day = _startOfDay(date);

        const staffWhere = {
            role: { in: ['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST', 'PHARMACIST'] },
            deletedAt: null,
        };
        if (branchId) staffWhere.branchId = branchId;

        const [staff, existingRows] = await Promise.all([
            prisma.user.findMany({
                where: staffWhere,
                select: {
                    id: true, branchId: true, role: true,
                    doctor:    { select: { id: true } },
                    therapist: { select: { id: true } },
                },
            }),
            prisma.staffAttendance.findMany({
                where: { date: day, ...(branchId ? { branchId } : {}) },
            }),
        ]);

        const existingByUser = new Map(existingRows.map((r) => [r.userId, r]));

        const results = { absent: 0, leave: 0, wfh: 0, autoClosed: 0, skipped: 0 };

        for (const user of staff) {
            const existing = existingByUser.get(user.id);

            // Case 1 — already has a row. Auto-close unclosed shifts.
            if (existing) {
                if (existing.clockIn && !existing.clockOut && existing.scheduledEnd) {
                    await _autoCloseShift(existing);
                    results.autoClosed++;
                }
                continue;
            }

            // Case 2 — no row yet. Decide leave/wfh/absent/skip.
            const schedule = await _resolveScheduledWindow(user.id, day, user.branchId);
            if (!schedule) {
                results.skipped++; // no scheduled shift — don't pollute attendance
                continue;
            }

            const blocks = await _getBlocksForDate(user.id, day);
            const leaveBlock = blocks.find((b) => (b.kind || '').toUpperCase() === 'LEAVE' && _isFullDay(b, schedule));
            const wfhBlock   = blocks.find((b) => (b.kind || '').toUpperCase() === 'WFH');

            let status = 'ABSENT';
            if (leaveBlock) status = 'LEAVE';
            else if (wfhBlock) status = 'WFH';

            await prisma.staffAttendance.create({
                data: {
                    userId: user.id,
                    branchId: user.branchId,
                    date: day,
                    scheduledStart: schedule.start,
                    scheduledEnd: schedule.end,
                    status,
                    lateMinutes: 0,
                    notes: status === 'ABSENT' ? 'Auto-reconciled — no clock-in recorded' : null,
                },
            });

            if (status === 'ABSENT') results.absent++;
            if (status === 'LEAVE')  results.leave++;
            if (status === 'WFH')    results.wfh++;
        }

        logger.info(`[Attendance] Reconciled ${day.toISOString().slice(0, 10)} branch=${branchId || 'ALL'} ` +
                    `absent=${results.absent} leave=${results.leave} wfh=${results.wfh} ` +
                    `autoClosed=${results.autoClosed} skipped=${results.skipped}`);
        return results;
    }

    /**
     * Cron entry point — reconciles every branch for the last
     * `BACKFILL_DAYS` days, starting with the most recent.
     *
     * Why a window instead of "just yesterday": if the cron is skipped for
     * any reason (Redis down, server crash, manual restart) and we only
     * ever reconcile yesterday, the missed days become permanent ghost
     * gaps — no clock-in row exists, so they never show up as ABSENT and
     * the punctuality stats silently under-count missed days. Audit fix
     * #15.
     *
     * `reconcileDay` is itself idempotent — it only creates rows for
     * users who don't already have one for that date, and only
     * auto-closes shifts that lack a clockOut. So re-running over already-
     * reconciled days is a no-op per row.
     */
    static BACKFILL_DAYS = 7;

    static async runNightlyReconciliation() {
        const aggregate = { absent: 0, leave: 0, wfh: 0, autoClosed: 0, skipped: 0, days: [] };
        for (let offset = 1; offset <= this.BACKFILL_DAYS; offset += 1) {
            const day = new Date();
            day.setDate(day.getDate() - offset);
            const r = await this.reconcileDay({ date: day, branchId: null });
            aggregate.absent     += r.absent;
            aggregate.leave      += r.leave;
            aggregate.wfh        += r.wfh;
            aggregate.autoClosed += r.autoClosed;
            aggregate.skipped    += r.skipped;
            aggregate.days.push({ date: _startOfDay(day).toISOString().slice(0, 10), ...r });
        }
        logger.info(`[Attendance] Nightly backfill — ${this.BACKFILL_DAYS} days · ` +
                    `absent=${aggregate.absent} leave=${aggregate.leave} wfh=${aggregate.wfh} ` +
                    `autoClosed=${aggregate.autoClosed} skipped=${aggregate.skipped}`);
        return aggregate;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

// All "what day / what time" maths is anchored to CLINIC_TZ_OFFSET so the
// service behaves identically on a UTC and an IST server. Previously these
// used Date.setHours() (local time) and silently coupled correctness to
// the server's TZ — audit fix #5 + #6.

/** Start of the given instant's clinic-local day, returned as a Date
 *  (which is a UTC instant). For an input of 2026-05-19 09:00 UTC the
 *  output is 2026-05-18 18:30 UTC (= 2026-05-19 00:00 IST). */
function _startOfDay(d) {
    const input = (d instanceof Date) ? d : new Date(d);
    // Convert the instant into clinic-local minutes-from-epoch, floor to
    // a whole day, then convert back. This is timezone-correct regardless
    // of server TZ because we use the explicit offset everywhere.
    const clinicMs   = input.getTime() + TZ_OFFSET_MIN * 60_000;
    const clinicDay  = Math.floor(clinicMs / 86_400_000) * 86_400_000;
    return new Date(clinicDay - TZ_OFFSET_MIN * 60_000);
}

/** HH:mm of `date` in the clinic timezone — e.g. an instant at 09:00 UTC
 *  reads as "14:30" in IST. Used to compute lateness against schedule
 *  strings that are themselves clinic-local. */
function _toHHmm(date) {
    const clinicMs = date.getTime() + TZ_OFFSET_MIN * 60_000;
    const h = Math.floor(clinicMs / 3_600_000) % 24;
    const m = Math.floor(clinicMs / 60_000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Combine a clinic-local YYYY-MM-DD (already a clinic-midnight Date from
 *  _startOfDay) with a clinic-local "HH:mm" and return the UTC instant. */
function _combineDateAndTime(day, hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    // `day` is the clinic-midnight Date. Add h:m worth of minutes in
    // clinic time, which is the same as adding them in UTC (offsets cancel).
    return new Date(day.getTime() + (h * 60 + m) * 60_000);
}

/** Day-of-week in the clinic timezone, 0 = Sunday … 6 = Saturday. */
function _dayOfWeekClinic(date) {
    const clinicMs = date.getTime() + TZ_OFFSET_MIN * 60_000;
    // The Unix epoch (1970-01-01 UTC) was a Thursday. Day = floor(days) mod 7
    // shifted so Sunday = 0. Compute the clinic-local weekday directly so
    // server TZ doesn't taint it.
    const days = Math.floor(clinicMs / 86_400_000);
    return (days + 4) % 7;   // +4 because 1970-01-01 was Thursday → day 4
}

function _diffMinutes(fromHHmm, toHHmm) {
    const [fh, fm] = fromHHmm.split(':').map(Number);
    const [th, tm] = toHHmm.split(':').map(Number);
    return (th * 60 + tm) - (fh * 60 + fm);
}

/**
 * Single source of truth for attendance status derivation. Called by
 * clockIn, clockOut, setAttendance, _autoCloseShift, and reconcileDay so
 * all five paths agree on what counts as PRESENT / LATE / HALF_DAY /
 * ABSENT / WFH / LEAVE. Audit fixes #1 + #3 + #10 + #11 + #12 — all
 * converge here.
 *
 * Inputs:
 *   schedule       — { start, end } HH:mm or null (off-day)
 *   clockIn        — Date or null
 *   clockOut       — Date or null (ignored unless clockIn is present)
 *   leaveBlock     — full-day LEAVE BlockedSlot covering the shift, or null
 *   wfhBlock       — any WFH BlockedSlot for the day, or null
 *
 * Returns { status, lateMinutes }.
 */
function _deriveStatus({ schedule, clockIn, clockOut, leaveBlock, wfhBlock }) {
    // 1. Leave wins outright.
    if (leaveBlock) return { status: 'LEAVE', lateMinutes: 0 };

    // 2. No clock-in: WFH if there's a block, else ABSENT (only meaningful
    // when the user was actually scheduled).
    if (!clockIn) {
        if (wfhBlock) return { status: 'WFH', lateMinutes: 0 };
        return { status: 'ABSENT', lateMinutes: 0 };
    }

    // 3. WFH trumps the schedule comparison — remote hours are trusted.
    if (wfhBlock) return { status: 'WFH', lateMinutes: 0 };

    // 4. Compute lateness in minutes (negative diffs clamp to 0 — early
    //    arrival isn't penalised).
    let lateMinutes = 0;
    if (schedule?.start) {
        lateMinutes = Math.max(0, _diffMinutes(schedule.start, _toHHmm(clockIn)));
    }

    // 5. No clock-out yet — provisional status.
    if (!clockOut) {
        const status = lateMinutes > StaffAttendanceService.LATE_GRACE_MINUTES ? 'LATE' : 'PRESENT';
        return { status, lateMinutes };
    }

    // 6. Clock-out present — worked-time gating runs the show.
    const workedMin = Math.max(0, Math.round((clockOut.getTime() - clockIn.getTime()) / 60_000));
    if (workedMin < StaffAttendanceService.MIN_WORKED_MIN_FOR_HALFDAY) {
        // Token clock-in/out — visible in screenshot as "Clocked out · worked 0m
        // · HALF DAY". Downgrade to ABSENT so the dashboard tells the truth.
        return { status: 'ABSENT', lateMinutes };
    }
    if (workedMin < StaffAttendanceService.HALF_DAY_THRESHOLD_MIN) {
        return { status: 'HALF_DAY', lateMinutes };
    }
    // Full shift — late vs on-time decides the label.
    const status = lateMinutes > StaffAttendanceService.LATE_GRACE_MINUTES ? 'LATE' : 'PRESENT';
    return { status, lateMinutes };
}

/** Pick the clinical display name from whichever role profile is populated. */
function _extractFullName(user) {
    if (!user) return null;
    return user.doctor?.fullName
        ?? user.therapist?.fullName
        ?? user.pharmacist?.fullName
        ?? user.patient?.fullName
        ?? user.email
        ?? null;
}

/**
 * Resolve a clinician's scheduled shift for the given day.
 *
 *  - Therapist: pick the Availability row for that weekday if one exists.
 *  - Doctor / Admin_doctor / Pharmacist: fall back to branch operating
 *    hours (when the branch is open that day). Doctors don't have their
 *    own recurring schedule table yet, but branch hours are the canonical
 *    planned window.
 *
 * Returns { start, end } as HH:mm strings, or null when the user has no
 * scheduled work (therapist off-day, or no branch association).
 */
async function _resolveScheduledWindow(userId, date, branchIdHint = null) {
    const dayOfWeek = _dayOfWeekClinic(date);

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true, role: true, branchId: true,
            therapist: { select: { id: true, availability: { where: { dayOfWeek } } } },
            doctor:    { select: { id: true } },
        },
    });
    if (!user) return null;

    // Therapist — prefer their declared Availability for the weekday.
    if (user.therapist?.availability?.length) {
        const slots = user.therapist.availability.filter((a) => a.isApproved !== false);
        if (slots.length) {
            const start = slots.map((s) => s.startTime).sort()[0];
            const end   = slots.map((s) => s.endTime).sort().slice(-1)[0];
            return { start, end };
        }
    }
    // Therapist with no availability row for this weekday → off day.
    if (user.role === 'THERAPIST') return null;

    // Doctor / pharmacist / admin — use branch operating hours.
    const branchId = user.branchId || branchIdHint;
    if (!branchId) return null;
    const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        select: {
            operatingHoursFrom: true, operatingHoursTo: true,
            isActive: true, weeklyClosedDays: true,
        },
    });
    if (!branch?.isActive) return null;

    // Skip days the branch is marked closed (audit-fix: Sunday-as-scheduled).
    // Empty array means open every day; Sunday-closed clinics add `0` to
    // the array via admin tooling. Per-branch — Sunday CAN still be a
    // working day for clinics that choose so.
    if (Array.isArray(branch.weeklyClosedDays) && branch.weeklyClosedDays.includes(dayOfWeek)) {
        return null;
    }

    return {
        start: branch.operatingHoursFrom || StaffAttendanceService.DEFAULT_SHIFT_START,
        end:   branch.operatingHoursTo   || StaffAttendanceService.DEFAULT_SHIFT_END,
    };
}

async function _getBlocksForDate(userId, date) {
    const dayOfWeek = date.getDay();
    const [doctor, therapist] = await Promise.all([
        prisma.doctor.findUnique({    where: { userId }, select: { id: true } }),
        prisma.therapist.findUnique({ where: { userId }, select: { id: true } }),
    ]);
    const clinicianIds = [doctor?.id, therapist?.id].filter(Boolean);
    if (clinicianIds.length === 0) return [];

    const dayStart = _startOfDay(date);
    const dayEnd   = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    return prisma.blockedSlot.findMany({
        where: {
            OR: [
                { doctorId:    { in: clinicianIds } },
                { therapistId: { in: clinicianIds } },
            ],
            AND: [
                {
                    OR: [
                        { date: { gte: dayStart, lt: dayEnd } },
                        { dayOfWeek, date: null },
                    ],
                },
            ],
        },
    });
}

/** A block qualifies as "full-day" when it covers the entire scheduled
 *  shift. Date-only BlockedSlots have null startTime/endTime and ARE
 *  full-day by definition — the previous string-comparison treated
 *  `null <= "09:00"` as false and misclassified them. Audit fix #4. */
function _isFullDay(block, schedule) {
    if (!schedule) return false;
    if (block.startTime == null && block.endTime == null) return true;
    if (block.startTime == null || block.endTime == null) return false;
    return block.startTime <= schedule.start && block.endTime >= schedule.end;
}

async function _autoCloseShift(row) {
    // Close at scheduledEnd (interpreted on the attendance date in clinic
    // time), then route through _deriveStatus so the auto-closed row
    // follows the exact same rules as a self-service clock-out.
    const closeAt = _combineDateAndTime(row.date, row.scheduledEnd);

    let status, lateMinutes;
    if (row.status === 'LEAVE' || row.status === 'WFH') {
        status = row.status;
        lateMinutes = row.lateMinutes;
    } else {
        const schedule = row.scheduledStart
            ? { start: row.scheduledStart, end: row.scheduledEnd }
            : null;
        ({ status, lateMinutes } = _deriveStatus({
            schedule, clockIn: row.clockIn, clockOut: closeAt, leaveBlock: null, wfhBlock: null,
        }));
    }

    await prisma.staffAttendance.update({
        where: { id: row.id },
        data:  {
            clockOut: closeAt,
            status,
            lateMinutes,
            notes: (row.notes ? row.notes + ' | ' : '') + 'Auto-closed at scheduled end',
        },
    });
}
