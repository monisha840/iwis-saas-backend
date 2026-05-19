/**
 * Workflow Automation Rules HTTP routes (Feature 3).
 *
 * Mounted at /api/workflow-rules. Six endpoints, all branch-scoped:
 *   GET    /                  list branch's rules + log counts + last fired
 *   POST   /                  create
 *   PATCH  /:id               update (toggle active, edit fields, etc.)
 *   DELETE /:id               delete (cascades to logs + cooldowns)
 *   GET    /:id/logs          paginated firing history with patient name
 *   POST   /evaluate-now      ADMIN-only manual sweep, fire-and-forget
 *
 * authMiddleware is applied at the mount point in index.js. Per-route role
 * gating uses roleMiddleware. Branch scope is enforced inside each handler.
 */

import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';
import prisma from '../lib/prisma.js';
import {
    VALID_TRIGGER_TYPES,
    VALID_ACTION_TYPES,
    validateConditionValue,
    validateActions,
    evaluateAllRules,
} from '../services/workflowEngine.service.js';

const router = express.Router();

const ADMIN_ROLES = ['ADMIN', 'ADMIN_DOCTOR'];

// ── Validation schemas ──────────────────────────────────────────────────────
//
// Zod handles the base structural check; the deeper per-trigger / per-action
// validation lives in workflowEngine.service.validate* (called inside the
// handler) so the engine and the route share one source of truth.

// PHASE_COMPLETED removed in audit fix #1 — the cron engine never fired it
// (no event hook in journey.service.js calls back here), so rules created
// with that trigger were silently dead. Now rejected at the API boundary
// in addition to being absent from the dropdown.
const triggerEnum = z.enum([
    'NO_CHECKIN',
    'PAIN_NOT_IMPROVING',
    'DIET_ADHERENCE_LOW',
    'PHASE_OVERDUE',
    'PRESCRIPTION_UNCOLLECTED',
]);

const createSchema = z.object({
    name:           z.string().min(1).max(200),
    description:    z.string().max(2000).optional().nullable(),
    triggerType:    triggerEnum,
    conditionValue: z.record(z.any()),
    actions:        z.array(z.record(z.any())).min(1, 'At least one action is required'),
    cooldownHours:  z.coerce.number().int().min(0).max(24 * 30).optional().default(48),
});

const updateSchema = z.object({
    name:           z.string().min(1).max(200).optional(),
    description:    z.string().max(2000).optional().nullable(),
    conditionValue: z.record(z.any()).optional(),
    actions:        z.array(z.record(z.any())).min(1).optional(),
    cooldownHours:  z.coerce.number().int().min(0).max(24 * 30).optional(),
    isActive:       z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve the calling user's branchId. Bails if missing — admins must be branch-scoped. */
async function resolveCallerBranchId(req) {
    if (req.user?.branchId) return req.user.branchId;
    const u = await prisma.user.findUnique({
        where:  { id: req.user.id },
        select: { branchId: true },
    });
    return u?.branchId || null;
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.get(
    '/',
    roleMiddleware(ADMIN_ROLES),
    async (req, res) => {
        try {
            const branchId = await resolveCallerBranchId(req);
            if (!branchId) return res.status(400).json({ error: 'Calling user has no branch' });

            const rules = await prisma.workflowRule.findMany({
                where: { branchId },
                orderBy: { createdAt: 'desc' },
                include: {
                    _count: { select: { logs: true, cooldowns: true } },
                },
            });
            res.json(rules);
        } catch (err) {
            logger.error('[workflowRules.list] failed', { err: err.message });
            res.status(500).json({ error: err.message });
        }
    },
);

router.post(
    '/',
    roleMiddleware(ADMIN_ROLES),
    validate({ body: createSchema }),
    async (req, res) => {
        try {
            const branchId = await resolveCallerBranchId(req);
            if (!branchId) return res.status(400).json({ error: 'Calling user has no branch' });

            // Deeper structural validation that lives in the engine (single
            // source of truth for trigger + action shapes).
            try {
                validateConditionValue(req.body.triggerType, req.body.conditionValue);
                validateActions(req.body.actions);
            } catch (validationErr) {
                return res.status(validationErr.status || 400).json({ error: validationErr.message });
            }

            const created = await prisma.workflowRule.create({
                data: {
                    branchId,
                    name:           req.body.name,
                    description:    req.body.description || null,
                    triggerType:    req.body.triggerType,
                    conditionValue: req.body.conditionValue,
                    actions:        req.body.actions,
                    cooldownHours:  req.body.cooldownHours ?? 48,
                    isActive:       true,
                },
            });
            res.status(201).json(created);
        } catch (err) {
            logger.error('[workflowRules.create] failed', { err: err.message });
            res.status(err.status || 500).json({ error: err.message });
        }
    },
);

router.patch(
    '/:id',
    roleMiddleware(ADMIN_ROLES),
    validate({ body: updateSchema }),
    async (req, res) => {
        const { id } = req.params;
        try {
            const branchId = await resolveCallerBranchId(req);
            if (!branchId) return res.status(400).json({ error: 'Calling user has no branch' });

            const existing = await prisma.workflowRule.findUnique({
                where: { id },
                select: { id: true, branchId: true, triggerType: true },
            });
            if (!existing) return res.status(404).json({ error: 'Rule not found' });
            if (existing.branchId !== branchId) return res.status(403).json({ error: 'Forbidden' });

            // If the caller is editing conditionValue / actions, run the
            // engine-side structural checks.
            try {
                if (req.body.conditionValue !== undefined) {
                    validateConditionValue(existing.triggerType, req.body.conditionValue);
                }
                if (req.body.actions !== undefined) {
                    validateActions(req.body.actions);
                }
            } catch (validationErr) {
                return res.status(validationErr.status || 400).json({ error: validationErr.message });
            }

            const updated = await prisma.workflowRule.update({
                where: { id },
                data: {
                    ...(req.body.name           !== undefined ? { name:           req.body.name } : {}),
                    ...(req.body.description    !== undefined ? { description:    req.body.description } : {}),
                    ...(req.body.conditionValue !== undefined ? { conditionValue: req.body.conditionValue } : {}),
                    ...(req.body.actions        !== undefined ? { actions:        req.body.actions } : {}),
                    ...(req.body.cooldownHours  !== undefined ? { cooldownHours:  req.body.cooldownHours } : {}),
                    ...(req.body.isActive       !== undefined ? { isActive:       req.body.isActive } : {}),
                },
            });
            res.json(updated);
        } catch (err) {
            logger.error('[workflowRules.update] failed', { err: err.message, id });
            res.status(err.status || 500).json({ error: err.message });
        }
    },
);

router.delete(
    '/:id',
    roleMiddleware(ADMIN_ROLES),
    async (req, res) => {
        const { id } = req.params;
        try {
            const branchId = await resolveCallerBranchId(req);
            if (!branchId) return res.status(400).json({ error: 'Calling user has no branch' });

            const existing = await prisma.workflowRule.findUnique({
                where: { id },
                select: { id: true, branchId: true },
            });
            if (!existing) return res.status(404).json({ error: 'Rule not found' });
            if (existing.branchId !== branchId) return res.status(403).json({ error: 'Forbidden' });

            // onDelete: Cascade on WorkflowRuleLog + WorkflowCooldown handles
            // cleanup automatically (see schema). Single delete is enough.
            await prisma.workflowRule.delete({ where: { id } });
            res.json({ success: true });
        } catch (err) {
            logger.error('[workflowRules.delete] failed', { err: err.message, id });
            res.status(err.status || 500).json({ error: err.message });
        }
    },
);

router.get(
    '/:id/logs',
    roleMiddleware(ADMIN_ROLES),
    async (req, res) => {
        const { id } = req.params;
        const page  = Math.max(1,  Number(req.query.page)  || 1);
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
        try {
            const branchId = await resolveCallerBranchId(req);
            if (!branchId) return res.status(400).json({ error: 'Calling user has no branch' });

            const rule = await prisma.workflowRule.findUnique({
                where: { id },
                select: { id: true, branchId: true, name: true, totalFired: true },
            });
            if (!rule) return res.status(404).json({ error: 'Rule not found' });
            if (rule.branchId !== branchId) return res.status(403).json({ error: 'Forbidden' });

            const skip = (page - 1) * limit;
            const [logs, total] = await Promise.all([
                prisma.workflowRuleLog.findMany({
                    where: { ruleId: id },
                    orderBy: { triggeredAt: 'desc' },
                    skip,
                    take: limit,
                    include: {
                        patient: {
                            select: {
                                id: true,
                                fullName: true,
                                user: { select: { email: true } },
                            },
                        },
                    },
                }),
                prisma.workflowRuleLog.count({ where: { ruleId: id } }),
            ]);

            const mapped = logs.map((l) => ({
                id:           l.id,
                triggeredAt:  l.triggeredAt,
                patientId:    l.patientId,
                patientName:  l.patient?.fullName || l.patient?.user?.email || 'Unknown',
                actionsTaken: l.actionsTaken,
            }));

            res.json({
                logs: mapped,
                total,
                page,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            });
        } catch (err) {
            logger.error('[workflowRules.logs] failed', { err: err.message, id });
            res.status(500).json({ error: err.message });
        }
    },
);

router.post(
    '/evaluate-now',
    // ADMIN only per spec — ADMIN_DOCTOR isn't allowed here so a clinician
    // can't accidentally fan out WhatsApp messages while testing.
    roleMiddleware(['ADMIN']),
    async (req, res) => {
        try {
            const branchId = await resolveCallerBranchId(req);
            if (!branchId) return res.status(400).json({ error: 'Calling user has no branch' });

            // Fire-and-forget — never block the response on a full sweep.
            // Errors land in the engine's own logger.
            evaluateAllRules({ branchId }).catch((err) =>
                logger.warn('[workflowRules.evaluateNow] background sweep failed', { err: err.message, branchId }),
            );
            res.json({ success: true, message: 'Evaluation triggered' });
        } catch (err) {
            logger.error('[workflowRules.evaluateNow] failed', { err: err.message });
            res.status(500).json({ error: err.message });
        }
    },
);

export default router;
