import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * StaffAttendanceService — clock in/out, attendance history, punctuality
 * reporting, and daily reconciliation against the clinician's declared
 * schedule.
 *
 * Status derivation rules (single source of truth, reused by clockIn,
 * clockOut, and the nightly reconcileDay job):
 *
 *  - LEAVE   : a full-day BlockedSlot with kind='LEAVE'  covers the shift.
 *  - WFH     : a BlockedSlot with kind='WFH' covers any part of the shift.
 *              Clock-in is still allowed (and recommended) but not required.
 *  - PRESENT : clocked in on or before scheduledStart.
 *  - LATE    : clocked in after scheduledStart + LATE_GRACE_MINUTES.
 *              `lateMinutes` is set to (clockIn - scheduledStart).
 *  - HALF_DAY: clocked out with total worked time < HALF_DAY_THRESHOLD_MIN.
 *  - ABSENT  : no clock-in by end-of-day AND no leave/WFH block AND the
 *              clinician had a scheduled shift that day.
 *
 * Clinicians with no declared schedule for the day (therapist Availability
 * is empty AND the branch is closed) are skipped — no attendance row is
 * created, so "off day" doesn't pollute punctuality stats.
 */
export class StaffAttendanceService {
    static LATE_GRACE_MINUTES = 10;
    static HALF_DAY_THRESHOLD_MIN = 240; // 4 hours
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

        const scheduledStart = schedule?.start || null;
        const scheduledEnd   = schedule?.end   || null;

        let status = 'PRESENT';
        let lateMinutes = 0;

        if (wfhBlock) {
            status = 'WFH';
        } else if (scheduledStart) {
            const clockInHHmm = _toHHmm(now);
            lateMinutes = Math.max(0, _diffMinutes(scheduledStart, clockInHHmm));
            status = lateMinutes > this.LATE_GRACE_MINUTES ? 'LATE' : 'PRESENT';
        }

        const record = await prisma.staffAttendance.upsert({
            where:  { userId_date: { userId, date: today } },
            create: {
                userId,
                branchId,
                date: today,
                scheduledStart,
                scheduledEnd,
                clockIn: now,
                status,
                lateMinutes,
            },
            update: {
                clockIn: now,
                branchId,
                scheduledStart,
                scheduledEnd,
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

        const workedMin = Math.max(0, Math.round((now.getTime() - existing.clockIn.getTime()) / 60000));

        let status = existing.status;
        if (status !== 'LEAVE' && status !== 'WFH' && workedMin < this.HALF_DAY_THRESHOLD_MIN) {
            status = 'HALF_DAY';
        }

        const record = await prisma.staffAttendance.update({
            where: { userId_date: { userId, date: today } },
            data:  { clockOut: now, status },
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

        // Derive the status when the admin didn't force one.
        let derivedStatus = 'ABSENT';
        let lateMinutes = 0;

        const leaveBlock = blocks.find((b) => (b.kind || '').toUpperCase() === 'LEAVE' && _isFullDay(b, schedule));
        const wfhBlock   = blocks.find((b) => (b.kind || '').toUpperCase() === 'WFH');

        if (clockInDate) {
            if (wfhBlock) {
                derivedStatus = 'WFH';
            } else if (schedule?.start) {
                lateMinutes = Math.max(0, _diffMinutes(schedule.start, _toHHmm(clockInDate)));
                derivedStatus = lateMinutes > this.LATE_GRACE_MINUTES ? 'LATE' : 'PRESENT';
            } else {
                derivedStatus = 'PRESENT';
            }

            if (clockOutDate && derivedStatus !== 'WFH') {
                const worked = Math.round((clockOutDate.getTime() - clockInDate.getTime()) / 60000);
                if (worked < this.HALF_DAY_THRESHOLD_MIN) derivedStatus = 'HALF_DAY';
            }
        } else if (leaveBlock) {
            derivedStatus = 'LEAVE';
        } else if (wfhBlock) {
            derivedStatus = 'WFH';
        }

        const finalStatus = status || derivedStatus;
        const auditLine = `Edited by ${actorEmail || actorId} at ${new Date().toISOString()}`;
        const finalNotes = notes
            ? `${notes} | ${auditLine}`
            : auditLine;

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
     */
    static async deleteAttendance({ actorId, targetUserId, date }) {
        const day = _startOfDay(date);
        await prisma.staffAttendance.delete({
            where: { userId_date: { userId: targetUserId, date: day } },
        });
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
     * WFH counts toward presentDays so remote work doesn't tank the KPI.
     */
    static async getAttendanceStats(userId, { startDate, endDate }) {
        const where = { userId };
        if (startDate || endDate) {
            where.date = {};
            if (startDate) where.date.gte = new Date(startDate);
            if (endDate) where.date.lte = new Date(endDate);
        }

        const records = await prisma.staffAttendance.findMany({ where });

        const presentDays = records.filter((r) => r.status === 'PRESENT' || r.status === 'WFH').length;
        const lateDays    = records.filter((r) => r.status === 'LATE').length;
        const absentDays  = records.filter((r) => r.status === 'ABSENT').length;
        const halfDays    = records.filter((r) => r.status === 'HALF_DAY').length;
        const leaveDays   = records.filter((r) => r.status === 'LEAVE').length;
        const wfhDays     = records.filter((r) => r.status === 'WFH').length;

        const lateRecords = records.filter((r) => r.lateMinutes > 0);
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
                    wfhDays: 0,
                    leaveDays: 0,
                    totalLateMinutes: 0,
                };
            }
            grouped[uid].totalDays++;
            if (record.status === 'PRESENT') grouped[uid].presentDays++;
            if (record.status === 'LATE')    grouped[uid].lateDays++;
            if (record.status === 'ABSENT')  grouped[uid].absentDays++;
            if (record.status === 'WFH')     grouped[uid].wfhDays++;
            if (record.status === 'LEAVE')   grouped[uid].leaveDays++;
            grouped[uid].totalLateMinutes += record.lateMinutes;
        }

        return Object.values(grouped).map((entry) => ({
            ...entry,
            avgLateMinutes:
                entry.lateDays > 0
                    ? Math.round((entry.totalLateMinutes / entry.lateDays) * 10) / 10
                    : 0,
            // On-time rate — present+WFH out of scheduled days (excluding leave).
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
     * Cron entry point — reconciles yesterday across every branch.
     * Yesterday (not today) so the full shift window has passed.
     */
    static async runNightlyReconciliation() {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        return this.reconcileDay({ date: yesterday, branchId: null });
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function _startOfDay(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    return out;
}

function _toHHmm(date) {
    return date.toTimeString().slice(0, 5);
}

function _combineDateAndTime(day, hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const out = new Date(day);
    out.setHours(h, m, 0, 0);
    return out;
}

function _diffMinutes(fromHHmm, toHHmm) {
    const [fh, fm] = fromHHmm.split(':').map(Number);
    const [th, tm] = toHHmm.split(':').map(Number);
    return (th * 60 + tm) - (fh * 60 + fm);
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
    const dayOfWeek = date.getDay();

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
        select: { operatingHoursFrom: true, operatingHoursTo: true, isActive: true },
    });
    if (!branch?.isActive) return null;

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

/** A block qualifies as "full-day" when it covers the entire scheduled shift. */
function _isFullDay(block, schedule) {
    if (!schedule) return false;
    return block.startTime <= schedule.start && block.endTime >= schedule.end;
}

async function _autoCloseShift(row) {
    // Close at scheduledEnd (interpreted on the attendance date), and
    // downgrade to HALF_DAY if total worked < threshold.
    const [h, m] = row.scheduledEnd.split(':').map(Number);
    const closeAt = new Date(row.date);
    closeAt.setHours(h, m, 0, 0);

    const workedMin = Math.max(0, Math.round((closeAt.getTime() - row.clockIn.getTime()) / 60000));
    let status = row.status;
    if (status !== 'LEAVE' && status !== 'WFH' && workedMin < StaffAttendanceService.HALF_DAY_THRESHOLD_MIN) {
        status = 'HALF_DAY';
    }

    await prisma.staffAttendance.update({
        where: { id: row.id },
        data:  { clockOut: closeAt, status, notes: (row.notes ? row.notes + ' | ' : '') + 'Auto-closed at scheduled end' },
    });
}
