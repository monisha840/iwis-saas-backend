import express from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { JourneyService } from '../services/journey.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const CLINICAL_ROLES = ['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST', 'ADMIN'];
const VIEW_ROLES = [...CLINICAL_ROLES, 'PATIENT'];

// Therapists may not author MEDICATION tasks — that's a doctor-only authority.
// Walks the request body in-place looking for any phases[].tasks[] (or a single
// task on /tasks endpoints) whose type === 'MEDICATION'. Rejects with 403 and
// the documented error code so the frontend can surface a clear message.
function rejectTherapistMedicationTasks(req, res, next) {
    if (req.user?.role !== 'THERAPIST') return next();
    const tasks = [];
    if (Array.isArray(req.body?.phases)) {
        for (const p of req.body.phases) {
            if (Array.isArray(p?.tasks)) tasks.push(...p.tasks);
        }
    }
    if (Array.isArray(req.body?.tasks)) tasks.push(...req.body.tasks);
    if (req.body?.type) tasks.push(req.body); // single-task POST shape
    if (tasks.some((t) => t?.type === 'MEDICATION')) {
        return res.status(403).json({ error: 'THERAPIST_MEDICATION_RESTRICTION' });
    }
    next();
}

// Resolve branchId for journey creation:
//   DOCTOR / THERAPIST → forced to their JWT branch (so they can't plant a
//                        journey in a branch they don't belong to).
//   ADMIN_DOCTOR        → JWT has no branchId (hospital-scoped). We honour
//                        req.body.branchId when supplied, otherwise fall back
//                        to the selected patient's branchId so the form does
//                        not have to demand a branch picker.
async function forceBranchFromUser(req, res, next) {
    try {
        if (req.user?.branchId) {
            req.body.branchId = req.user.branchId;
            return next();
        }
        if (req.user?.role === 'ADMIN_DOCTOR') {
            if (req.body?.branchId) return next();
            if (req.body?.patientId) {
                const patient = await prisma.patient.findFirst({
                    where: { OR: [{ id: req.body.patientId }, { userId: req.body.patientId }] },
                    select: { branchId: true, user: { select: { branchId: true } } },
                });
                const resolved = patient?.branchId ?? patient?.user?.branchId ?? null;
                if (resolved) {
                    req.body.branchId = resolved;
                    return next();
                }
            }
            return res.status(400).json({ error: 'BRANCH_REQUIRED', message: 'Pick a patient or specify a branch — admin doctors are not pinned to a branch.' });
        }
        return res.status(400).json({ error: 'USER_HAS_NO_BRANCH' });
    } catch (err) { next(err); }
}

// A patient is allowed to view only their own journey.
async function enforcePatientJourneyOwnership(req, res, next) {
  if (req.user.role !== 'PATIENT') return next();
  try {
    // Journey.patientId points at User.id (see schema — TreatmentJourney.patientId → User)
    const journey = await prisma.treatmentJourney.findUnique({
      where: { id: req.params.id },
      select: { patientId: true },
    });
    if (!journey || journey.patientId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  } catch (err) { next(err); }
}

async function enforcePatientIdMatch(req, res, next) {
  if (req.user.role !== 'PATIENT') return next();
  // For GET /patient/:patientId we expect patientId = User.id (TreatmentJourney uses User.id)
  if (req.params.patientId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// POST /api/journeys — Doctor / Admin Doctor / Therapist creates a journey.
// branchId on the body is ignored — the server derives it from req.user.branchId
// (see forceBranchFromUser) so a clinician cannot plant a journey in another branch.
const createJourneySchema = z.object({
    // Both optional at the wire level so the form can submit a partially-built
    // draft. The route handler still 400s before hitting the service if either
    // is missing — DB columns are required and the resolution attempt above
    // (forceBranchFromUser) covers the ADMIN_DOCTOR-no-JWT-branch case.
    patientId: z.string().optional(),
    branchId: z.string().optional(),
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
    forceBranchFromUser,
    rejectTherapistMedicationTasks,
    async (req, res, next) => {
        try {
            // patientId is optional in Zod for draft-flow flexibility, but the
            // DB column is required. Surface a clean 400 instead of letting
            // Prisma throw an opaque foreign-key error.
            if (!req.body.patientId) {
                return res.status(400).json({ error: 'PATIENT_REQUIRED', message: 'Select a patient before saving the journey.' });
            }
            // The frontend now uses the searchable PatientPicker which emits
            // Patient.id. TreatmentJourney.patientId however points at User.id
            // (see service.js — the FK is on the User table). Normalise here
            // by accepting either form: look the patient up via id-or-userId
            // and pin the body to the user's id before the service call. This
            // mirrors what forceBranchFromUser already does for branch
            // resolution above so the two stay in lock-step.
            const resolved = await prisma.patient.findFirst({
                where: { OR: [{ id: req.body.patientId }, { userId: req.body.patientId }] },
                select: { userId: true },
            });
            if (!resolved?.userId) {
                return res.status(404).json({ error: 'PATIENT_NOT_FOUND', message: 'Selected patient could not be located.' });
            }
            req.body.patientId = resolved.userId;
            const journey = await JourneyService.createJourney(
                req.user.id, req.body.patientId, req.body.branchId, req.body
            );
            res.status(201).json(journey);
        } catch (err) { next(err); }
    }
);

// GET /api/journeys/mine — every journey owned by the calling clinician.
// Drives the "Existing Journeys" panel inside the Journey Builder page.
// Registered BEFORE /:id so the literal "mine" doesn't get matched as an id.
router.get('/mine',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    async (req, res, next) => {
        try {
            const journeys = await JourneyService.getDoctorJourneys(req.user.id);
            res.json(journeys);
        } catch (err) { next(err); }
    }
);

// GET /api/journeys/patient/:patientId
router.get('/patient/:patientId',
    authMiddleware,
    roleMiddleware(VIEW_ROLES),
    enforcePatientIdMatch,
    async (req, res, next) => {
        try {
            const journeys = await JourneyService.getPatientJourneys(req.params.patientId);
            res.json(journeys);
        } catch (err) { next(err); }
    }
);

// GET /api/journeys/:id — journey detail
router.get('/:id',
    authMiddleware,
    roleMiddleware(VIEW_ROLES),
    enforcePatientJourneyOwnership,
    async (req, res, next) => {
        try {
            const journey = await JourneyService.getJourneyById(req.params.id);
            res.json(journey);
        } catch (err) { next(err); }
    }
);

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
    rejectTherapistMedicationTasks,
    async (req, res, next) => {
        try {
            const phase = await JourneyService.addPhase(req.params.id, req.body);
            res.status(201).json(phase);
        } catch (err) { next(err); }
    }
);

// PATCH /api/journeys/:id/phases/:phaseId — update phase status, name,
// duration, or order. Status flips still funnel through activateNextPhase
// so the journey-completion side effects keep firing.
const updatePhaseSchema = z.object({
    status: z.enum(['UPCOMING', 'ACTIVE', 'COMPLETED', 'SKIPPED']).optional(),
    name: z.string().min(1).optional(),
    durationDays: z.number().int().min(1).optional(),
    order: z.number().int().min(0).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

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
            const data = {};
            if (req.body.status       !== undefined) data.status       = req.body.status;
            if (req.body.name         !== undefined) data.name         = req.body.name;
            if (req.body.durationDays !== undefined) data.durationDays = req.body.durationDays;
            if (req.body.order        !== undefined) data.order        = req.body.order;
            const phase = await prisma.journeyPhase.update({
                where: { id: req.params.phaseId },
                data,
            });
            res.json(phase);
        } catch (err) { next(err); }
    }
);

// DELETE /api/journeys/:id/phases/:phaseId — remove a phase. Cascades to
// PhaseTask via the schema's onDelete: Cascade.
router.delete('/:id/phases/:phaseId',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    async (req, res, next) => {
        try {
            await prisma.journeyPhase.delete({ where: { id: req.params.phaseId } });
            res.json({ message: 'Phase deleted', id: req.params.phaseId });
        } catch (err) { next(err); }
    }
);

// POST /api/journeys/:id/phases/:phaseId/tasks — append a task to a phase.
// Backend mirror for the UI's per-row "Add Task" button when editing an
// existing journey rather than building one from scratch.
const addTaskSchema = z.object({
    type: z.enum(['MEDICATION', 'EXERCISE', 'DIET', 'THERAPY', 'LIFESTYLE']),
    title: z.string().min(1),
    description: z.string().optional(),
    frequency: z.string().min(1),
});

router.post('/:id/phases/:phaseId/tasks',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    validate({ body: addTaskSchema }),
    rejectTherapistMedicationTasks,
    async (req, res, next) => {
        try {
            const task = await prisma.phaseTask.create({
                data: {
                    phaseId: req.params.phaseId,
                    type: req.body.type,
                    title: req.body.title,
                    description: req.body.description || null,
                    frequency: req.body.frequency,
                },
            });
            res.status(201).json(task);
        } catch (err) { next(err); }
    }
);

// DELETE /api/journeys/:id/phases/:phaseId/tasks/:taskId
router.delete('/:id/phases/:phaseId/tasks/:taskId',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    async (req, res, next) => {
        try {
            await prisma.phaseTask.delete({ where: { id: req.params.taskId } });
            res.json({ message: 'Task deleted', id: req.params.taskId });
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
