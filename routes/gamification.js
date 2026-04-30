import express from 'express';
import { authMiddleware, roleMiddleware, resolvePatientId } from '../middleware/auth.js';
import { GamificationController } from '../controllers/gamification.controller.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import prisma from '../lib/prisma.js';

const router = express.Router();

// ── Badge routes ─────────────────────────────────────────────────────────────

/** GET /api/gamification/badges — all badges with earned/unearned status */
router.get('/badges', authMiddleware, GamificationController.getAllBadges);

/** GET /api/gamification/badges/mine — only earned badges */
router.get('/badges/mine', authMiddleware, GamificationController.getMyBadges);

/**
 * GET /api/gamification/badges/:idOrCode/holders — admin click-through from
 * the Badge Distribution chart. Resolves either Badge.id or Badge.code so the
 * existing analytics endpoint (which only exposes `code`) can drive this lookup
 * without a schema change.
 */
router.get('/badges/:idOrCode/holders', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const key = req.params.idOrCode;
        const badge = await prisma.badge.findFirst({
            where: { OR: [{ id: key }, { code: key }] },
            select: { id: true, code: true, name: true, icon: true, tier: true, description: true },
        });
        if (!badge) return res.status(404).json({ error: 'Badge not found' });

        const awards = await prisma.userBadge.findMany({
            where: { badgeId: badge.id },
            orderBy: { awardedAt: 'desc' },
            include: {
                user: {
                    select: {
                        id: true, role: true,
                        branch: { select: { name: true } },
                        doctor:    { select: { id: true, fullName: true, profilePhoto: true } },
                        therapist: { select: { id: true, fullName: true, profilePhoto: true } },
                    },
                },
            },
        });

        // Pull current ranks in a single batch — keyed on the role-profile id
        // (Doctor.id / Therapist.id) since LeaderboardAudit.participantId stores
        // the profile id, not User.id.
        const profileIds = awards
            .map((a) => a.user.doctor?.id ?? a.user.therapist?.id)
            .filter(Boolean);
        const ranks = profileIds.length
            ? await prisma.leaderboardAudit.findMany({
                where: { participantId: { in: profileIds } },
                orderBy: { calculationDate: 'desc' },
                distinct: ['participantId'],
                select: { participantId: true, rank: true },
            })
            : [];
        const rankBy = new Map(ranks.map((r) => [r.participantId, r.rank]));

        const holders = awards.map((a) => {
            const profile = a.user.doctor || a.user.therapist || null;
            const profileId = profile?.id ?? null;
            return {
                userId: a.user.id,
                name: profile?.fullName || 'Unknown',
                role: a.user.role,
                branchName: a.user.branch?.name ?? null,
                profilePhoto: profile?.profilePhoto ?? null,
                awardedAt: a.awardedAt,
                currentRank: profileId ? (rankBy.get(profileId) ?? null) : null,
            };
        });

        res.json({ badge, holders, totalCount: holders.length });
    } catch (err) { next(err); }
});

// ── Streak routes ────────────────────────────────────────────────────────────

/** GET /api/gamification/streak — current clinician streak (excludes ADMIN_DOCTOR — oversight, not a participant) */
router.get('/streak', authMiddleware, roleMiddleware(['DOCTOR', 'THERAPIST']), GamificationController.getMyStreak);

// ── Adaptive targets ─────────────────────────────────────────────────────────

/** GET /api/gamification/targets — personalized scoring targets (excludes ADMIN_DOCTOR) */
router.get('/targets', authMiddleware, roleMiddleware(['DOCTOR', 'THERAPIST']), GamificationController.getMyTargets);

// ── Branch competitions ──────────────────────────────────────────────────────
// ADMIN_DOCTOR keeps view access on aggregate leaderboards / competitions for
// oversight, but does not participate (won't appear as a row).

/** GET /api/gamification/branch-leaderboard — aggregate branch rankings */
router.get('/branch-leaderboard', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), GamificationController.getBranchLeaderboard);

/** GET /api/gamification/competitions — active competitions */
router.get('/competitions', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), GamificationController.getActiveCompetitions);

/** GET /api/gamification/competitions/history — past competitions */
router.get('/competitions/history', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), GamificationController.getCompetitionHistory);

const createCompetitionSchema = z.object({
    title: z.string().min(3).max(100),
    description: z.string().max(500).optional(),
    metric: z.enum(['avgScore', 'avgResponseTime', 'totalAppointments']),
    startDate: z.string().datetime(),
    endDate: z.string().datetime()
});

/** POST /api/gamification/competitions — create a new competition (admin only) */
router.post('/competitions', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: createCompetitionSchema }), GamificationController.createCompetition);

// ── Zen Points (patient) ─────────────────────────────────────────────────────

/** GET /api/gamification/zen-profile — patient's gamification profile */
router.get('/zen-profile', authMiddleware, roleMiddleware(['PATIENT']), resolvePatientId, GamificationController.getZenProfile);

/** GET /api/gamification/challenges — today's daily challenges */
router.get('/challenges', authMiddleware, roleMiddleware(['PATIENT']), resolvePatientId, GamificationController.getDailyChallenges);

/** POST /api/gamification/challenges/:challengeId/complete — complete a challenge */
router.post('/challenges/:challengeId/complete', authMiddleware, roleMiddleware(['PATIENT']), resolvePatientId, GamificationController.completeChallenge);

/** GET /api/gamification/social-proof — anonymized peer activity stats */
router.get('/social-proof', authMiddleware, roleMiddleware(['PATIENT']), resolvePatientId, GamificationController.getSocialProof);

// ── Anti-gaming (admin) ──────────────────────────────────────────────────────

/** GET /api/gamification/anomalies — unresolved scoring anomalies */
router.get('/anomalies', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), GamificationController.getAnomalies);

/** PATCH /api/gamification/anomalies/:id/resolve — resolve an anomaly */
router.patch('/anomalies/:id/resolve', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), GamificationController.resolveAnomaly);

// ── Analytics (admin) ────────────────────────────────────────────────────────

/** GET /api/gamification/analytics — full analytics dashboard data */
router.get('/analytics', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), GamificationController.getAnalyticsOverview);

/** GET /api/gamification/analytics/correlation — score vs outcome correlation */
router.get('/analytics/correlation', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), GamificationController.getOutcomeCorrelation);

/** GET /api/gamification/analytics/config-impact — before/after config change impact */
router.get('/analytics/config-impact', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), GamificationController.getConfigImpact);

export default router;
