import express from 'express';
import { z } from 'zod';
import { TreatmentPackageService } from '../services/treatmentPackage.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature('TREATMENT_PACKAGES'));

const componentSchema = z.object({
    type:        z.enum(['APPOINTMENT','MEDICINE','MEAL','ROOM','THERAPY']),
    description: z.string(),
    quantity:    z.coerce.number().int().positive().default(1),
});

const pkgSchema = z.object({
    branchId:     z.string(),
    name:         z.string().min(2),
    description:  z.string().optional(),
    durationDays: z.coerce.number().int().positive(),
    price:        z.coerce.number().nonnegative(),
    taxPercent:   z.coerce.number().nonnegative().default(0),
    components:   z.array(componentSchema).default([]),
    isActive:     z.boolean().optional(),
});

const enrolSchema = z.object({
    patientId:     z.string(),
    startDate:     z.coerce.date().optional(),
    sessionsTotal: z.coerce.number().int().nonnegative(),
    notes:         z.string().optional(),
});

const logSchema = z.object({
    sessionType:   z.string(),
    conductedAt:   z.coerce.date().optional(),
    conductedById: z.string(),
    appointmentId: z.string().optional(),
    notes:         z.string().optional(),
});

router.get('/', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST'), async (req, res, next) => {
    try {
        if (!req.query.branchId) return res.status(400).json({ error: 'branchId is required' });
        res.json(await TreatmentPackageService.list(req.query.branchId));
    } catch (err) { next(err); }
});

// Package CRUD is admin-only — DOCTOR can view (GET) and enrol patients
// (POST /:id/enrol) but not create, edit, or deactivate package templates.
// Authoring is treated as a catalog/admin function. THERAPIST is also
// excluded — they don't have this entry in their sidebar nav.
router.post('/', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = pkgSchema.parse(req.body);
        res.status(201).json(await TreatmentPackageService.create(data));
    } catch (err) { next(err); }
});

router.put('/:id', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = pkgSchema.partial().parse(req.body);
        res.json(await TreatmentPackageService.update(req.params.id, data));
    } catch (err) { next(err); }
});

router.delete('/:id', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        await TreatmentPackageService.deactivate(req.params.id);
        res.json({ success: true });
    } catch (err) { next(err); }
});

router.post('/:id/enrol', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR'), async (req, res, next) => {
    try {
        const data = enrolSchema.parse(req.body);
        res.status(201).json(await TreatmentPackageService.enrolPatient({ packageId: req.params.id, ...data }));
    } catch (err) { next(err); }
});

router.get('/enrolments', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT'), async (req, res, next) => {
    try {
        if (!req.query.patientId) return res.status(400).json({ error: 'patientId is required' });
        // Patients can only list their own enrolments.
        if (req.user.role === 'PATIENT') {
            const { default: prisma } = await import('../lib/prisma.js');
            const me = await prisma.patient.findUnique({
                where: { userId: req.user.id },
                select: { id: true },
            });
            if (!me || me.id !== req.query.patientId) {
                return res.status(403).json({ error: 'Forbidden' });
            }
        }
        res.json(await TreatmentPackageService.listEnrolmentsForPatient(req.query.patientId));
    } catch (err) { next(err); }
});

router.get('/enrolments/:id/progress', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT'), async (req, res, next) => {
    try {
        const p = await TreatmentPackageService.getProgress(req.params.id);
        if (!p) return res.status(404).json({ error: 'Not found' });
        res.json(p);
    } catch (err) { next(err); }
});

router.post('/enrolments/:id/log-session', authorizeRoles('THERAPIST', 'DOCTOR', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = logSchema.parse(req.body);
        res.status(201).json(await TreatmentPackageService.logSession({ enrolmentId: req.params.id, ...data }));
    } catch (err) { next(err); }
});

export default router;
