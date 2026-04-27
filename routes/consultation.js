import express from 'express';
import { z } from 'zod';
import { ConsultationService } from '../services/consultation.service.js';
import { PatientQueueService } from '../services/patientQueue.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';

const router = express.Router();

const availabilitySchema = z.object({
    dayOfWeek: z.number().min(0).max(6),
    startTime: z.string(),
    endTime: z.string(),
});

router.get('/availability', authMiddleware, roleMiddleware(['THERAPIST', 'ADMIN']), async (req, res, next) => {
    try {
        const data = await ConsultationService.getAvailability(req.user.id, req.user.role, req.query.therapistId);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

router.post('/availability', authMiddleware, roleMiddleware(['THERAPIST', 'ADMIN']), validate({ body: availabilitySchema }), async (req, res, next) => {
    try {
        const data = await ConsultationService.addAvailability(req.user.id, req.user.role, req.body);
        res.status(201).json(data);
    } catch (err) {
        next(err);
    }
});

router.post('/session/:appointmentId/start', authMiddleware, roleMiddleware(['THERAPIST']), async (req, res, next) => {
    try {
        const data = await ConsultationService.startSession(req.params.appointmentId);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

router.post('/session/:appointmentId/notes', authMiddleware, roleMiddleware(['THERAPIST']), async (req, res, next) => {
    try {
        const data = await ConsultationService.saveNotes(req.params.appointmentId, req.body.sessionNotes);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

router.post('/session/:appointmentId/complete', authMiddleware, roleMiddleware(['THERAPIST', 'DOCTOR', 'ADMIN_DOCTOR', 'ADMIN']), async (req, res, next) => {
    try {
        const data = await ConsultationService.completeSession(req.params.appointmentId, {
            user: req.user,
            followUp: req.body?.followUp,
        });

        // Mirror onto the queue board: flip QueueEntry → COMPLETED and emit
        // consultation_ended to both the doctor and branch queue rooms so
        // the live board updates without waiting for a poll. Best-effort —
        // the consultation was already saved successfully if we got here.
        try {
            await PatientQueueService.endConsultation(req.params.appointmentId, { actorUserId: req.user.id });
        } catch (qErr) {
            logger.warn('[Consultation] queue end-consultation hook failed', {
                appointmentId: req.params.appointmentId, err: qErr.message,
            });
        }

        res.json(data);
    } catch (err) {
        next(err);
    }
});

router.get('/therapist/stats', authMiddleware, roleMiddleware(['THERAPIST']), async (req, res, next) => {
    try {
        const data = await ConsultationService.getTherapistStats(req.user.id);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

export default router;
