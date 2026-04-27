import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ClinicianXPService } from './clinicianXP.service.js';

// 48h window after the appointment's updatedAt (the COMPLETED transition) in
// which the banner is shown and submission is accepted. Aligns with the
// product spec: "silently close after 48 hours with no engagement".
const FEEDBACK_WINDOW_MS = 48 * 60 * 60 * 1000;

// 24h reminder push — sent once per appointment if the patient hasn't opened
// the app + engaged by then.
const REMINDER_MIN_MS = 24 * 60 * 60 * 1000;

const POSITIVE_FACE_THRESHOLD = 4;
const POSITIVE_MCQ_OPTIONS = new Set(['A', 'B']);

function xpForResponses({ faceScaleEmotional, faceScaleConfidence, mcqListening, mcqReturn }) {
    let xp = 0;
    if (Number.isInteger(faceScaleEmotional)  && faceScaleEmotional  >= POSITIVE_FACE_THRESHOLD) xp += 1;
    if (Number.isInteger(faceScaleConfidence) && faceScaleConfidence >= POSITIVE_FACE_THRESHOLD) xp += 1;
    if (mcqListening && POSITIVE_MCQ_OPTIONS.has(mcqListening)) xp += 1;
    if (mcqReturn    && POSITIVE_MCQ_OPTIONS.has(mcqReturn))    xp += 1;
    return xp;
}

export class ConsultationFeedbackService {
    /**
     * Called when the patient app loads — returns the single pending feedback
     * prompt (or null). A prompt is pending when:
     *   - appointment.status === 'COMPLETED'
     *   - belongs to this patient
     *   - no ConsultationFeedback row yet
     *   - the COMPLETED transition (updatedAt) was less than 48h ago
     *
     * Note: we don't eagerly "expire" rows — the 48h cutoff is computed at
     * read time. This keeps the scheduler simple and avoids a housekeeping job.
     */
    static async getPending(userId) {
        const patient = await prisma.patient.findUnique({
            where: { userId },
            select: { id: true },
        });
        if (!patient) return null;

        const cutoff = new Date(Date.now() - FEEDBACK_WINDOW_MS);

        const appt = await prisma.appointment.findFirst({
            where: {
                patientId: patient.id,
                status: 'COMPLETED',
                consultationFeedback: null,
                doctorId: { not: null },
                updatedAt: { gte: cutoff },
            },
            orderBy: { updatedAt: 'desc' },
            select: {
                id: true,
                updatedAt: true,
                doctor: { select: { id: true, fullName: true } },
            },
        });

        if (!appt) return null;

        return {
            appointmentId: appt.id,
            completedAt:   appt.updatedAt,
            expiresAt:     new Date(appt.updatedAt.getTime() + FEEDBACK_WINDOW_MS),
            doctor: {
                id:   appt.doctor?.id,
                name: appt.doctor?.fullName || 'your doctor',
            },
        };
    }

    /**
     * Submit the 4-question feedback. Server-side XP calculation is the only
     * source of truth — the client doesn't send xp.
     *
     * Idempotent: any further submission for the same appointment returns the
     * existing record without re-awarding XP.
     */
    static async submit(userId, appointmentId, body) {
        const patient = await prisma.patient.findUnique({
            where: { userId },
            select: { id: true },
        });
        if (!patient) {
            const err = new Error('Patient profile not found');
            err.status = 404;
            throw err;
        }

        const appointment = await prisma.appointment.findUnique({
            where: { id: appointmentId },
            select: {
                id: true, patientId: true, status: true, updatedAt: true,
                branchId: true, doctorId: true,
                doctor: { select: { userId: true, fullName: true } },
                consultationFeedback: { select: { id: true, xpAwarded: true } },
            },
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
        if (appointment.status !== 'COMPLETED') {
            const err = new Error('Feedback can only be submitted after the consultation is marked COMPLETED');
            err.status = 400;
            throw err;
        }
        if (!appointment.doctorId) {
            const err = new Error('Appointment has no doctor — feedback not applicable');
            err.status = 400;
            throw err;
        }
        const windowOpen = appointment.updatedAt.getTime() + FEEDBACK_WINDOW_MS > Date.now();
        if (!windowOpen) {
            const err = new Error('The feedback window for this consultation has closed');
            err.status = 410;
            throw err;
        }
        if (appointment.consultationFeedback) {
            return { xp_awarded: appointment.consultationFeedback.xpAwarded, alreadySubmitted: true };
        }

        // Normalise nulls — per spec, each stage is individually skippable.
        const responses = {
            faceScaleEmotional:  Number.isInteger(body.face_scale_emotional)  ? body.face_scale_emotional  : null,
            faceScaleConfidence: Number.isInteger(body.face_scale_confidence) ? body.face_scale_confidence : null,
            mcqListening:        body.mcq_listening || null,
            mcqReturn:           body.mcq_return    || null,
        };

        const xp = xpForResponses(responses);

        const feedback = await prisma.consultationFeedback.create({
            data: {
                appointmentId:       appointment.id,
                patientId:           patient.id,
                doctorId:            appointment.doctorId,
                branchId:            appointment.branchId,
                faceScaleEmotional:  responses.faceScaleEmotional,
                faceScaleConfidence: responses.faceScaleConfidence,
                mcqListening:        responses.mcqListening,
                mcqReturn:           responses.mcqReturn,
                xpAwarded:           xp,
                completedAt:         new Date(),
            },
        });

        if (xp > 0 && appointment.doctor?.userId) {
            try {
                await ClinicianXPService.awardXP(
                    appointment.doctor.userId,
                    'POSITIVE_FEEDBACK',
                    xp,
                    feedback.id,
                    { source: 'consultation_feedback', appointmentId },
                );
            } catch (err) {
                // XP award failure must not roll back the feedback submission —
                // the patient's response is still valuable even if the doctor's
                // XP ledger write fails. Log loudly so ops can replay.
                logger.error('[ConsultationFeedbackService] XP award failed', {
                    feedbackId: feedback.id, err: err.message,
                });
            }
        }

        logger.info('[ConsultationFeedbackService] Feedback submitted', {
            appointmentId, xp, doctorId: appointment.doctorId,
        });
        return { xp_awarded: xp, alreadySubmitted: false };
    }

    /**
     * Scheduler hook: for every COMPLETED appointment in the 24–48h window
     * that still has no feedback AND no reminder notification yet, send one
     * in-app reminder (which the push subscriber will forward as a push).
     *
     * Idempotency: we check for an existing CONSULTATION_FEEDBACK_REMINDER
     * notification for the same appointmentId before creating another.
     */
    static async sendRemindersForPending() {
        const now = Date.now();
        const reminderLowerBound = new Date(now - FEEDBACK_WINDOW_MS);  // don't re-remind expired ones
        const reminderUpperBound = new Date(now - REMINDER_MIN_MS);     // at least 24h past completion

        const candidates = await prisma.appointment.findMany({
            where: {
                status: 'COMPLETED',
                consultationFeedback: null,
                doctorId: { not: null },
                updatedAt: { gte: reminderLowerBound, lte: reminderUpperBound },
            },
            select: {
                id: true,
                patient:  { select: { userId: true } },
                doctor:   { select: { fullName: true } },
            },
        });

        let sent = 0;
        for (const appt of candidates) {
            if (!appt.patient?.userId) continue;

            // Idempotency via (relatedId, type) — matches the existing index
            // used by all the other "send-once" notifications in the system.
            const existing = await prisma.notification.findFirst({
                where: {
                    relatedId: appt.id,
                    type:      'CONSULTATION_FEEDBACK_REMINDER',
                },
                select: { id: true },
            });
            if (existing) continue;

            const doctorName = appt.doctor?.fullName || 'your doctor';
            await prisma.notification.create({
                data: {
                    userId:    appt.patient.userId,
                    type:      'CONSULTATION_FEEDBACK_REMINDER',
                    title:     'Quick feedback?',
                    message:   `A couple of questions about your visit with ${doctorName} — under a minute.`,
                    priority:  'LOW',
                    relatedId: appt.id,
                    data:      { appointmentId: appt.id },
                },
            });
            sent += 1;
        }

        if (sent > 0) {
            logger.info(`[ConsultationFeedbackService] Sent ${sent} 24h feedback reminders`);
        }
        return sent;
    }

    /**
     * Aggregate stats for a doctor — response counts, positive-rate per
     * question, total XP credited from this channel. Used by the admin
     * view. `since` is an optional ISO date string to scope recency.
     */
    static async getDoctorAggregate(doctorId, { since } = {}) {
        const where = { doctorId };
        if (since) where.createdAt = { gte: new Date(since) };

        const rows = await prisma.consultationFeedback.findMany({
            where,
            select: {
                faceScaleEmotional:  true,
                faceScaleConfidence: true,
                mcqListening:        true,
                mcqReturn:           true,
                xpAwarded:           true,
            },
        });

        const total = rows.length;
        if (total === 0) {
            return {
                totalSubmissions: 0,
                totalXpAwarded:   0,
                emotional: null, confidence: null, listening: null, return: null,
            };
        }

        const summarise = (values, positivePredicate) => {
            const answered = values.filter((v) => v !== null && v !== undefined);
            if (answered.length === 0) return { answered: 0, positive: 0, positiveRate: null, average: null };
            const positive = answered.filter(positivePredicate).length;
            const numericAvg = answered.every((v) => typeof v === 'number')
                ? Math.round((answered.reduce((s, v) => s + v, 0) / answered.length) * 10) / 10
                : null;
            return {
                answered:     answered.length,
                positive,
                positiveRate: Math.round((positive / answered.length) * 100) / 100,
                average:      numericAvg,
            };
        };

        return {
            totalSubmissions: total,
            totalXpAwarded:   rows.reduce((s, r) => s + r.xpAwarded, 0),
            emotional:  summarise(rows.map((r) => r.faceScaleEmotional),  (v) => v >= POSITIVE_FACE_THRESHOLD),
            confidence: summarise(rows.map((r) => r.faceScaleConfidence), (v) => v >= POSITIVE_FACE_THRESHOLD),
            listening:  summarise(rows.map((r) => r.mcqListening),        (v) => POSITIVE_MCQ_OPTIONS.has(v)),
            return:     summarise(rows.map((r) => r.mcqReturn),           (v) => POSITIVE_MCQ_OPTIONS.has(v)),
        };
    }
}
