/**
 * F01 · Patient Digital Twin — read API.
 *
 * One endpoint that powers the ConsultationRoom's DigitalTwinPanel.
 * The pre-existing `/full-details` (routes/timeline.js, labelled
 * "static digital-twin" in the codebase) is intentionally left alone —
 * the twin panel needs a narrower, parallel-queried payload tailored to
 * its sparklines + dosha bars, and we don't want to entangle the two
 * surfaces.
 */

import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import prisma from '../lib/prisma.js';
import { buildDigitalTwin } from '../services/digitalTwin/twinAggregator.js';

const router = express.Router();

router.get(
    '/patients/:patientId/digital-twin',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR']),
    requireFeature('PATIENT_DIGITAL_TWIN'),
    async (req, res, next) => {
        try {
            const { patientId } = req.params;

            // Hospital-scope guard — same pattern as the F04 / F03 routes.
            const patient = await prisma.patient.findUnique({
                where: { id: patientId },
                select: { id: true, user: { select: { hospitalId: true } } },
            });
            if (!patient) return res.status(404).json({ error: 'Patient not found' });
            if (patient.user?.hospitalId && req.user?.hospitalId &&
                patient.user.hospitalId !== req.user.hospitalId) {
                return res.status(403).json({ error: 'Forbidden — different hospital' });
            }

            const twin = await buildDigitalTwin(patientId);
            if (!twin) return res.status(404).json({ error: 'Patient not found' });
            res.json(twin);
        } catch (err) { next(err); }
    },
);

export default router;
