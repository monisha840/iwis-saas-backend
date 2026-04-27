import express from 'express';
import { TimelineService } from '../services/timeline.service.js';
import { EnhancedDashboardService } from '../services/enhancedDashboard.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

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
            const patientRecord = await prisma.patient.findUnique({
                where: { userId: user.id },
                select: { id: true },
            });
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

/**
 * GET /api/patients/:id/pain-map
 * Latest pain-region snapshot for a patient — sourced from the most recent
 * DailyCheckIn that has a body-map array, falling back to the latest
 * TriageSession. Returns the same shape as /api/patient/dashboard/last-pain-regions
 * so the same BodyMapPainSelector component can render either side.
 *
 * Accessible by: ADMIN, ADMIN_DOCTOR, DOCTOR, THERAPIST, BRANCH_ADMIN, PHARMACIST
 *                and the PATIENT themselves.
 */
router.get(
    '/:id/pain-map',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'BRANCH_ADMIN', 'PHARMACIST', 'SUPER_ADMIN', 'PATIENT']),
    async (req, res, next) => {
        try {
            const { id } = req.params;
            const { user } = req;

            // PATIENT may only read their own snapshot.
            if (user.role === 'PATIENT') {
                const patientRecord = await prisma.patient.findUnique({
                    where: { userId: user.id },
                    select: { id: true },
                });
                if (!patientRecord || patientRecord.id !== id) {
                    return res.status(403).json({ error: 'Access denied' });
                }
            }

            const result = await EnhancedDashboardService.getLastPainRegions(id);
            res.json(result);
        } catch (err) {
            next(err);
        }
    },
);

export default router;
