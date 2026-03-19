import express from 'express';
import { TimelineService } from '../services/timeline.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/patients/:id/timeline
 * Accessible by: ADMIN, ADMIN_DOCTOR, DOCTOR, THERAPIST (clinicians viewing a patient)
 *                and PATIENT themselves (own timeline)
 * Query params: from (ISO date), to (ISO date)
 */
router.get('/:id/timeline', authMiddleware, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { from, to } = req.query;
        const { user } = req;

        // If the requester is a patient, they can only see their own timeline
        if (user.role === 'PATIENT') {
            const patientRecord = await import('../lib/prisma.js').then(m => m.default.patient.findUnique({
                where: { userId: user.id },
                select: { id: true },
            }));
            if (!patientRecord || patientRecord.id !== id) {
                return res.status(403).json({ error: 'Access denied' });
            }
        }

        const events = await TimelineService.getTimeline(id, { from, to });
        res.json({ patientId: id, total: events.length, events });
    } catch (err) {
        next(err);
    }
});

export default router;
