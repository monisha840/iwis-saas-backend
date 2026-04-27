import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { ClinicianGamificationController } from '../controllers/clinicianGamification.controller.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

const router = express.Router();

// ADMIN_DOCTOR is oversight, not a participant — excluded from XP, seasonal
// challenges, mentor sessions and reward redemption. They retain ADMIN_ROLES
// privileges (creating challenges/rewards, processing redemptions).
const CLINICIAN_ROLES = ['DOCTOR', 'THERAPIST'];
const ADMIN_ROLES = ['ADMIN', 'ADMIN_DOCTOR'];

// Path-prefix feature gates (one per sub-area). Auth must run first because the gate
// reads req.user.hospitalId.
router.use('/xp',                  authMiddleware, requireFeature('CLINICIAN_XP'));
router.use('/seasonal-challenges', authMiddleware, requireFeature('SEASONAL_CHALLENGES'));
router.use('/rewards',             authMiddleware, requireFeature('REWARD_STORE'));
router.use('/mentor-sessions',     authMiddleware, requireFeature('MENTOR_SESSIONS'));
// Note: ACHIEVEMENT_SHOWCASE has no dedicated endpoints — the showcase page is rendered
// from the gated /xp/* endpoints, so disabling it via Super Admin is purely visual
// (hide the nav entry). No API surface to block here.

// ── XP & Level ──────────────────────────────────────────────────────────────

/** GET /api/clinician-gamification/xp/profile — own XP profile */
router.get('/xp/profile', authMiddleware, roleMiddleware(CLINICIAN_ROLES), ClinicianGamificationController.getXPProfile);

/** GET /api/clinician-gamification/xp/history — XP history */
router.get('/xp/history', authMiddleware, roleMiddleware(CLINICIAN_ROLES), ClinicianGamificationController.getXPHistory);

/** GET /api/clinician-gamification/xp/leaderboard — XP leaderboard */
router.get('/xp/leaderboard', authMiddleware, roleMiddleware([...ADMIN_ROLES, 'DOCTOR', 'THERAPIST']), ClinicianGamificationController.getXPLeaderboard);

// ── Seasonal Challenges ─────────────────────────────────────────────────────

const createChallengeSchema = z.object({
    title: z.string().min(3).max(100),
    description: z.string().min(3).max(500),
    icon: z.string().max(50).optional(),
    metric: z.string().min(1).max(100),
    target: z.number().positive(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
    scope: z.enum(['INDIVIDUAL', 'BRANCH', 'ALL']).optional(),
    targetRoles: z.array(z.enum(['DOCTOR', 'THERAPIST'])).optional(),
    rewardXP: z.number().int().min(0).optional(),
    rewardPoints: z.number().int().min(0).optional(),
});

/** POST /api/clinician-gamification/seasonal-challenges — create challenge */
router.post('/seasonal-challenges', authMiddleware, roleMiddleware(ADMIN_ROLES), validate({ body: createChallengeSchema }), ClinicianGamificationController.createSeasonalChallenge);

/** GET /api/clinician-gamification/seasonal-challenges — active challenges.
 *  Admins (ADMIN, ADMIN_DOCTOR) can browse the live catalog they manage —
 *  no progress is attached for them since they don't participate. */
router.get('/seasonal-challenges', authMiddleware, roleMiddleware([...CLINICIAN_ROLES, ...ADMIN_ROLES]), ClinicianGamificationController.getActiveChallenges);

/** GET /api/clinician-gamification/seasonal-challenges/history — past challenges */
router.get('/seasonal-challenges/history', authMiddleware, roleMiddleware(ADMIN_ROLES), ClinicianGamificationController.getChallengeHistory);

// ── Reward Store ────────────────────────────────────────────────────────────

const createRewardSchema = z.object({
    name: z.string().min(2).max(100),
    description: z.string().min(2).max(500),
    icon: z.string().max(50).optional(),
    category: z.enum(['LEAVE', 'PERK', 'GIFT', 'TRAINING']),
    pointsCost: z.number().int().positive(),
    stock: z.number().int().min(0).nullable().optional(),
});

/** GET /api/clinician-gamification/rewards — available rewards */
router.get('/rewards', authMiddleware, ClinicianGamificationController.getAvailableRewards);

/** POST /api/clinician-gamification/rewards — create reward (admin) */
router.post('/rewards', authMiddleware, roleMiddleware(ADMIN_ROLES), validate({ body: createRewardSchema }), ClinicianGamificationController.createReward);

/** POST /api/clinician-gamification/rewards/redeem/:rewardId — redeem */
router.post('/rewards/redeem/:rewardId', authMiddleware, ClinicianGamificationController.redeemReward);

/** GET /api/clinician-gamification/rewards/mine — my redemptions */
router.get('/rewards/mine', authMiddleware, ClinicianGamificationController.getMyRedemptions);

const processRedemptionSchema = z.object({
    status: z.enum(['APPROVED', 'FULFILLED', 'REJECTED']),
});

/** PATCH /api/clinician-gamification/rewards/redemptions/:id — process redemption (admin) */
router.patch('/rewards/redemptions/:id', authMiddleware, roleMiddleware(ADMIN_ROLES), validate({ body: processRedemptionSchema }), ClinicianGamificationController.processRedemption);

// ── Mentor Sessions ─────────────────────────────────────────────────────────

const createSessionSchema = z.object({
    menteeId: z.string().cuid(),
    topic: z.string().min(2).max(200),
    date: z.string().datetime(),
    durationMins: z.number().int().min(15).max(180).optional(),
});

/** POST /api/clinician-gamification/mentor-sessions — schedule session */
router.post('/mentor-sessions', authMiddleware, roleMiddleware(CLINICIAN_ROLES), validate({ body: createSessionSchema }), ClinicianGamificationController.createMentorSession);

/** GET /api/clinician-gamification/mentor-sessions — my sessions */
router.get('/mentor-sessions', authMiddleware, roleMiddleware(CLINICIAN_ROLES), ClinicianGamificationController.getMySessions);

/** GET /api/clinician-gamification/mentor-sessions/stats — mentor stats */
router.get('/mentor-sessions/stats', authMiddleware, roleMiddleware(CLINICIAN_ROLES), ClinicianGamificationController.getMentorStats);

/** PATCH /api/clinician-gamification/mentor-sessions/:id/complete — complete session */
router.patch('/mentor-sessions/:id/complete', authMiddleware, roleMiddleware(CLINICIAN_ROLES), ClinicianGamificationController.completeSession);

/** PATCH /api/clinician-gamification/mentor-sessions/:id/cancel — cancel session */
router.patch('/mentor-sessions/:id/cancel', authMiddleware, ClinicianGamificationController.cancelSession);

// ── Achievement Showcase (Feature 17) ───────────────────────────────────────

/** GET /api/clinician-gamification/showcase/:userId — public achievement profile */
router.get('/showcase/:userId', authMiddleware, ClinicianGamificationController.getShowcase);

export default router;
