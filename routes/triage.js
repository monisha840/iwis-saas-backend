import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import { TriageService } from '../services/triage.service.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireFeature } from '../utils/featureGate.js';

const router = express.Router();

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/documents/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

// Body-map region from the TriageWizard — keep it permissive, the scorer handles gaps.
const painRegionSchema = z.object({
    regionId: z.string(),
    regionLabel: z.string().optional(),
    intensity: z.number().min(0).max(10),
    duration: z.string().optional(),
    characters: z.array(z.string()).optional(),
    radiatesTo: z.string().optional(),
});

const lifestyleSchema = z.object({
    sleepQuality: z.number().min(1).max(5).optional(),
    stressLevel: z.number().min(1).max(10).optional(),
    dietType: z.string().optional(),
    bowelRegularity: z.string().optional(),
    appetite: z.string().optional(),
    breathingDifficulty: z.boolean().optional(),
    suicidalIdeation: z.boolean().optional(),
}).passthrough();

// Optional vitals captured at triage time. Ranges picked for real-world plausibility;
// anything outside is rejected to avoid typos (e.g. someone typing 1200 for BP).
const vitalsSchema = z.object({
    BP_SYSTOLIC:  z.number().min(50).max(260).optional(),
    BP_DIASTOLIC: z.number().min(30).max(180).optional(),
    SPO2:         z.number().min(50).max(100).optional(),
    GLUCOSE:      z.number().min(20).max(800).optional(),
    HEART_RATE:   z.number().min(20).max(250).optional(),
}).partial();

// Wizard payload — aligned with TriageWizard.handleSubmit.
// Back-compat: legacy `painArea` is still accepted (deprecated, ignored by the scorer).
const submitSchema = z.object({
    chiefComplaint: z.string().optional(),
    painArea: z.string().optional(),
    painSeverity: z.number().min(0).max(10).optional(),
    duration: z.string().optional(),
    symptoms: z.array(z.string()).optional(),
    medicalHistory: z.string().optional(),
    medications: z.string().optional(),
    currentMedications: z.string().optional(),
    allergies: z.string().optional(),
    onsetPattern: z.string().optional(),
    documentIds: z.array(z.string()).optional(),
    painRegions: z.array(painRegionSchema).optional(),
    existingConditions: z.array(z.string()).optional(),
    lifestyleData: lifestyleSchema.optional(),
    // Patient-reported context — optional, surfaced in the wizard
    isPregnant: z.boolean().optional(),
    recentVitals: vitalsSchema.optional(),
});

// Re-triage: same shape but every field optional — the service merges with the prior session.
const reTriageSchema = submitSchema.partial();

const reviewSchema = z.object({
    overriddenUrgencyLevel: z.enum(['ROUTINE', 'MODERATE', 'URGENT', 'CRITICAL']).optional(),
    overriddenSpecialty: z.string().optional(),
    reason: z.string().max(1000).optional(),
    factorDisagreement: z.record(z.boolean()).optional(),
});

const specialtyRouteSchema = z.object({
    specialty: z.string().min(1),
    tags: z.array(z.string()).default([]),
    priority: z.number().int().optional(),
    isActive: z.boolean().optional(),
});

function requireRole(...allowed) {
    return (req, res, next) => {
        if (!req.user || !allowed.includes(req.user.role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    };
}

// ── Patient endpoints ──────────────────────────────────────────────────────
router.post('/', authMiddleware, validate({ body: submitSchema }), async (req, res, next) => {
    try {
        const triageSession = await TriageService.submitTriage(req.user.id, req.body);
        res.status(201).json(triageSession);
    } catch (err) { next(err); }
});

// Legacy alias — /api/triage/submit kept so older clients don't break
router.post('/submit', authMiddleware, validate({ body: submitSchema }), async (req, res, next) => {
    try {
        const triageSession = await TriageService.submitTriage(req.user.id, req.body);
        res.status(201).json(triageSession);
    } catch (err) { next(err); }
});

router.post('/:id/retriage', authMiddleware, requireFeature('TRIAGE_RETRIAGE'), validate({ body: reTriageSchema }), async (req, res, next) => {
    try {
        const updated = await TriageService.reTriage(req.params.id, req.user.id, req.body);
        res.json(updated);
    } catch (err) { next(err); }
});

router.post('/upload', authMiddleware, upload.single('file'), async (req, res, next) => {
    try {
        const document = await TriageService.uploadDocument(req.user.id, req.file, req.body);
        res.status(201).json(document);
    } catch (err) { next(err); }
});

router.get('/my-sessions', authMiddleware, async (req, res, next) => {
    try {
        const sessions = await TriageService.getMySessions(req.user.id);
        res.json(sessions);
    } catch (err) { next(err); }
});

router.get('/sessions/:id', authMiddleware, async (req, res, next) => {
    try {
        const session = await TriageService.getSessionById(req.params.id, req.user.id, req.user.role);
        res.json(session);
    } catch (err) { next(err); }
});

// ── Clinician review + override ────────────────────────────────────────────
router.post('/:id/review',
    authMiddleware,
    requireRole('DOCTOR', 'ADMIN_DOCTOR'),
    requireFeature('TRIAGE_DOCTOR_OVERRIDE'),
    validate({ body: reviewSchema }),
    async (req, res, next) => {
        try {
            const updated = await TriageService.doctorReview(req.params.id, req.user, req.body);
            res.json(updated);
        } catch (err) { next(err); }
    }
);

router.get('/overrides/stats',
    authMiddleware,
    requireRole('ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN'),
    requireFeature('TRIAGE_OVERRIDE_STATS'),
    async (req, res, next) => {
        try {
            const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
            const stats = await TriageService.getOverrideStats({ days });
            res.json(stats);
        } catch (err) { next(err); }
    }
);

// ── Specialty route admin surface ──────────────────────────────────────────
router.get('/specialty-routes',
    authMiddleware,
    requireRole('ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN'),
    async (req, res, next) => {
        try {
            res.json(await TriageService.listSpecialtyRoutes());
        } catch (err) { next(err); }
    }
);

router.put('/specialty-routes',
    authMiddleware,
    requireRole('ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN'),
    validate({ body: specialtyRouteSchema }),
    async (req, res, next) => {
        try {
            res.json(await TriageService.upsertSpecialtyRoute(req.body));
        } catch (err) { next(err); }
    }
);

router.delete('/specialty-routes/:id',
    authMiddleware,
    requireRole('ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN'),
    async (req, res, next) => {
        try {
            await TriageService.deleteSpecialtyRoute(req.params.id);
            res.status(204).end();
        } catch (err) { next(err); }
    }
);

export default router;
