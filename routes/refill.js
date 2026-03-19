import express from 'express';
import { z } from 'zod';
import { RefillService } from '../services/refill.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const requestRefillSchema = z.object({
    notes: z.string().max(500).optional(),
});

const processRefillSchema = z.object({
    action: z.enum(['APPROVED', 'REJECTED']),
    notes:  z.string().max(500).optional(),
});

// ── Patient routes ─────────────────────────────────────────────────────────

/** POST /api/refills/:prescriptionId — patient requests a refill */
router.post('/:prescriptionId',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    validate({ body: requestRefillSchema }),
    async (req, res, next) => {
        try {
            const result = await RefillService.requestRefill(
                req.user.id,
                req.params.prescriptionId,
                req.body.notes,
            );
            res.status(201).json(result);
        } catch (err) {
            next(err);
        }
    }
);

/** GET /api/refills/my — patient views their own refill history */
router.get('/my', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
    try {
        const refills = await RefillService.getPatientRefills(req.user.id);
        res.json(refills);
    } catch (err) {
        next(err);
    }
});

// ── Clinician routes ───────────────────────────────────────────────────────

/** GET /api/refills/pending — clinician views pending refill requests */
router.get('/pending',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            const refills = await RefillService.getPendingRefillsForClinician(req.user.id);
            res.json(refills);
        } catch (err) {
            next(err);
        }
    }
);

/** PATCH /api/refills/:refillId/process — clinician approves or rejects */
router.patch('/:refillId/process',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR']),
    validate({ body: processRefillSchema }),
    async (req, res, next) => {
        try {
            const result = await RefillService.processRefill(
                req.user.id,
                req.params.refillId,
                req.body.action,
                req.body.notes,
            );
            res.json(result);
        } catch (err) {
            next(err);
        }
    }
);

export default router;
