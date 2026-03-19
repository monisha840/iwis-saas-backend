import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { FeedbackService } from '../services/feedback.service.js';

const router = express.Router();

const submitSchema = z.object({
    rating:  z.number().int().min(1).max(5),
    comment: z.string().max(1000).optional(),
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

export default router;
