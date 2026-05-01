import prisma from '../lib/prisma.js';

/**
 * Group Therapy Session scheduling (IWIS competitor feature 6)
 * One therapist + optional room, many patients. Each patient enrolment is still a
 * first-class Appointment row (sharing the same groupSessionId) so existing billing,
 * notifications, and feedback pipelines work unchanged.
 */
export class GroupSessionService {
    static async create(data) {
        return prisma.groupSession.create({ data });
    }

    static async list({ branchId, hospitalId, date, therapistId } = {}) {
        const where = { ...(therapistId ? { therapistId } : {}) };
        if (branchId) where.branchId = branchId;
        else if (hospitalId) where.branch = { hospitalId };
        if (date) {
            const start = new Date(date); start.setHours(0,0,0,0);
            const end   = new Date(date); end.setHours(23,59,59,999);
            where.date = { gte: start, lte: end };
        }
        const sessions = await prisma.groupSession.findMany({
            where,
            include: {
                therapist: { select: { fullName: true } },
                room: { select: { id: true, name: true, type: true } },
                branch: { select: { id: true, name: true } },
                _count: { select: { appointments: true } },
            },
            orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
        });
        return sessions.map((s) => ({
            ...s,
            spotsLeft: Math.max(0, s.maxCapacity - s._count.appointments),
        }));
    }

    /**
     * Join creates a per-patient Appointment linked to the groupSessionId. All billing,
     * reminders, and visit summary logic stays the same — the existing appointment flow
     * just happens to fire for N patients sharing one therapist time slot.
     */
    static async join({ groupSessionId, patientId }) {
        return prisma.$transaction(async (tx) => {
            const session = await tx.groupSession.findUnique({
                where: { id: groupSessionId },
                include: { _count: { select: { appointments: true } } },
            });
            if (!session) throw Object.assign(new Error('Session not found'), { status: 404 });
            if (session.status !== 'OPEN') throw Object.assign(new Error('Session is not accepting enrolments'), { status: 400 });
            if (session._count.appointments >= session.maxCapacity) {
                await tx.groupSession.update({ where: { id: groupSessionId }, data: { status: 'FULL' } });
                throw Object.assign(new Error('Session is full'), { status: 409 });
            }

            // Prevent double-enrolment for the same patient
            const existing = await tx.appointment.findFirst({ where: { groupSessionId, patientId } });
            if (existing) throw Object.assign(new Error('Already enrolled in this session'), { status: 409 });

            const apptDate = new Date(session.date);
            const [h, m] = session.startTime.split(':').map(Number);
            apptDate.setHours(h || 0, m || 0, 0, 0);

            const appointment = await tx.appointment.create({
                data: {
                    patientId,
                    therapistId: session.therapistId,
                    branchId: session.branchId,
                    therapyRoomId: session.roomId,
                    groupSessionId,
                    isGroupBooking: true,
                    consultationType: 'THERAPIST',
                    consultationMode: 'OFFLINE',
                    date: apptDate,
                    status: 'CONFIRMED',
                    therapistApproved: true,
                }
            });

            // Flip to FULL if we just filled the last seat. Re-count from the DB
            // inside the tx so concurrent joins don't each see the same stale
            // snapshot and collectively overfill.
            const countAfter = await tx.appointment.count({ where: { groupSessionId: session.id } });
            if (countAfter >= session.maxCapacity) {
                await tx.groupSession.update({ where: { id: groupSessionId }, data: { status: 'FULL' } });
            }
            return appointment;
        });
    }

    static async complete(groupSessionId) {
        return prisma.$transaction(async (tx) => {
            await tx.appointment.updateMany({ where: { groupSessionId }, data: { status: 'COMPLETED' } });
            return tx.groupSession.update({ where: { id: groupSessionId }, data: { status: 'COMPLETED' } });
        });
    }

    static async cancel(groupSessionId) {
        return prisma.$transaction(async (tx) => {
            await tx.appointment.updateMany({ where: { groupSessionId }, data: { status: 'CANCELLED' } });
            return tx.groupSession.update({ where: { id: groupSessionId }, data: { status: 'CANCELLED' } });
        });
    }

    static async getRoster(groupSessionId) {
        const session = await prisma.groupSession.findUnique({
            where: { id: groupSessionId },
            include: {
                therapist: { select: { fullName: true } },
                room: true,
                appointments: {
                    include: {
                        // `patientId` is the human-readable identifier (e.g.
                        // "JOHN@123"); `id` is the UUID used for joins. The
                        // dashboard roster modal needs both — the UUID to key
                        // rows / link to profiles, and the readable string to
                        // display next to the patient's name.
                        patient: { select: { id: true, fullName: true, patientId: true, phoneNumber: true } },
                    },
                },
            },
        });
        return session;
    }
}
