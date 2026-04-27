import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditAction } from '../middleware/auditLog.js';
import { requireFeature } from '../utils/featureGate.js';
import { FeedbackService } from '../services/feedback.service.js';
import { ConsultationFeedbackService } from '../services/consultationFeedback.service.js';
import { JourneyFeedbackService } from '../services/journeyFeedback.service.js';

const router = express.Router();

const submitSchema = z.object({
    rating:  z.number().int().min(1).max(5),
    comment: z.string().max(1000).optional(),
});

// 4-question post-consultation flow. Each field is individually nullable —
// the client submits whatever the patient didn't skip. XP is computed
// server-side from the response values; the client does not send it.
const consultationFeedbackSchema = z.object({
    appointment_id:          z.string().min(1),
    face_scale_emotional:    z.number().int().min(1).max(5).nullable().optional(),
    face_scale_confidence:   z.number().int().min(1).max(5).nullable().optional(),
    mcq_listening:           z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    mcq_return:              z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
});

// POST /api/feedback/:appointmentId — patient submits a star rating
router.post(
    '/:appointmentId',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    validate({ body: submitSchema }),
    async (req, res, next) => {
        try {
            const feedback = await FeedbackService.submitFeedback(
                req.user.id,
                req.params.appointmentId,
                req.body,
            );
            res.status(201).json({ success: true, data: feedback });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/:appointmentId — clinician or patient retrieves feedback
router.get(
    '/:appointmentId',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']),
    async (req, res, next) => {
        try {
            const data = await FeedbackService.getFeedbackForAppointment(req.params.appointmentId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/stats/doctor/:doctorId — admin views doctor's aggregate rating
router.get(
    '/stats/doctor/:doctorId',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            const data = await FeedbackService.getDoctorFeedbackStats(req.params.doctorId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/stats/therapist/:therapistId — admin views therapist's aggregate rating
router.get(
    '/stats/therapist/:therapistId',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            const data = await FeedbackService.getTherapistFeedbackStats(req.params.therapistId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// ── Post-consultation 4-question flow ───────────────────────────────────────

// GET /api/feedback/consultation/pending — patient dashboard checks on app open
router.get(
    '/consultation/pending',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    async (req, res, next) => {
        try {
            const pending = await ConsultationFeedbackService.getPending(req.user.id);
            res.json({ success: true, data: pending });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/consultation/stats/doctor/:doctorId — admin aggregation
router.get(
    '/consultation/stats/doctor/:doctorId',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            const data = await ConsultationFeedbackService.getDoctorAggregate(
                req.params.doctorId,
                { since: req.query.since },
            );
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// POST /api/feedback/consultation — submit the 4 answers (any subset)
router.post(
    '/consultation',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    validate({ body: consultationFeedbackSchema }),
    async (req, res, next) => {
        try {
            const { appointment_id, ...responses } = req.body;
            const result = await ConsultationFeedbackService.submit(
                req.user.id,
                appointment_id,
                responses,
            );
            res.status(201).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    },
);

// ── Journey-completion 7-stage feedback flow ───────────────────────────────
//
// Triggered when a TreatmentJourney status flips to COMPLETED. The patient
// sees a full-screen takeover the next time they open the app. Single
// submission only — XP up to 7 is computed server-side and credited to the
// lead doctor (with proportional split to qualifying co-treaters).

const journeyFeedbackSchema = z.object({
    journey_id:                  z.string().min(1),
    mcq_appointments:            z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    mcq_reminders:               z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    mcq_medications:             z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    mcq_family_recommendation:   z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    garden_score:                z.number().int().refine((v) => [1, 3, 5, 7, 10].includes(v), {
        message: 'garden_score must be one of 1, 3, 5, 7, 10',
    }).nullable().optional(),
    face_scale_experience:       z.number().int().min(1).max(5).nullable().optional(),
    thank_you_card_text:         z.string().max(2000).nullable().optional(),
    thank_you_card_public:       z.boolean().optional(),
    photos_viewed:               z.boolean().optional(),
});

// GET /api/feedback/journey/available — patient dashboard checks on app open
router.get(
    '/journey/available',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    requireFeature('JOURNEY_FEEDBACK'),
    async (req, res, next) => {
        try {
            const data = await JourneyFeedbackService.getAvailableForUser(req.user.id);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/journey/:journeyId/photos — before/after pair (Stage 2)
router.get(
    '/journey/:journeyId/photos',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    requireFeature('JOURNEY_FEEDBACK'),
    async (req, res, next) => {
        try {
            const data = await JourneyFeedbackService.getPhotosForJourney(req.params.journeyId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// POST /api/feedback/journey — submit the 7-stage flow
router.post(
    '/journey',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    requireFeature('JOURNEY_FEEDBACK'),
    validate({ body: journeyFeedbackSchema }),
    auditAction('JOURNEY_FEEDBACK_SUBMITTED', 'JourneyFeedback', (req) => req.body.journey_id),
    async (req, res, next) => {
        try {
            const { journey_id, ...responses } = req.body;
            const result = await JourneyFeedbackService.submit(
                req.user.id,
                journey_id,
                responses,
            );
            res.status(201).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/journey/recognition — doctor's "This Week's Recognition"
// public-card panel. Last 7 days of PUBLIC thank-you cards by default.
router.get(
    '/journey/recognition',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    requireFeature('JOURNEY_FEEDBACK'),
    async (req, res, next) => {
        try {
            const sinceDays = Math.min(parseInt(req.query.sinceDays, 10) || 7, 90);
            const data = await JourneyFeedbackService.getRecognitionForDoctor(req.user.id, { sinceDays });
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/journey/letters — doctor's full letter inbox (public + private)
router.get(
    '/journey/letters',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    requireFeature('JOURNEY_FEEDBACK'),
    async (req, res, next) => {
        try {
            const take = Math.min(parseInt(req.query.take, 10) || 20, 100);
            const data = await JourneyFeedbackService.getPrivateCardsForDoctor(req.user.id, { take });
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

export default router;
