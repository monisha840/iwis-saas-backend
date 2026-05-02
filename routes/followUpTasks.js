/**
 * Follow-Up Task HTTP routes (Feature 5).
 *
 * Mounted at /api/follow-up-tasks. Five endpoints:
 *   GET  /                  list (sorted HIGH → MEDIUM → LOW, then dueDate)
 *   GET  /summary           pending / overdue / highPriority counts
 *   PATCH /:id/complete     mark done + award XP
 *   PATCH /:id/status       set IN_PROGRESS / DISMISSED
 *   POST /                  manual create
 *
 * authMiddleware is applied at the mount point in index.js. Role gating uses
 * roleMiddleware with the same DOCTOR / ADMIN_DOCTOR allowlist used by the
 * other clinician-only routes (see voiceNote, healthReports).
 */

import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware, resolveDoctorId } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';
import prisma from '../lib/prisma.js';
import {
    createFollowUpTask,
    completeFollowUpTask,
    getDoctorTasks,
    getDoctorTaskSummary,
    updateFollowUpTaskStatus,
} from '../services/followUpTask.service.js';

const router = express.Router();

const TASK_ROLES = ['DOCTOR', 'ADMIN_DOCTOR'];

// ── Validation schemas ───────────────────────────────────────────────────────
const createSchema = z.object({
    patientId:   z.string().min(1, 'patientId is required'),
    title:       z.string().min(1).max(200),
    description: z.string().max(2000).optional().nullable(),
    priority:    z.enum(['HIGH', 'MEDIUM', 'LOW']).optional().default('MEDIUM'),
    dueDays:     z.coerce.number().int().min(0).max(365).optional().default(3),
});

const completeSchema = z.object({
    completionNote: z.string().max(2000).optional().nullable(),
});

const statusSchema = z.object({
    status: z.enum(['PENDING', 'IN_PROGRESS', 'DISMISSED']),
});

// ── Helper: resolve req.user → Doctor.id ────────────────────────────────────
//
// resolveDoctorId middleware sets req.user.doctorProfileId. ADMIN_DOCTOR
// users sometimes lack a Doctor row; we fall back to a direct lookup.
async function resolveCallerDoctorId(req) {
    if (req.user?.doctorProfileId) return req.user.doctorProfileId;
    const doc = await prisma.doctor.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
    });
    return doc?.id || null;
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.get(
    '/summary',
    roleMiddleware(TASK_ROLES),
    resolveDoctorId,
    async (req, res) => {
        try {
            const doctorId = await resolveCallerDoctorId(req);
            if (!doctorId) return res.status(400).json({ error: 'Calling user has no doctor profile' });
            const summary = await getDoctorTaskSummary(doctorId);
            res.json(summary);
        } catch (err) {
            logger.error('[followUpTasks.summary] failed', { err: err.message });
            res.status(500).json({ error: err.message });
        }
    },
);

router.get(
    '/',
    roleMiddleware(TASK_ROLES),
    resolveDoctorId,
    async (req, res) => {
        try {
            const doctorId = await resolveCallerDoctorId(req);
            if (!doctorId) return res.status(400).json({ error: 'Calling user has no doctor profile' });
            const tasks = await getDoctorTasks(doctorId, {
                status:   typeof req.query.status   === 'string' ? req.query.status   : undefined,
                priority: typeof req.query.priority === 'string' ? req.query.priority : undefined,
                date:     typeof req.query.date     === 'string' ? req.query.date     : undefined,
            });
            res.json(tasks);
        } catch (err) {
            logger.error('[followUpTasks.list] failed', { err: err.message });
            res.status(500).json({ error: err.message });
        }
    },
);

router.patch(
    '/:id/complete',
    roleMiddleware(TASK_ROLES),
    resolveDoctorId,
    validate({ body: completeSchema }),
    async (req, res) => {
        const { id } = req.params;
        try {
            const doctorId = await resolveCallerDoctorId(req);
            if (!doctorId) return res.status(400).json({ error: 'Calling user has no doctor profile' });

            // Ownership check — task must belong to the calling doctor.
            const existing = await prisma.followUpTask.findUnique({
                where: { id },
                select: { id: true, doctorId: true, status: true },
            });
            if (!existing) return res.status(404).json({ error: 'Task not found' });
            if (existing.doctorId !== doctorId) return res.status(403).json({ error: 'Forbidden' });

            const result = await completeFollowUpTask(id, req.user.id, req.body.completionNote);
            res.json({
                success: true,
                task:       result.task,
                xpAmount:   result.xpAmount,
                xpAwarded:  result.xpAwarded,
            });
        } catch (err) {
            logger.error('[followUpTasks.complete] failed', { err: err.message, id });
            res.status(err.status || 500).json({ error: err.message });
        }
    },
);

router.patch(
    '/:id/status',
    roleMiddleware(TASK_ROLES),
    resolveDoctorId,
    validate({ body: statusSchema }),
    async (req, res) => {
        const { id } = req.params;
        try {
            const doctorId = await resolveCallerDoctorId(req);
            if (!doctorId) return res.status(400).json({ error: 'Calling user has no doctor profile' });

            const existing = await prisma.followUpTask.findUnique({
                where: { id },
                select: { id: true, doctorId: true },
            });
            if (!existing) return res.status(404).json({ error: 'Task not found' });
            if (existing.doctorId !== doctorId) return res.status(403).json({ error: 'Forbidden' });

            const updated = await updateFollowUpTaskStatus(id, req.body.status);
            res.json(updated);
        } catch (err) {
            logger.error('[followUpTasks.status] failed', { err: err.message, id });
            res.status(err.status || 500).json({ error: err.message });
        }
    },
);

router.post(
    '/',
    roleMiddleware(TASK_ROLES),
    resolveDoctorId,
    validate({ body: createSchema }),
    async (req, res) => {
        try {
            const doctorId = await resolveCallerDoctorId(req);
            if (!doctorId) return res.status(400).json({ error: 'Calling user has no doctor profile' });

            // Verify the patient exists before creating — gives a clearer
            // 404 than the Prisma FK violation we'd get otherwise.
            const patient = await prisma.patient.findUnique({
                where: { id: req.body.patientId },
                select: { id: true },
            });
            if (!patient) return res.status(404).json({ error: 'Patient not found' });

            const result = await createFollowUpTask({
                doctorId,
                patientId:   req.body.patientId,
                title:       req.body.title,
                description: req.body.description,
                priority:    req.body.priority,
                dueDays:     req.body.dueDays,
                triggerType: 'MANUAL',
                triggerRef:  null,
            });
            res.status(result.alreadyExisted ? 200 : 201).json({
                success: true,
                alreadyExisted: result.alreadyExisted,
                task: result.task,
            });
        } catch (err) {
            logger.error('[followUpTasks.create] failed', { err: err.message });
            res.status(err.status || 500).json({ error: err.message });
        }
    },
);

export default router;
