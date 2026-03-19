import express from 'express';
import { ReferralService } from '../services/referral.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/referrals/my-code
 * Returns the authenticated patient's referral code, creating one if needed.
 */
router.get('/my-code', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
    try {
        const result = await ReferralService.getOrCreateCode(req.user.id);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/referrals/my
 * Returns all referrals made by the authenticated patient.
 */
router.get('/my', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
    try {
        const referrals = await ReferralService.getMyReferrals(req.user.id);
        res.json(referrals);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/referrals/stats — Admin aggregate statistics
 */
router.get('/stats', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const stats = await ReferralService.getStats();
        res.json(stats);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/referrals/apply
 * Called after patient registration to link a referral code.
 * Body: { patientId, referralCode }
 */
router.post('/apply', authMiddleware, async (req, res, next) => {
    try {
        const { patientId, referralCode } = req.body;
        if (!patientId || !referralCode) {
            return res.status(400).json({ error: 'patientId and referralCode are required' });
        }
        const result = await ReferralService.applyReferralCode(patientId, referralCode);
        res.json({ applied: !!result, referral: result });
    } catch (err) {
        next(err);
    }
});

export default router;
