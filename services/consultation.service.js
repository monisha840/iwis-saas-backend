import prisma from '../lib/prisma.js';
import { FollowUpService } from './followUp.service.js';
import { HandoffNoteService } from './handoffNote.service.js';
import logger from '../lib/logger.js';

export class ConsultationService {
    static async getAvailability(userId, role, therapistIdQuery) {
        const therapistRecord = await prisma.therapist.findUnique({ where: { userId } });
        if (!therapistRecord && role === 'THERAPIST') throw new Error('Therapist profile not found');

        return prisma.availability.findMany({
            where: {
                therapistId: role === 'ADMIN' ? therapistIdQuery : therapistRecord.id
            },
            orderBy: { dayOfWeek: 'asc' }
        });
    }

    static async addAvailability(userId, role, data) {
        const { dayOfWeek, startTime, endTime } = data;
        const therapistRecord = await prisma.therapist.findUnique({ where: { userId } });
        if (!therapistRecord) throw new Error('Therapist profile not found');

        return prisma.availability.create({
            data: {
                therapistId: therapistRecord.id,
                dayOfWeek,
                startTime,
                endTime,
                isApproved: role === 'ADMIN'
            }
        });
    }

    static async startSession(appointmentId) {
        const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
        if (!appointment) throw new Error('Appointment not found');

        let updateData = { status: 'IN_PROGRESS' };
        if (appointment.consultationMode === 'ONLINE' && !appointment.meetingLink) {
            updateData.meetingLink = `https://meet.jit.si/Alshifa-${appointment.id}`;
        }

        return prisma.appointment.update({
            where: { id: appointmentId },
            data: updateData
        });
    }

    static async saveNotes(appointmentId, sessionNotes) {
        return prisma.appointment.update({
            where: { id: appointmentId },
            data: { sessionNotes }
        });
    }

    static async completeSession(appointmentId, { user, followUp } = {}) {
        // Matches the clinical-workflow rule enforced by
        // AppointmentService.updateAppointment: a consultation cannot
        // flip to COMPLETED without a follow-up decision. We reuse the
        // same FollowUpService helper so there is one source of truth
        // for validation + due-date computation.
        const existing = await prisma.appointment.findUnique({
            where: { id: appointmentId },
            select: { id: true, patientId: true, date: true, status: true },
        });
        if (!existing) {
            const err = new Error('Appointment not found');
            err.status = 404;
            throw err;
        }

        if (existing.status === 'COMPLETED') {
            return prisma.appointment.findUnique({ where: { id: appointmentId } });
        }

        if (!followUp) {
            const alreadySet = await prisma.appointmentFollowUp.findUnique({
                where: { appointmentId },
                select: { id: true },
            });
            if (!alreadySet) {
                const err = new Error('Follow-up decision is required when completing a consultation. Supply { followUp: { interval, daysOffset?, notes? } }.');
                err.status = 400;
                err.code = 'FOLLOWUP_REQUIRED';
                throw err;
            }
        }

        const updated = await prisma.$transaction(async (tx) => {
            const appt = await tx.appointment.update({
                where: { id: appointmentId },
                data: { status: 'COMPLETED' },
            });
            if (followUp && user) {
                await FollowUpService.upsertForAppointment(tx, {
                    appointment: appt,
                    user,
                    payload: followUp,
                });
            }
            return appt;
        });

        // Advisory side-effects (never roll back clinical completion)
        try {
            await prisma.patient.update({
                where: { id: updated.patientId },
                data: { zenPoints: { increment: 100 } },
            });
        } catch (err) {
            logger.warn(`[consultation] zen-points bump failed for appt ${appointmentId}: ${err.message}`);
        }
        if (user) {
            try {
                await HandoffNoteService._autoDraftFromAppointment(updated, user);
            } catch (err) {
                logger.warn(`[handoff] auto-draft failed for appt ${appointmentId}: ${err.message}`);
            }
        }

        return updated;
    }

    static async getTherapistStats(userId) {
        const therapistRecord = await prisma.therapist.findUnique({ where: { userId } });
        if (!therapistRecord) throw new Error('Therapist profile not found');

        const therapistId = therapistRecord.id;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const [todaySittingsCount, activePatients, totalCompleted] = await Promise.all([
            prisma.appointment.count({ where: { therapistId, date: { gte: today, lt: tomorrow } } }),
            prisma.appointment.groupBy({ by: ['patientId'], where: { therapistId, status: { not: 'COMPLETED' } } }),
            prisma.appointment.count({ where: { therapistId, status: 'COMPLETED' } })
        ]);

        return {
            todaySittings: todaySittingsCount,
            activeCases: activePatients.length,
            completedSittings: totalCompleted,
            hoursWorked: (totalCompleted * 0.75).toFixed(1),
            recoveryProgress: 75,
            sessionAdherence: 92,
        };
    }
}
