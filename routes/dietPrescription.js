import express from 'express';
import { z } from 'zod';
import { DietPrescriptionService } from '../services/dietPrescription.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { notificationService } from '../services/notification.service.js';
import { notificationQueue } from '../services/queue.service.js';
import { emitToUser } from '../websocket/index.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature('DIET_PRESCRIPTION'));

const mealSchema = z.object({
    mealTime: z.enum(['MORNING_EMPTY','BREAKFAST','MID_MORNING','LUNCH','EVENING','DINNER','BEDTIME']),
    foods: z.array(z.object({ name: z.string(), quantity: z.string().optional(), unit: z.string().optional(), notes: z.string().optional() })).default([]),
    avoidFoods: z.array(z.object({ name: z.string(), reason: z.string().optional() })).default([]),
    instructions: z.string().optional(),
});

const createSchema = z.object({
    patientId: z.string(),
    doctorId:  z.string(),
    title:     z.string().min(2),
    doshaTarget: z.enum(['VATA','PITTA','KAPHA','TRIDOSHA']),
    category:    z.enum(['SATTVIC','RAJASIC','TAMASIC']),
    startDate:   z.coerce.date(),
    endDate:     z.coerce.date().optional(),
    notes:       z.string().optional(),
    journeyId:   z.string().optional(),
    meals:       z.array(mealSchema).default([]),
});

router.post('/', authorizeRoles('DOCTOR', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = createSchema.parse(req.body);
        const p = await DietPrescriptionService.create(data);

        // Notify the patient. Best-effort fan-out: every channel is wrapped
        // so a flaky Redis or missing user record never poisons the create
        // response — the doctor's UI must see "Diet plan assigned" instantly.
        notifyPatientOfDietAssignment(p).catch((err) => {
            logger.warn('[DietPrescription] notifyPatient fan-out failed', { id: p.id, err: err.message });
        });

        res.status(201).json(p);
    } catch (err) { next(err); }
});

/** Fan-out side effects after a doctor assigns a diet plan. Runs detached
 *  from the request so notification flakiness never blocks the doctor. */
async function notifyPatientOfDietAssignment(prescription) {
    const patient = await prisma.patient.findUnique({
        where: { id: prescription.patientId },
        select: {
            userId: true,
            user: {
                select: {
                    notificationPreference: { select: { whatsappEnabled: true, whatsappNumber: true } },
                },
            },
        },
    });
    if (!patient?.userId) return;

    const doctor = await prisma.doctor.findUnique({
        where: { id: prescription.doctorId },
        select: { fullName: true },
    });
    const doctorName = doctor?.fullName ? `Dr. ${doctor.fullName}` : 'Your doctor';
    const message = `${doctorName} has assigned a new diet plan: ${prescription.title}`;

    // 1) In-app notification (also emits 'new_notification' via socket).
    try {
        await notificationService.createNotification({
            userId: patient.userId,
            type: 'DIET_ASSIGNED',
            title: 'New diet plan assigned',
            message,
            priority: 'MEDIUM',
            data: { prescriptionId: prescription.id, title: prescription.title },
            relatedId: prescription.id,
        });
    } catch (err) {
        logger.warn('[DietPrescription] in-app notify failed', { err: err.message });
    }

    // 2) Targeted socket event the wellness page subscribes to. The generic
    //    'new_notification' above also lands; this one is dedicated so the
    //    wellness page can refetch the diet list without filtering by type.
    try {
        emitToUser(patient.userId, 'diet_assigned', {
            prescriptionId: prescription.id,
            title: prescription.title,
        });
    } catch (err) {
        logger.warn('[DietPrescription] socket emit failed', { err: err.message });
    }

    // 3) WhatsApp via BullMQ when the patient has opted in. No-op when
    //    Redis is down or prefs are off — graceful degradation matches the
    //    rest of the notification pipeline.
    const prefs = patient.user?.notificationPreference;
    if (prefs?.whatsappEnabled && prefs.whatsappNumber) {
        try {
            await notificationQueue.add('whatsapp', {
                number: prefs.whatsappNumber,
                text: message,
            });
        } catch (err) {
            logger.warn('[DietPrescription] whatsapp enqueue failed', { err: err.message });
        }
    }
}

router.get('/', async (req, res, next) => {
    try {
        // The Diet Plans search bar calls this without a patientId. When
        // `search` is provided we dispatch to the role-scoped cross-patient
        // search; otherwise the per-patient list still requires patientId.
        const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
        if (search) {
            return res.json(await DietPrescriptionService.search({ search, user: req.user }));
        }
        if (!req.query.patientId) return res.status(400).json({ error: 'patientId is required' });
        res.json(await DietPrescriptionService.listForPatient(req.query.patientId));
    } catch (err) { next(err); }
});

/** Resolve a prescription + verify the caller is allowed to mutate it.
 *  ADMIN_DOCTOR may touch any prescription; DOCTOR may only touch their own
 *  (Doctor.id matches DietPrescription.doctorId).
 *  Reads the id from `req.params.id` by default; nested routes pass
 *  `prescriptionId` instead. */
async function _loadOwnedPrescription(req, res, paramName = 'id') {
    const { default: prisma } = await import('../lib/prisma.js');
    const presc = await prisma.dietPrescription.findUnique({
        where: { id: req.params[paramName] },
        select: { id: true, doctorId: true },
    });
    if (!presc) {
        res.status(404).json({ error: 'Diet prescription not found' });
        return null;
    }
    if (req.user.role === 'ADMIN_DOCTOR') return presc;
    const doctor = await prisma.doctor.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
    });
    if (!doctor || doctor.id !== presc.doctorId) {
        res.status(403).json({ error: 'You can only edit your own diet prescriptions' });
        return null;
    }
    return presc;
}

router.put('/:id', authorizeRoles('DOCTOR', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const owned = await _loadOwnedPrescription(req, res);
        if (!owned) return;
        const data = createSchema.partial().parse(req.body);
        res.json(await DietPrescriptionService.update(req.params.id, data));
    } catch (err) { next(err); }
});

router.delete('/:id', authorizeRoles('DOCTOR', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const owned = await _loadOwnedPrescription(req, res);
        if (!owned) return;
        const result = await DietPrescriptionService.delete(req.params.id);
        const message = result.mode === 'soft'
            ? 'Prescription deactivated to preserve adherence history'
            : 'Diet prescription deleted';
        res.json({ ...result, message });
    } catch (err) { next(err); }
});

// ── Per-meal CRUD (Feature 2) ──────────────────────────────────────────────
router.post('/:id/meals', authorizeRoles('DOCTOR', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const owned = await _loadOwnedPrescription(req, res);
        if (!owned) return;
        const data = mealSchema.parse(req.body);
        const meal = await DietPrescriptionService.addMeal(req.params.id, data);
        res.status(201).json(meal);
    } catch (err) {
        if (err.status === 409 && err.code === 'DUPLICATE_MEAL_SLOT') {
            return res.status(409).json({ error: err.message, code: err.code });
        }
        next(err);
    }
});

const mealUpdateSchema = z.object({
    foods:        z.array(z.object({ name: z.string(), quantity: z.string().optional(), unit: z.string().optional(), notes: z.string().optional() })).optional(),
    avoidFoods:   z.array(z.object({ name: z.string(), reason: z.string().optional() })).optional(),
    instructions: z.string().optional(),
});

router.put('/:prescriptionId/meals/:mealId', authorizeRoles('DOCTOR', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const owned = await _loadOwnedPrescription(req, res, 'prescriptionId');
        if (!owned) return;
        const data = mealUpdateSchema.parse(req.body);
        const updated = await DietPrescriptionService.updateMeal(req.params.prescriptionId, req.params.mealId, data);
        res.json(updated);
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message });
        next(err);
    }
});

router.delete('/:prescriptionId/meals/:mealId', authorizeRoles('DOCTOR', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const owned = await _loadOwnedPrescription(req, res, 'prescriptionId');
        if (!owned) return;
        await DietPrescriptionService.deleteMeal(req.params.prescriptionId, req.params.mealId);
        res.json({ success: true });
    } catch (err) {
        if (err.status === 400 && err.code === 'LAST_MEAL') {
            return res.status(400).json({ error: err.message, code: err.code });
        }
        if (err.status === 404) return res.status(404).json({ error: err.message });
        next(err);
    }
});

router.get('/:id/today', async (req, res, next) => {
    try {
        const plan = await DietPrescriptionService.getTodayPlan(req.params.id);
        if (!plan) return res.status(404).json({ error: 'Not found' });
        res.json(plan);
    } catch (err) { next(err); }
});

const logSchema = z.object({
    patientId: z.string(),
    mealTime:  z.enum(['MORNING_EMPTY','BREAKFAST','MID_MORNING','LUNCH','EVENING','DINNER','BEDTIME']),
    followed:  z.boolean(),
    notes:     z.string().optional(),
    date:      z.coerce.date().optional(),
});

router.post('/:id/log', async (req, res, next) => {
    try {
        const data = logSchema.parse(req.body);
        const out = await DietPrescriptionService.logAdherence({ prescriptionId: req.params.id, ...data });
        res.status(201).json(out);
    } catch (err) { next(err); }
});

router.get('/:id/adherence', async (req, res, next) => {
    try {
        const days = Math.min(Number(req.query.days || 30), 365);
        res.json(await DietPrescriptionService.getAdherenceSummary(req.params.id, days));
    } catch (err) { next(err); }
});

export default router;
