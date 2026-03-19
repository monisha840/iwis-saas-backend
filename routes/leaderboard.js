import prisma from '../lib/prisma.js';
import express from 'express';
import { LeaderboardService } from '../services/leaderboard.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const updateConfigSchema = z.object({
    appointmentWeight: z.number().min(0).max(1).optional(),
    adherenceWeight: z.number().min(0).max(1).optional(),
    responseTimeWeight: z.number().min(0).max(1).optional(),
    successRateWeight: z.number().min(0).max(1).optional(),
    consistencyWeight: z.number().min(0).max(1).optional(),
    targetAppointments: z.number().min(1).optional(),
    targetAdherence: z.number().min(0).max(100).optional(),
    targetSuccessRate: z.number().min(0).max(100).optional(),
    targetResponseTime: z.number().min(1).optional()
});

/**
 * GET /api/leaderboard
 * Fetch the current leaderboard rankings.
 *
 * Access rules:
 *   ADMIN / ADMIN_DOCTOR  — may pass ?branchId=<id> to filter; omit for global view
 *   DOCTOR / THERAPIST    — always scoped to their assigned branch (req.user.branchId);
 *                           any ?branchId query param is silently ignored to prevent
 *                           cross-branch data access via parameter manipulation.
 */
router.get('/', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), async (req, res, next) => {
    try {
        const isClinician = ['DOCTOR', 'THERAPIST'].includes(req.user.role);

        // For clinicians the branch is authoritative from the JWT — never from the query string.
        const branchId = isClinician
            ? (req.user.branchId || null)
            : (req.query.branchId || null);

        const leaderboard = await LeaderboardService.getLeaderboard(branchId);
        res.json(leaderboard);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/leaderboard/config
 * Fetch current scoring configuration
 */
router.get('/config', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const config = await LeaderboardService.getConfig();
        res.json(config);
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/leaderboard/config
 * Update scoring configuration (Admin only)
 */
router.patch('/config', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: updateConfigSchema }), async (req, res, next) => {
    try {
        const currentConfig = await LeaderboardService.getConfig();
        const updatedConfig = await prisma.leaderboardConfig.update({
            where: { id: currentConfig.id },
            data: req.body
        });
        res.json(updatedConfig);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/leaderboard/:id/breakdown
 * Fetch detailed score breakdown for a participant
 */
router.get('/:id/breakdown', authMiddleware, async (req, res, next) => {
    try {
        const isAdmin = ['ADMIN', 'ADMIN_DOCTOR'].includes(req.user.role);
        const isSelf = req.user.id === req.params.id; // Check if the authenticated user is the one requested

        // Note: For clinicians, req.user.id is the User ID. 
        // We need to verify if req.params.id matches their Profile ID or User ID.
        // Leaderboard typically uses profile IDs (Doctor/Therapist ID).

        let canAccess = isAdmin || isSelf;

        if (!canAccess) {
            const userProfile = req.user.role === 'DOCTOR'
                ? await prisma.doctor.findUnique({ where: { userId: req.user.id } })
                : await prisma.therapist.findUnique({ where: { userId: req.user.id } });

            if (userProfile?.id === req.params.id) canAccess = true;
        }

        if (!canAccess) {
            return res.status(403).json({ error: 'Forbidden: You can only view your own performance breakdown' });
        }

        const breakdown = await LeaderboardService.getParticipantBreakdown(req.params.id);
        res.json(breakdown);
    } catch (err) {
        next(err);
    }
});

export default router;
