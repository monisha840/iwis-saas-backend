import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

export class FeedbackService {
    /**
     * Submit a star rating (1–5) for a completed appointment.
     * One submission per appointment — idempotent upsert.
     */
    static async submitFeedback(userId, appointmentId, { rating, comment }) {
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            const err = new Error('Rating must be an integer between 1 and 5');
            err.status = 400;
            throw err;
        }

        // Verify appointment exists and belongs to this patient
        const patient = await prisma.patient.findUnique({ where: { userId }, select: { id: true } });
        if (!patient) {
            const err = new Error('Patient profile not found');
            err.status = 404;
            throw err;
        }

        const appointment = await prisma.appointment.findUnique({
            where: { id: appointmentId },
            select: { id: true, patientId: true, status: true, branchId: true },
        });

        if (!appointment) {
            const err = new Error('Appointment not found');
            err.status = 404;
            throw err;
        }
        if (appointment.patientId !== patient.id) {
            const err = new Error('Access denied');
            err.status = 403;
            throw err;
        }
        // Feedback is accepted once the appointment start time has passed,
        // as long as it wasn't cancelled / marked no-show. This avoids the
        // dead-end where a clinician forgets to mark the visit COMPLETED.
        const startedAt = appointment.date ? new Date(appointment.date).getTime() : null;
        const startHasPassed = startedAt && startedAt <= Date.now();
        const blockedStatuses = ['CANCELLED', 'NO_SHOW'];
        if (!startHasPassed) {
            const err = new Error('Feedback can only be submitted after the appointment start time');
            err.status = 400;
            throw err;
        }
        if (blockedStatuses.includes(appointment.status)) {
            const err = new Error('Feedback is not available for cancelled or no-show appointments');
            err.status = 400;
            throw err;
        }

        const feedback = await prisma.appointmentFeedback.upsert({
            where: { appointmentId },
            create: {
                appointmentId,
                patientId: patient.id,
                rating,
                comment: comment?.trim() || null,
                branchId: appointment.branchId,
            },
            update: {
                rating,
                comment: comment?.trim() || null,
            },
        });

        logger.info('[FeedbackService] Feedback submitted', { appointmentId, rating });
        return feedback;
    }

    /**
     * Get feedback for a specific appointment.
     * Accessible by the patient who submitted it, or by clinicians/admin.
     */
    static async getFeedbackForAppointment(appointmentId) {
        return prisma.appointmentFeedback.findUnique({
            where: { appointmentId },
            select: {
                id: true, rating: true, comment: true, createdAt: true,
                patient: { select: { fullName: true } },
            },
        });
    }

    /**
     * Aggregate feedback stats for a doctor or therapist.
     * Returns avgRating, totalRatings, distribution (count per star).
     */
    static async getDoctorFeedbackStats(doctorId) {
        const feedbacks = await prisma.appointmentFeedback.findMany({
            where: { appointment: { doctorId } },
            select: { rating: true },
        });

        return FeedbackService._aggregate(feedbacks);
    }

    static async getTherapistFeedbackStats(therapistId) {
        const feedbacks = await prisma.appointmentFeedback.findMany({
            where: { appointment: { therapistId } },
            select: { rating: true },
        });

        return FeedbackService._aggregate(feedbacks);
    }

    /**
     * Branch-level aggregate: avg rating + total count.
     */
    static async getBranchFeedbackStats(branchId) {
        const feedbacks = await prisma.appointmentFeedback.findMany({
            where: { branchId },
            select: { rating: true },
        });

        return FeedbackService._aggregate(feedbacks);
    }

    static _aggregate(feedbacks) {
        const total = feedbacks.length;
        if (total === 0) return { avgRating: null, totalRatings: 0, distribution: {} };

        const sum = feedbacks.reduce((s, f) => s + f.rating, 0);
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        feedbacks.forEach(f => { distribution[f.rating] = (distribution[f.rating] || 0) + 1; });

        return {
            avgRating: Math.round((sum / total) * 10) / 10,
            totalRatings: total,
            distribution,
        };
    }
}
