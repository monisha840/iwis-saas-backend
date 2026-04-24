import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';

// Maps each preset interval to its day offset. CUSTOM uses the daysOffset
// supplied in the request body; SINGLE_VISIT has no due date at all.
const INTERVAL_DAYS = {
    SEVEN_DAYS: 7,
    FOURTEEN_DAYS: 14,
    THIRTY_DAYS: 30,
    SIXTY_DAYS: 60,
    NINETY_DAYS: 90,
};

export const FOLLOWUP_INTERVALS = Object.freeze([
    'SEVEN_DAYS',
    'FOURTEEN_DAYS',
    'THIRTY_DAYS',
    'SIXTY_DAYS',
    'NINETY_DAYS',
    'CUSTOM',
    'SINGLE_VISIT',
]);

/**
 * Normalise follow-up payload into the shape Prisma expects, validating
 * that a CUSTOM interval supplies a positive daysOffset and that a
 * SINGLE_VISIT has no dueDate / daysOffset set.
 */
export function normaliseFollowUpPayload(raw, consultationDate) {
    if (!raw || typeof raw !== 'object') {
        const err = new Error('Follow-up decision is required when completing a consultation');
        err.status = 400;
        throw err;
    }
    const { interval, daysOffset, notes } = raw;

    if (!FOLLOWUP_INTERVALS.includes(interval)) {
        const err = new Error(`Invalid follow-up interval: ${interval}`);
        err.status = 400;
        throw err;
    }

    const baseDate = consultationDate instanceof Date ? consultationDate : new Date(consultationDate || Date.now());
    if (Number.isNaN(baseDate.getTime())) {
        const err = new Error('Invalid consultation date when computing follow-up due date');
        err.status = 400;
        throw err;
    }

    if (interval === 'SINGLE_VISIT') {
        return {
            interval,
            daysOffset: null,
            dueDate: null,
            isSingleVisit: true,
            notes: notes || null,
        };
    }

    let offset;
    if (interval === 'CUSTOM') {
        const parsed = parseInt(daysOffset, 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) {
            const err = new Error('CUSTOM follow-up requires daysOffset between 1 and 365');
            err.status = 400;
            throw err;
        }
        offset = parsed;
    } else {
        offset = INTERVAL_DAYS[interval];
    }

    const dueDate = new Date(baseDate.getTime() + offset * 24 * 60 * 60 * 1000);

    return {
        interval,
        daysOffset: offset,
        dueDate,
        isSingleVisit: false,
        notes: notes || null,
    };
}

export class FollowUpService {
    /**
     * Upsert the follow-up row bound to an appointment. Called from inside
     * the transaction that flips appointment.status to COMPLETED so the
     * two writes are atomic.
     */
    static async upsertForAppointment(tx, { appointment, user, payload }) {
        const normalised = normaliseFollowUpPayload(payload, appointment.date);
        const data = {
            ...normalised,
            createdById: user.id,
        };
        return tx.appointmentFollowUp.upsert({
            where: { appointmentId: appointment.id },
            create: {
                appointmentId: appointment.id,
                patientId: appointment.patientId,
                ...data,
            },
            update: data,
        });
    }

    /**
     * Returns the follow-up for one appointment, or null if missing.
     */
    static async getForAppointment(appointmentId) {
        return prisma.appointmentFollowUp.findUnique({
            where: { appointmentId },
            include: {
                createdBy: { select: { id: true, email: true, doctor: { select: { fullName: true } }, therapist: { select: { fullName: true } } } },
            },
        });
    }

    /**
     * Lists follow-ups for one patient (by Patient.id), most recent first.
     */
    static async listForPatient(patientId, { status } = {}) {
        return prisma.appointmentFollowUp.findMany({
            where: {
                patientId,
                ...(status && { status }),
            },
            orderBy: { createdAt: 'desc' },
            include: {
                appointment: { select: { id: true, date: true, consultationType: true, consultationMode: true } },
            },
            take: 50,
        });
    }

    /**
     * Cron sweep: any PENDING follow-up whose dueDate is in the past and
     * the patient has NOT had a subsequent COMPLETED appointment since
     * the original consultation is flipped to MISSED. Patients are
     * notified once (via missedNotifiedAt dedup guard).
     */
    static async detectMissedFollowUps() {
        const now = new Date();
        const pending = await prisma.appointmentFollowUp.findMany({
            where: {
                status: 'PENDING',
                isSingleVisit: false,
                dueDate: { lt: now },
            },
            include: {
                appointment: { select: { id: true, date: true } },
                patient: { select: { id: true, userId: true, fullName: true } },
            },
            take: 500,
        });

        let flipped = 0;
        for (const fu of pending) {
            // Has the patient had a COMPLETED appointment after the
            // original consultation? If so, mark this follow-up as
            // COMPLETED retroactively.
            const fulfilling = await prisma.appointment.findFirst({
                where: {
                    patientId: fu.patientId,
                    status: 'COMPLETED',
                    date: { gt: fu.appointment.date },
                },
                orderBy: { date: 'asc' },
                select: { id: true },
            });

            if (fulfilling) {
                await prisma.appointmentFollowUp.update({
                    where: { id: fu.id },
                    data: { status: 'COMPLETED', completedByAppointmentId: fulfilling.id },
                });
                continue;
            }

            // CAS-style update so concurrent runs can't double-flip / double-notify.
            const res = await prisma.appointmentFollowUp.updateMany({
                where: { id: fu.id, status: 'PENDING', missedNotifiedAt: null },
                data: { status: 'MISSED', missedNotifiedAt: now },
            });
            if (res.count === 0) continue;

            if (fu.patient?.userId) {
                try {
                    await notificationService.createNotification({
                        userId: fu.patient.userId,
                        type: 'FOLLOWUP_MISSED',
                        title: 'You missed a scheduled follow-up',
                        message: `Your ${fu.daysOffset}-day follow-up was due on ${fu.dueDate?.toISOString().slice(0, 10)}. Book your next visit to stay on track.`,
                        priority: 'HIGH',
                        data: { followUpId: fu.id, appointmentId: fu.appointmentId, dueDate: fu.dueDate },
                    });
                } catch (err) {
                    logger.warn(`[followUp] notify patient failed for followUp ${fu.id}: ${err.message}`);
                }
            }
            flipped++;
        }

        logger.info(`[followUp] detectMissedFollowUps: flipped ${flipped} pending → MISSED`);
        return flipped;
    }
}
