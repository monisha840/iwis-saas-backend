/**
 * Patient health-summary endpoints.
 *
 *   GET /api/patient/health-summary
 *     Self-view for the logged-in patient. Resolves req.user.id → Patient.id.
 *
 *   GET /api/patients/:patientId/health-summary
 *     Clinician view. Gated to DOCTOR / ADMIN_DOCTOR / THERAPIST / ADMIN.
 *
 *   GET /api/patients/:patientId/vitals?type=PAIN_SCORE&limit=6
 *     Per-type vital history for the snapshot popover + the patient
 *     dashboard sparkline. Same role gate as the summary endpoint above.
 *
 * Both summary endpoints return the same shape from healthSummary.service.js.
 */

import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import { getHealthSummary, getVitalHistory } from '../services/healthSummary.service.js';

const router = express.Router();

const CLINICIAN_ROLES = ['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST', 'ADMIN'];

// ── Patient self-view ───────────────────────────────────────────────────────
router.get('/patient/health-summary', authMiddleware, async (req, res, next) => {
    try {
        if (req.user.role !== 'PATIENT') {
            return res.status(403).json({ error: 'Only patients may use this endpoint — clinicians should use /api/patients/:id/health-summary' });
        }
        const patient = await prisma.patient.findUnique({
            where: { userId: req.user.id },
            select: { id: true },
        });
        if (!patient) {
            return res.status(404).json({ error: 'No patient record linked to this account' });
        }
        const summary = await getHealthSummary(patient.id);
        res.json(summary);
    } catch (err) { next(err); }
});

// ── Clinician view ──────────────────────────────────────────────────────────
router.get('/patients/:patientId/health-summary',
    authMiddleware,
    roleMiddleware(CLINICIAN_ROLES),
    async (req, res, next) => {
        try {
            const summary = await getHealthSummary(req.params.patientId);
            res.json(summary);
        } catch (err) { next(err); }
    },
);

// ── Per-vital history (popover / sparkline) ─────────────────────────────────
router.get('/patients/:patientId/vitals',
    authMiddleware,
    roleMiddleware(CLINICIAN_ROLES),
    async (req, res, next) => {
        try {
            const type = String(req.query.type || '').toUpperCase();
            const limit = parseInt(req.query.limit, 10) || 6;
            const rows = await getVitalHistory(req.params.patientId, type, limit);
            res.json({ vitalType: type, readings: rows });
        } catch (err) { next(err); }
    },
);

export default router;
