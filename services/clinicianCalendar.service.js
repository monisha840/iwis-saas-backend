import prisma from '../lib/prisma.js';

/**
 * ClinicianCalendarService — unified per-day view combining:
 *   1. Declared availability windows (Therapist.Availability + branch hours)
 *   2. Blocked slots (LEAVE / WFH / OFF / OTHER)
 *   3. Attendance status (PRESENT / LATE / WFH / ...)
 *   4. Appointment workload (count + morning/afternoon/evening distribution)
 *
 * The calendar UI renders exactly one row per date and relies on this
 * service to pre-compute everything it needs; the old attendance calendar
 * was making a separate request per concern.
 */
export class ClinicianCalendarService {
    /**
     * Per-day breakdown for a single clinician over a month window.
     */
    static async getClinicianCalendar({ userId, year, month }) {
        const { monthStart, monthEnd } = _monthBounds(year, month);

        const [user, doctor, therapist] = await Promise.all([
            prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true, role: true, branchId: true, email: true,
                    doctor:    { select: { id: true, fullName: true } },
                    therapist: { select: {
                        id: true, fullName: true,
                        availability: { where: { isApproved: true } },
                    } },
                },
            }),
            prisma.doctor.findUnique({    where: { userId }, select: { id: true } }),
            prisma.therapist.findUnique({ where: { userId }, select: { id: true } }),
        ]);
        if (!user) throw new Error('User not found');

        const clinicianIds = [doctor?.id, therapist?.id].filter(Boolean);

        const [branch, blocks, appointments, attendance] = await Promise.all([
            user.branchId
                ? prisma.branch.findUnique({
                    where: { id: user.branchId },
                    select: { name: true, operatingHoursFrom: true, operatingHoursTo: true, isActive: true },
                })
                : null,
            clinicianIds.length
                ? prisma.blockedSlot.findMany({
                    where: {
                        AND: [
                            {
                                OR: [
                                    { doctorId:    { in: clinicianIds } },
                                    { therapistId: { in: clinicianIds } },
                                ],
                            },
                            {
                                OR: [
                                    { date: { gte: monthStart, lte: monthEnd } },
                                    { date: null },
                                ],
                            },
                        ],
                    },
                })
                : [],
            clinicianIds.length
                ? prisma.appointment.findMany({
                    where: {
                        OR: [
                            { doctorId:    { in: clinicianIds } },
                            { therapistId: { in: clinicianIds } },
                        ],
                        date: { gte: monthStart, lte: monthEnd },
                        status: { notIn: ['CANCELLED', 'REJECTED'] },
                    },
                    select: { id: true, date: true, status: true, consultationMode: true },
                })
                : [],
            prisma.staffAttendance.findMany({
                where: {
                    userId,
                    date: { gte: monthStart, lte: monthEnd },
                },
                select: {
                    date: true, status: true, clockIn: true, clockOut: true, lateMinutes: true,
                    scheduledStart: true, scheduledEnd: true,
                },
            }),
        ]);

        const byDateAppt = _bucketByDate(appointments, (a) => a.date);
        const byDateAttn = new Map(attendance.map((r) => [_dateKey(r.date), r]));

        const availabilityByDow = _availabilityByDow(user.therapist?.availability || []);

        const days = [];
        for (let cursor = new Date(monthStart); cursor <= monthEnd; cursor.setDate(cursor.getDate() + 1)) {
            const day = new Date(cursor);
            const key = _dateKey(day);
            const dow = day.getDay();

            const dayBlocks = blocks.filter((b) => {
                if (b.date) return _dateKey(b.date) === key;
                return b.dayOfWeek === dow;
            });

            const leaveBlock = dayBlocks.find((b) => (b.kind || '').toUpperCase() === 'LEAVE');
            const wfhBlock   = dayBlocks.find((b) => (b.kind || '').toUpperCase() === 'WFH');

            const dayAppts = byDateAppt.get(key) || [];
            const distribution = _distributionBuckets(dayAppts);

            const schedule = _resolveScheduleForDay({
                role: user.role, dow, availabilityByDow, branch,
            });

            const attendanceRow = byDateAttn.get(key) || null;

            days.push({
                date: key,
                dayOfWeek: dow,
                schedule,
                hasSchedule: Boolean(schedule),
                blocks: dayBlocks.map((b) => ({
                    id: b.id, kind: b.kind || 'OTHER',
                    startTime: b.startTime, endTime: b.endTime,
                    reason: b.reason || null,
                    recurring: !b.date,
                })),
                leaveToday: Boolean(leaveBlock),
                wfhToday:   Boolean(wfhBlock),
                attendance: attendanceRow ? {
                    status: attendanceRow.status,
                    clockIn: attendanceRow.clockIn,
                    clockOut: attendanceRow.clockOut,
                    lateMinutes: attendanceRow.lateMinutes,
                } : null,
                appointments: {
                    total: dayAppts.length,
                    morning:   distribution.morning,
                    afternoon: distribution.afternoon,
                    evening:   distribution.evening,
                    online:    dayAppts.filter((a) => a.consultationMode === 'ONLINE').length,
                },
            });
        }

        return {
            clinician: {
                userId: user.id,
                role: user.role,
                fullName: user.doctor?.fullName || user.therapist?.fullName || user.email,
                branchName: branch?.name || null,
            },
            range: { from: _dateKey(monthStart), to: _dateKey(monthEnd) },
            days,
        };
    }

    /**
     * Branch-wide workload heatmap for a month.
     *
     * Returns one entry per (clinician, day) so the admin UI can render
     * a matrix: rows = clinicians, cols = dates, cell = appointment count +
     * attendance status dot + leave/WFH overlay.
     */
    static async getBranchCalendar({ branchId, year, month }) {
        const { monthStart, monthEnd } = _monthBounds(year, month);

        const staff = await prisma.user.findMany({
            where: {
                branchId,
                role: { in: ['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST'] },
                deletedAt: null,
            },
            select: {
                id: true, role: true, email: true,
                doctor:    { select: { id: true, fullName: true } },
                therapist: { select: { id: true, fullName: true } },
            },
        });

        const clinicianIdToUser = new Map();
        for (const u of staff) {
            if (u.doctor?.id)    clinicianIdToUser.set(u.doctor.id,    u.id);
            if (u.therapist?.id) clinicianIdToUser.set(u.therapist.id, u.id);
        }
        const allClinicianIds = Array.from(clinicianIdToUser.keys());

        const [appointments, blocks, attendance] = await Promise.all([
            allClinicianIds.length
                ? prisma.appointment.findMany({
                    where: {
                        OR: [
                            { doctorId:    { in: allClinicianIds } },
                            { therapistId: { in: allClinicianIds } },
                        ],
                        date: { gte: monthStart, lte: monthEnd },
                        status: { notIn: ['CANCELLED', 'REJECTED'] },
                    },
                    select: { doctorId: true, therapistId: true, date: true },
                })
                : [],
            allClinicianIds.length
                ? prisma.blockedSlot.findMany({
                    where: {
                        kind: { in: ['LEAVE', 'WFH'] },
                        AND: [
                            {
                                OR: [
                                    { doctorId:    { in: allClinicianIds } },
                                    { therapistId: { in: allClinicianIds } },
                                ],
                            },
                            {
                                OR: [
                                    { date: { gte: monthStart, lte: monthEnd } },
                                    { date: null },
                                ],
                            },
                        ],
                    },
                    select: {
                        doctorId: true, therapistId: true, date: true,
                        dayOfWeek: true, kind: true,
                    },
                })
                : [],
            prisma.staffAttendance.findMany({
                where: {
                    branchId,
                    date: { gte: monthStart, lte: monthEnd },
                },
                select: { userId: true, date: true, status: true, lateMinutes: true },
            }),
        ]);

        const attnByUserDate = new Map(
            attendance.map((r) => [`${r.userId}|${_dateKey(r.date)}`, r])
        );

        const rows = staff.map((u) => {
            const clinicianIds = [u.doctor?.id, u.therapist?.id].filter(Boolean);
            const days = [];
            for (let cursor = new Date(monthStart); cursor <= monthEnd; cursor.setDate(cursor.getDate() + 1)) {
                const day = new Date(cursor);
                const key = _dateKey(day);
                const dow = day.getDay();

                const dayAppts = appointments.filter((a) => {
                    const sameDay = _dateKey(a.date) === key;
                    const sameClin = clinicianIds.includes(a.doctorId) || clinicianIds.includes(a.therapistId);
                    return sameDay && sameClin;
                });

                const dayBlocks = blocks.filter((b) => {
                    const owned = clinicianIds.includes(b.doctorId) || clinicianIds.includes(b.therapistId);
                    if (!owned) return false;
                    if (b.date) return _dateKey(b.date) === key;
                    return b.dayOfWeek === dow;
                });
                const leaveToday = dayBlocks.some((b) => b.kind === 'LEAVE');
                const wfhToday   = dayBlocks.some((b) => b.kind === 'WFH');

                const attn = attnByUserDate.get(`${u.id}|${key}`) || null;

                days.push({
                    date: key,
                    appointments: dayAppts.length,
                    leaveToday,
                    wfhToday,
                    attendanceStatus: attn?.status || null,
                    lateMinutes: attn?.lateMinutes || 0,
                });
            }
            return {
                userId: u.id,
                role: u.role,
                fullName: u.doctor?.fullName || u.therapist?.fullName || u.email,
                days,
            };
        });

        return {
            range: { from: _dateKey(monthStart), to: _dateKey(monthEnd) },
            rows,
        };
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function _monthBounds(year, month) {
    // `month` is 1-based from the API; convert to JS 0-based internally.
    const m = Math.max(1, Math.min(12, Number(month))) - 1;
    const y = Number(year);
    const monthStart = new Date(y, m, 1);
    monthStart.setHours(0, 0, 0, 0);
    const monthEnd = new Date(y, m + 1, 0);
    monthEnd.setHours(23, 59, 59, 999);
    return { monthStart, monthEnd };
}

function _dateKey(d) {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function _bucketByDate(items, getDate) {
    const out = new Map();
    for (const it of items) {
        const k = _dateKey(getDate(it));
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(it);
    }
    return out;
}

function _distributionBuckets(appts) {
    const buckets = { morning: 0, afternoon: 0, evening: 0 };
    for (const a of appts) {
        const hour = new Date(a.date).getHours();
        if (hour < 12) buckets.morning++;
        else if (hour < 17) buckets.afternoon++;
        else buckets.evening++;
    }
    return buckets;
}

function _availabilityByDow(availability) {
    const out = new Map();
    for (const a of availability) {
        if (!out.has(a.dayOfWeek)) out.set(a.dayOfWeek, []);
        out.get(a.dayOfWeek).push(a);
    }
    return out;
}

function _resolveScheduleForDay({ role, dow, availabilityByDow, branch }) {
    const slots = availabilityByDow.get(dow);
    if (slots?.length) {
        return {
            start: slots.map((s) => s.startTime).sort()[0],
            end:   slots.map((s) => s.endTime).sort().slice(-1)[0],
            source: 'DECLARED',
        };
    }
    if (role === 'THERAPIST') return null;
    if (!branch?.isActive) return null;
    return {
        start: branch.operatingHoursFrom || '09:00',
        end:   branch.operatingHoursTo   || '18:00',
        source: 'BRANCH_HOURS',
    };
}
