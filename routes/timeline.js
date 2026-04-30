import express from 'express';
import { TimelineService } from '../services/timeline.service.js';
import { EnhancedDashboardService } from '../services/enhancedDashboard.service.js';
import { ClinicianXPService } from '../services/clinicianXP.service.js';
import { cacheService } from '../services/cache.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

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

/**
 * POST /api/patients/:patientId/record-review
 *
 * Awards XP to a clinician who has spent meaningful time reviewing a patient
 * record. Anti-spam:
 *   • duration floor: ≥60s (anything shorter is treated as a tab-skim)
 *   • per-day rate limit: one award per (doctor, patient, calendar day)
 *     keyed in Redis with 24h TTL
 *
 * ADMIN_DOCTOR is allowed to call (and is rate-limited the same way) but
 * ClinicianXPService.awardXP is a no-op for that role — they are oversight,
 * not participants. We still return 200 with the rate-limit + duration verdict
 * so the frontend toast is consistent.
 */
router.post('/:patientId/record-review', authMiddleware, roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const { patientId } = req.params;
        const durationSeconds = Number(req.body?.durationSeconds);
        if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
            return res.status(400).json({ error: 'durationSeconds (number) is required' });
        }

        if (durationSeconds < 60) {
            return res.json({
                xpAwarded: 0,
                tooShort: true,
                message: 'Spend at least 1 minute reviewing the record to earn XP.',
            });
        }

        // Daily rate limit. Falls open when Redis is unavailable so a
        // degraded cache layer never silently drops legit XP.
        const today = new Date().toISOString().slice(0, 10);
        const rateKey = `review_xp:${req.user.id}:${patientId}:${today}`;
        try {
            const seen = await cacheService.get(rateKey);
            if (seen) {
                return res.json({
                    alreadyAwarded: true,
                    message: 'XP already awarded for reviewing this patient today',
                });
            }
        } catch (err) {
            logger.warn('[record-review] cache read failed, falling open', { err: err.message });
        }

        const xpAmount = ClinicianXPService.XP_ACTIONS.PATIENT_REVIEW;
        const ledger = await ClinicianXPService.awardXP(
            req.user.id,
            'PATIENT_REVIEW',
            xpAmount,
            patientId,
            { durationSeconds },
        );

        // awardXP returns null for ADMIN_DOCTOR (excluded from XP pipeline).
        // Still set the rate-limit key so they can't poll the endpoint.
        try {
            await cacheService.set(rateKey, '1', 24 * 60 * 60);
        } catch (err) {
            logger.warn('[record-review] cache write failed', { err: err.message });
        }

        if (!ledger) {
            return res.json({
                xpAwarded: 0,
                excludedRole: true,
                message: 'XP not granted (oversight role excluded from the XP pipeline).',
            });
        }

        const profile = await prisma.clinicianXP.findUnique({
            where: { userId: req.user.id },
            select: { totalXP: true },
        });

        res.json({
            xpAwarded: xpAmount,
            totalXP: profile?.totalXP ?? xpAmount,
            message: 'XP awarded for patient review',
        });
    } catch (err) {
        next(err);
    }
});

export default router;
