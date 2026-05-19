
import express from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { AvailabilityService } from '../services/availability.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';


const router = express.Router();

const BLOCK_KINDS = ['LEAVE', 'WFH', 'OFF', 'OTHER'];

// All IWIS clinics operate on India Standard Time (UTC+05:30). Slot labels
// like "09:00".."17:30" mean 9 AM to 5:30 PM IST, not UTC. Anchoring the
// slot's instant to IST is what makes "is this slot in the past?" agree
// with the receptionist's wall-clock. If the platform ever serves clinics
// outside India this becomes a per-hospital column on `Hospital` / `Branch`.
const CLINIC_TZ_OFFSET = '+05:30';

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

/**
 * GET /api/availability/slots?doctorId=X&date=YYYY-MM-DD
 *
 * Slot grid for the Walk-In booking modal (Step 4). Builds on
 * AvailabilityService.getAvailableSlots — same 9-18 UTC window, 30-min
 * cadence, BlockedSlot + Appointment overlap detection — and reshapes the
 * result into the contract walkInBooking.service.ts consumes:
 *
 *   { slots: [{ time, dateTime, status: AVAILABLE|BOOKED|BLOCKED|PAST, blockReason? }],
 *     nextAvailable: "HH:mm" | null,
 *     doctorId, date, dayOfWeek,
 *     workingHours: { start, end } }
 *
 * IMPORTANT — registered BEFORE the `/:doctorId` catch-all below. Without
 * that ordering, Express would resolve `/slots` as `doctorId="slots"` and
 * return getBlocks() results, which is what was producing the misleading
 * "No working hours configured for this clinician on this date." empty
 * state on the frontend (the call was 200-but-wrong-shape, not 404).
 */
const slotsQuerySchema = z.object({
    doctorId: z.string().min(1, 'doctorId is required'),
    date:     z.string().min(1, 'date is required'),
});
router.get('/slots', authMiddleware, validate({ query: slotsQuerySchema }), async (req, res, next) => {
    try {
        const { doctorId, date } = req.query;
        // Robust YYYY-MM-DD parse — we explicitly construct a UTC-midnight
        // Date instead of `new Date(date)`+`setHours(0,0,0,0)` because the
        // latter is a timezone trap: on a non-UTC server (e.g. India is
        // UTC+5:30), `new Date("2026-05-19")` parses as UTC midnight, then
        // setHours uses LOCAL midnight, shifting the instant back to
        // "2026-05-18T18:30:00Z" — every downstream `toISOString().slice(0,10)`
        // and `getDay()` then ran against the wrong day, producing slot
        // dateTimes that were always 24h before "now" and marking the entire
        // grid as PAST. UTC construction sidesteps the whole problem.
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date).trim());
        if (!m) {
            return res.status(400).json({ error: 'INVALID_DATE', message: 'Invalid date — expected YYYY-MM-DD' });
        }
        const yyyy = Number(m[1]);
        const mm   = Number(m[2]);
        const dd   = Number(m[3]);
        const baseDate = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0));
        if (Number.isNaN(baseDate.getTime())) {
            return res.status(400).json({ error: 'INVALID_DATE', message: 'Invalid date — expected YYYY-MM-DD' });
        }

        const rawSlots = await AvailabilityService.getAvailableSlots(doctorId, baseDate);
        const now = new Date();
        // `getUTCDay` instead of `getDay` so the dayOfWeek is independent of
        // the server's local timezone — matters when the upstream service
        // looks up recurring BlockedSlot rows keyed on dayOfWeek.
        const dayOfWeek = baseDate.getUTCDay();
        const ymd = `${m[1]}-${m[2]}-${m[3]}`;

        const slots = rawSlots.map((s) => {
            // Anchor the slot's instant in the clinic's timezone (IST) so
            // that the past-check matches the wall-clock the receptionist
            // sees. Without the +05:30 offset, "09:30" would be read as
            // 09:30 UTC (= 15:00 IST), which made every morning slot look
            // like it was still in the future to a viewer at 14:30 IST.
            const dateTime = new Date(`${ymd}T${s.startTime}:00${CLINIC_TZ_OFFSET}`);
            const isPast = dateTime.getTime() < now.getTime();
            return {
                time: s.startTime,
                dateTime: dateTime.toISOString(),
                // PAST takes priority over AVAILABLE — we never want to let the
                // doctor walk a patient into a slot that has already elapsed.
                // Existing BOOKED / BLOCKED rows stay as-is so the admin
                // override flow can still see them.
                status: isPast && s.status === 'AVAILABLE' ? 'PAST' : s.status,
                blockReason: s.reason || undefined,
            };
        });

        const nextAvailable = slots.find((s) => s.status === 'AVAILABLE')?.time ?? null;

        res.json({
            slots,
            nextAvailable,
            doctorId,
            date: ymd,
            dayOfWeek,
            // Working hours are global constants in availability.service.js
            // (CLINICAL_DAY_START / CLINICAL_DAY_END) — surfaced here so the
            // UI can label the grid even if the slot array is empty.
            workingHours: { start: '09:00', end: '18:00' },
        });
    } catch (err) { next(err); }
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
