import express from 'express';
import { z } from 'zod';
import { DietPackageService } from '../services/dietPackage.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature('DIET_PRESCRIPTION'));

const mealSchema = z.object({
    mealTime:     z.enum(['MORNING_EMPTY','BREAKFAST','MID_MORNING','LUNCH','EVENING','DINNER','BEDTIME']),
    foods:        z.array(z.object({ name: z.string(), quantity: z.string().optional(), unit: z.string().optional(), notes: z.string().optional() })).default([]),
    avoidFoods:   z.array(z.object({ name: z.string(), reason: z.string().optional() })).default([]),
    instructions: z.string().optional(),
});

const createSchema = z.object({
    title:        z.string().min(2),
    description:  z.string().optional(),
    doshaTarget:  z.enum(['VATA','PITTA','KAPHA','TRIDOSHA']),
    category:     z.enum(['SATTVIC','RAJASIC','TAMASIC']),
    durationDays: z.coerce.number().int().min(1).max(365),
    notes:        z.string().optional(),
    meals:        z.array(mealSchema).default([]),
});

const assignSchema = z.object({
    patientId:          z.string(),
    doctorId:           z.string().optional(),
    startDate:          z.coerce.date().optional(),
    durationDays:       z.coerce.number().int().min(1).max(365).optional(),
    title:              z.string().optional(),
    notes:              z.string().optional(),
    journeyId:          z.string().optional(),
    // If true, auto-deactivates any overlapping active prescriptions for
    // the same patient before creating the new one. Used by the frontend
    // when the doctor confirms the "replace existing diet" prompt.
    deactivateExisting: z.boolean().optional(),
});

// GET /api/diet-packages?status=...
router.get('/', async (req, res, next) => {
    try {
        const status = req.query.status ? String(req.query.status) : undefined;
        const list = await DietPackageService.list({
            hospitalId:  req.user.hospitalId ?? null,
            status,
            mineUserId:  req.user.id,
            role:        req.user.role,
        });
        res.json(list);
    } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
    try {
        res.json(await DietPackageService.get(req.params.id));
    } catch (err) { next(err); }
});

// Create — any authoring role (DOCTOR / THERAPIST / ADMIN_DOCTOR / ADMIN).
// ADMIN and ADMIN_DOCTOR are also approvers, so their packages auto-approve.
router.post('/', authorizeRoles('DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR', 'ADMIN'), async (req, res, next) => {
    try {
        const data = createSchema.parse(req.body);
        const pkg = await DietPackageService.create({ user: req.user, data });
        res.status(201).json(pkg);
    } catch (err) { next(err); }
});

// Edit — only the original author can edit their own package.
router.put('/:id', authorizeRoles('DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR', 'ADMIN'), async (req, res, next) => {
    try {
        const data = createSchema.partial().parse(req.body);
        const pkg = await DietPackageService.update({ id: req.params.id, user: req.user, data });
        res.json(pkg);
    } catch (err) { next(err); }
});

// Approval workflow retired — diet packages publish immediately on create.
// Endpoints kept around as 410 Gone so any stale frontend bundle that still
// hits them gets a clear, actionable error instead of a silent failure.
// Schema columns (status / approvedById / rejectionReason / xpAwarded /
// approvalNotes / approvedAt) are intentionally left in place so historical
// rows remain readable; no Prisma migration needed.
const approvalRetired = (req, res) => res.status(410).json({
    error: 'Diet package approval workflow has been retired. Packages are published on create — assign directly from the package list.',
});
router.post('/:id/approve', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), approvalRetired);
router.post('/:id/reject',  authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), approvalRetired);
router.post('/:id/archive', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), approvalRetired);

// Assign to patient — any clinician who can create a DietPrescription.
router.post('/:id/assign', authorizeRoles('DOCTOR', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = assignSchema.parse(req.body);
        const rx = await DietPackageService.assignToPatient({ id: req.params.id, user: req.user, data });
        res.status(201).json(rx);
    } catch (err) {
        // Surface the conflict payload so the frontend can offer a "replace existing" prompt.
        if (err?.code === 'ACTIVE_DIET_CONFLICT') {
            return res.status(409).json({
                error:     err.message,
                code:      err.code,
                conflicts: err.conflicts,
            });
        }
        next(err);
    }
});

// Pre-assign context — what the frontend needs to render a safe confirmation
// (dosha match, existing active diets, etc.)
router.get('/:id/assign-context', authorizeRoles('DOCTOR', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const patientId = String(req.query.patientId || '');
        if (!patientId) return res.status(400).json({ error: 'patientId is required' });
        res.json(await DietPackageService.getAssignContext({ packageId: req.params.id, patientId }));
    } catch (err) { next(err); }
});

export default router;
