import express from 'express';
import { z } from 'zod';
import { JourneyService } from '../services/journey.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

// POST /api/journeys — Doctor creates a journey
const createJourneySchema = z.object({
    patientId: z.string(),
    branchId: z.string(),
    title: z.string().min(1).max(200),
    condition: z.string().min(1).max(200),
    targetDate: z.string().optional(),
    phases: z.array(z.object({
        name: z.string(),
        order: z.number().optional(),
        durationDays: z.number().min(1),
        tasks: z.array(z.object({
            type: z.enum(['MEDICATION', 'EXERCISE', 'DIET', 'THERAPY', 'LIFESTYLE']),
            title: z.string(),
            description: z.string().optional(),
            frequency: z.string(),
        })).optional(),
    })).optional(),
    milestones: z.array(z.object({
        title: z.string(),
        description: z.string().optional(),
        targetDate: z.string().optional(),
        badgeIcon: z.string().optional(),
    })).optional(),
});

router.post('/',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    validate({ body: createJourneySchema }),
    async (req, res, next) => {
        try {
            const journey = await JourneyService.createJourney(
                req.user.id, req.body.patientId, req.body.branchId, req.body
            );
            res.status(201).json(journey);
        } catch (err) { next(err); }
    }
);

// GET /api/journeys/patient/:patientId
router.get('/patient/:patientId', authMiddleware, async (req, res, next) => {
    try {
        const journeys = await JourneyService.getPatientJourneys(req.params.patientId);
        res.json(journeys);
    } catch (err) { next(err); }
});

// GET /api/journeys/:id — journey detail
router.get('/:id', authMiddleware, async (req, res, next) => {
    try {
        const journey = await JourneyService.getJourneyById(req.params.id);
        res.json(journey);
    } catch (err) { next(err); }
});

// POST /api/journeys/:id/phases — add phase
const addPhaseSchema = z.object({
    name: z.string(),
    durationDays: z.number().min(1),
    order: z.number().optional(),
    tasks: z.array(z.object({
        type: z.enum(['MEDICATION', 'EXERCISE', 'DIET', 'THERAPY', 'LIFESTYLE']),
        title: z.string(),
        description: z.string().optional(),
        frequency: z.string(),
    })).optional(),
});

router.post('/:id/phases',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    validate({ body: addPhaseSchema }),
    async (req, res, next) => {
        try {
            const phase = await JourneyService.addPhase(req.params.id, req.body);
            res.status(201).json(phase);
        } catch (err) { next(err); }
    }
);

// PATCH /api/journeys/:id/phases/:phaseId — update phase status
const updatePhaseSchema = z.object({
    status: z.enum(['UPCOMING', 'ACTIVE', 'COMPLETED', 'SKIPPED']),
});

router.patch('/:id/phases/:phaseId',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    validate({ body: updatePhaseSchema }),
    async (req, res, next) => {
        try {
            if (req.body.status === 'COMPLETED') {
                const next = await JourneyService.activateNextPhase(req.params.id);
                return res.json({ message: 'Phase completed', nextPhase: next });
            }
            const phase = await prisma.journeyPhase.update({
                where: { id: req.params.phaseId },
                data: { status: req.body.status }
            });
            res.json(phase);
        } catch (err) { next(err); }
    }
);

// POST /api/journeys/:id/tasks/:taskId/complete — patient logs task completion
const completeTaskSchema = z.object({
    notes: z.string().optional(),
    mediaUrl: z.string().optional(),
});

router.post('/:id/tasks/:taskId/complete',
    authMiddleware,
    validate({ body: completeTaskSchema }),
    async (req, res, next) => {
        try {
            const completion = await JourneyService.completeTask(
                req.params.taskId, req.user.id, req.body
            );
            res.status(201).json(completion);
        } catch (err) { next(err); }
    }
);

// POST /api/journeys/:id/vitals — patient logs vital
const recordVitalSchema = z.object({
    type: z.enum(['PAIN_SCORE', 'WEIGHT', 'BP_SYSTOLIC', 'BP_DIASTOLIC', 'GLUCOSE', 'SLEEP_HOURS', 'MOOD']),
    value: z.number(),
    unit: z.string(),
    source: z.string().optional(),
});

router.post('/:id/vitals',
    authMiddleware,
    validate({ body: recordVitalSchema }),
    async (req, res, next) => {
        try {
            const vital = await JourneyService.recordVital(req.user.id, {
                ...req.body,
                journeyId: req.params.id,
            });
            res.status(201).json(vital);
        } catch (err) { next(err); }
    }
);

// GET /api/journeys/:id/vitals — chart data
router.get('/:id/vitals', authMiddleware, async (req, res, next) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const vitals = await JourneyService.getJourneyVitals(req.params.id, req.query.type, days);
        res.json(vitals);
    } catch (err) { next(err); }
});

// GET /api/journeys/:id/wellness-score
router.get('/:id/wellness-score', authMiddleware, async (req, res, next) => {
    try {
        const score = await JourneyService.computeWellnessScore(req.params.id);
        res.json(score);
    } catch (err) { next(err); }
});

// GET /api/journeys/:id/timeline
router.get('/:id/timeline', authMiddleware, async (req, res, next) => {
    try {
        const timeline = await JourneyService.getJourneyTimeline(req.params.id);
        res.json(timeline);
    } catch (err) { next(err); }
});

export default router;
