import express from 'express';
import { z } from 'zod';
import { DietPrescriptionService } from '../services/dietPrescription.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';

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
        res.status(201).json(p);
    } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
    try {
        if (!req.query.patientId) return res.status(400).json({ error: 'patientId is required' });
        res.json(await DietPrescriptionService.listForPatient(req.query.patientId));
    } catch (err) { next(err); }
});

router.put('/:id', authorizeRoles('DOCTOR', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = createSchema.partial().parse(req.body);
        res.json(await DietPrescriptionService.update(req.params.id, data));
    } catch (err) { next(err); }
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
