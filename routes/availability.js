
import express from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { AvailabilityService } from '../services/availability.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';


const router = express.Router();

const BLOCK_KINDS = ['LEAVE', 'WFH', 'OFF', 'OTHER'];

const createBlockSchema = z.object({
    doctorId: z.string().uuid().optional(),
    therapistId: z.string().uuid().optional(),
    date: z.string().optional(), // ISO Date string
    dayOfWeek: z.number().min(0).max(6).optional(),
    startTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format HH:mm'),
    endTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format HH:mm'),
    reason: z.string().optional(),
    // Classification consumed by the nightly attendance reconciliation —
    // LEAVE / WFH become planned-unavailability statuses automatically.
    kind: z.enum(BLOCK_KINDS).optional(),
}).refine(data => data.date || data.dayOfWeek !== undefined, {
    message: "Either date or dayOfWeek must be provided"
}).refine(data => data.doctorId || data.therapistId, {
    message: "Either doctorId or therapistId must be provided"
});

const updateBlockSchema = z.object({
    date: z.string().optional(),
    dayOfWeek: z.number().min(0).max(6).optional(),
    startTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format HH:mm').optional(),
    endTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format HH:mm').optional(),
    reason: z.string().optional(),
    kind: z.enum(BLOCK_KINDS).optional(),
});

router.post('/block', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), validate({ body: createBlockSchema }), async (req, res, next) => {
    try {
        const { doctorId, therapistId } = req.body;
        const isAdmin = ['ADMIN', 'ADMIN_DOCTOR'].includes(req.user.role);

        // Security check: Clinicians can only block for themselves
        if (!isAdmin) {
            if (req.user.role === 'DOCTOR') {
                const doc = await prisma.doctor.findUnique({ where: { userId: req.user.id } });
                if (doctorId !== doc?.id) return res.status(403).json({ message: "Forbidden: You can only block your own availability" });
            } else if (req.user.role === 'THERAPIST') {
                const ther = await prisma.therapist.findUnique({ where: { userId: req.user.id } });
                if (therapistId !== ther?.id) return res.status(403).json({ message: "Forbidden: You can only block your own availability" });
            }
        }

        const block = await AvailabilityService.createBlock(req.body);
        res.status(201).json(block);
    } catch (err) {
        next(err);
    }
});

router.put('/block/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), validate({ body: updateBlockSchema }), async (req, res, next) => {
    try {
        const isAdmin = ['ADMIN', 'ADMIN_DOCTOR'].includes(req.user.role);

        const existing = await prisma.blockedSlot.findUnique({ where: { id: req.params.id } });
        if (!existing) return res.status(404).json({ message: "Block not found" });

        if (!isAdmin) {
            if (req.user.role === 'DOCTOR') {
                const doc = await prisma.doctor.findUnique({ where: { userId: req.user.id } });
                if (existing.doctorId !== doc?.id) return res.status(403).json({ message: "Forbidden" });
            } else if (req.user.role === 'THERAPIST') {
                const ther = await prisma.therapist.findUnique({ where: { userId: req.user.id } });
                if (existing.therapistId !== ther?.id) return res.status(403).json({ message: "Forbidden" });
            }
        }

        const block = await AvailabilityService.updateBlock(req.params.id, req.body);
        res.json(block);
    } catch (err) {
        next(err);
    }
});

router.delete('/block/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), async (req, res, next) => {
    try {
        const isAdmin = ['ADMIN', 'ADMIN_DOCTOR'].includes(req.user.role);
        if (!isAdmin) {
            const block = await prisma.blockedSlot.findUnique({ where: { id: req.params.id } });
            if (!block) return res.status(404).json({ message: "Block not found" });

            if (req.user.role === 'DOCTOR') {
                const doc = await prisma.doctor.findUnique({ where: { userId: req.user.id } });
                if (block.doctorId !== doc?.id) return res.status(403).json({ message: "Forbidden" });
            } else if (req.user.role === 'THERAPIST') {
                const ther = await prisma.therapist.findUnique({ where: { userId: req.user.id } });
                if (block.therapistId !== ther?.id) return res.status(403).json({ message: "Forbidden" });
            }
        }

        await AvailabilityService.deleteBlock(req.params.id);
        res.json({ message: 'Block removed successfully' });
    } catch (err) {
        next(err);
    }
});

router.get('/:doctorId', authMiddleware, async (req, res, next) => {
    try {
        // BRANCH_ADMIN may only view availability for clinicians in their own
        // branch. The :doctorId path param is matched against Doctor.id first,
        // and Therapist.id as a fallback for therapist availability lookups.
        if (req.user.role === 'BRANCH_ADMIN') {
            const [doc, ther] = await Promise.all([
                prisma.doctor.findUnique({ where: { id: req.params.doctorId }, include: { user: { select: { branchId: true } } } }),
                prisma.therapist.findUnique({ where: { id: req.params.doctorId }, include: { user: { select: { branchId: true } } } }),
            ]);
            const targetBranchId = doc?.user?.branchId ?? ther?.user?.branchId ?? null;
            if (!targetBranchId || targetBranchId !== req.user.branchId) {
                return res.status(403).json({ error: 'Forbidden: clinician is not in your branch' });
            }
        }
        const blocks = await AvailabilityService.getBlocks(req.params.doctorId);
        res.json(blocks);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/availability/check?doctorId=X&date=YYYY-MM-DD
 *
 * Lightweight pre-flight check used by the patient booking flow: does this
 * doctor have ANY available slot on the requested date, and if not, what's
 * the nearest future date that does (within 30 days)?
 *
 * Wraps AvailabilityService.getAvailableSlots — no new query logic, just a
 * boolean projection + a 30-day forward scan.
 */
const checkSchema = z.object({
    doctorId: z.string().min(1, 'doctorId is required'),
    date: z.string().optional(), // ISO YYYY-MM-DD; defaults to today
});
router.get('/check', authMiddleware, validate({ query: checkSchema }), async (req, res, next) => {
    try {
        const { doctorId, date } = req.query;
        const baseDate = date ? new Date(date) : new Date();
        if (Number.isNaN(baseDate.getTime())) {
            return res.status(400).json({ error: 'Invalid date' });
        }
        baseDate.setHours(0, 0, 0, 0);

        const slots = await AvailabilityService.getAvailableSlots(doctorId, baseDate);
        const hasAvailableSlots = slots.some((s) => s.status === 'AVAILABLE');
        if (hasAvailableSlots) {
            return res.json({ hasAvailableSlots: true, nextAvailable: null });
        }

        // Forward scan up to 30 days. Each iteration is ~2 queries; bounded so
        // a permanently-unavailable doctor can't blow up the request budget.
        for (let i = 1; i <= 30; i++) {
            const probe = new Date(baseDate);
            probe.setDate(probe.getDate() + i);
            const probeSlots = await AvailabilityService.getAvailableSlots(doctorId, probe);
            if (probeSlots.some((s) => s.status === 'AVAILABLE')) {
                return res.json({
                    hasAvailableSlots: false,
                    nextAvailable: probe.toISOString().slice(0, 10),
                });
            }
        }
        res.json({ hasAvailableSlots: false, nextAvailable: null });
    } catch (err) { next(err); }
});

// Availability check by User.id — used by resource-sharing to verify a
// clinician is free before submitting a cross-branch share. Query params:
// ?date=YYYY-MM-DD&startTime=HH:mm&endTime=HH:mm. Returns `{ available, reason? }`.
const availabilityCheckSchema = z.object({
    date: z.string().min(1, 'date is required'),
    startTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid HH:mm'),
    endTime:   z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid HH:mm'),
});
router.get('/user/:userId/check', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']), validate({ query: availabilityCheckSchema }), async (req, res, next) => {
    try {
        if (req.user.role === 'BRANCH_ADMIN') {
            const target = await prisma.user.findUnique({
                where: { id: req.params.userId },
                select: { branchId: true },
            });
            if (!target || target.branchId !== req.user.branchId) {
                return res.status(403).json({ error: 'Forbidden: user is not in your branch' });
            }
        }
        const { date, startTime, endTime } = req.query;
        const result = await AvailabilityService.checkAvailabilityForUser(req.params.userId, date, startTime, endTime);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

export default router;
