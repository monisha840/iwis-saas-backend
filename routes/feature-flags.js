import express from 'express';
import { z } from 'zod';
import { FeatureFlagService } from '../services/feature-flag.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const upsertFlagSchema = z.object({
    enabled:         z.boolean(),
    description:     z.string().max(300).optional(),
    allowedRoles:    z.array(z.string()).optional().default([]),
    allowedBranches: z.array(z.string()).optional().default([]),
});

/**
 * GET /api/feature-flags
 * Returns all flags — public (enabled status only) for authenticated users,
 * full metadata for ADMIN/ADMIN_DOCTOR.
 */
router.get('/', authMiddleware, async (req, res, next) => {
    try {
        const isAdmin = ['ADMIN', 'ADMIN_DOCTOR'].includes(req.user.role);

        if (isAdmin) {
            const flags = await FeatureFlagService.listAll();
            return res.json(flags);
        }

        // Non-admins: only receive scoped enabled/disabled status
        const flags = await FeatureFlagService.listAll();
        const filtered = flags.map(f => ({
            key:     f.key,
            enabled: f.enabled && (
                (f.allowedRoles.length === 0 || f.allowedRoles.includes(req.user.role)) &&
                (f.allowedBranches.length === 0 || f.allowedBranches.includes(req.user.branchId))
            ),
        }));
        res.json(filtered);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/feature-flags/:key
 * Check a single flag in user context — primarily for client-side hooks.
 */
router.get('/:key', authMiddleware, async (req, res, next) => {
    try {
        const enabled = await FeatureFlagService.isEnabled(req.params.key, {
            role:     req.user.role,
            branchId: req.user.branchId,
        });
        res.json({ key: req.params.key, enabled });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/feature-flags/:key
 * Create or update a flag — ADMIN only.
 */
router.put('/:key',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    validate({ body: upsertFlagSchema }),
    async (req, res, next) => {
        try {
            const flag = await FeatureFlagService.upsert({ key: req.params.key, ...req.body });
            res.json(flag);
        } catch (err) {
            next(err);
        }
    }
);

/**
 * PATCH /api/feature-flags/:key/toggle
 * Quick toggle on/off — ADMIN only.
 */
router.patch('/:key/toggle',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            const flag = await FeatureFlagService.toggle(req.params.key);
            res.json(flag);
        } catch (err) {
            next(err);
        }
    }
);

/**
 * DELETE /api/feature-flags/:key — ADMIN only.
 */
router.delete('/:key',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            await FeatureFlagService.delete(req.params.key);
            res.json({ message: `Flag "${req.params.key}" deleted` });
        } catch (err) {
            next(err);
        }
    }
);

export default router;
