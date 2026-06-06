/**
 * F04 · Predictive Dosha Imbalance Engine — read API.
 *
 * Single endpoint that powers the ConsultationRoom's DoshaForecastPanel.
 * Returns the last 10 forecasts so the clinician can see the trajectory
 * (a single point isn't useful — "was this predicted last week too?" is
 * the question the panel needs to answer).
 *
 * Auth: DOCTOR / ADMIN_DOCTOR (other clinical roles can be added later if
 * the panel is surfaced to therapists). Gated by PREDICTIVE_DOSHA_ENGINE
 * feature flag — flag-off hospitals 403 cleanly.
 */

import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import prisma from '../lib/prisma.js';

const router = express.Router();

router.get(
    '/patients/:patientId/dosha-forecast',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR']),
    requireFeature('PREDICTIVE_DOSHA_ENGINE'),
    async (req, res, next) => {
        try {
            const { patientId } = req.params;

            // Light authorization: confirm the patient belongs to the
            // requester's hospital. The schema reaches hospital via
            // Patient.user.hospitalId.
            const patient = await prisma.patient.findUnique({
                where: { id: patientId },
                select: { id: true, user: { select: { hospitalId: true } } },
            });
            if (!patient) return res.status(404).json({ error: 'Patient not found' });
            if (patient.user?.hospitalId && req.user?.hospitalId &&
                patient.user.hospitalId !== req.user.hospitalId) {
                return res.status(403).json({ error: 'Forbidden — different hospital' });
            }

            const forecasts = await prisma.doshaForecast.findMany({
                where: { patientId },
                orderBy: { generatedAt: 'desc' },
                take: 10,
                select: {
                    id: true,
                    generatedAt: true,
                    daysUntilSymp: true,
                    confidence: true,
                    dominantDosha: true,
                    imbalanceType: true,
                    triggerFactors: true,
                    alertEmitted: true,
                    alertEmittedAt: true,
                    resolved: true,
                    resolvedAt: true,
                },
            });

            res.json({ forecasts });
        } catch (err) { next(err); }
    },
);

export default router;
