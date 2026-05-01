import express from 'express';
import { z } from 'zod';
import { SelfExamService } from '../services/selfExam.service.js';
import { ALL_ZONES } from '../services/selfExam.protocol.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import {
    getUploadMiddleware,
    uploadToSupabase,
    BUCKETS,
} from '../middleware/upload.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireFeature('SELF_EXAM_PROTOCOL'));

// ─── Zod enums mirror the Prisma enums so we reject bad inputs at the edge ──

const painZoneSchema = z.enum([
    'HEAD_MIGRAINE', 'NECK', 'SHOULDER', 'CHEST', 'LOWER_BACK',
    'ABDOMEN', 'KNEE', 'WRIST_HAND', 'GENERALISED_MUSCLE',
]);

const painCharacterSchema = z.enum([
    'THROBBING', 'PRESSING', 'STABBING', 'DULL', 'BURNING', 'SHARP',
    'ACHING', 'CRAMPING', 'GRINDING', 'HEAVY', 'TIGHT', 'COLICKY', 'BLOATING',
]);

const tongueColorSchema = z.enum(['NONE', 'WHITE', 'YELLOW', 'RED']);
const tongueThicknessSchema = z.enum(['NONE', 'THIN', 'THICK']);
const stoolConsistencySchema = z.enum([
    'HARD_PELLETS', 'FORMED', 'SOFT', 'LOOSE', 'WATERY', 'MUCOUSY',
]);
const stoolColourSchema = z.enum(['BROWN', 'PALE', 'YELLOW_GREEN', 'DARK']);
const stoolMealRelSchema = z.enum(['BEFORE_MEALS', 'AFTER_MEALS', 'BOTH', 'NONE']);
const urineColourSchema = z.enum(['PALE', 'NORMAL_YELLOW', 'DARK_YELLOW', 'BROWN']);
const romJointSchema = z.enum([
    'NECK', 'SHOULDER_LEFT', 'SHOULDER_RIGHT', 'KNEE_LEFT', 'KNEE_RIGHT',
]);
const romDirectionSchema = z.enum([
    'NECK_ROTATE_LEFT', 'NECK_ROTATE_RIGHT', 'NECK_FLEX', 'NECK_EXTEND',
    'NECK_LATERAL_LEFT', 'NECK_LATERAL_RIGHT',
    'SHOULDER_FLEX_OVERHEAD', 'SHOULDER_ABDUCT', 'SHOULDER_CROSS_BODY',
    'SHOULDER_BEHIND_BACK', 'SHOULDER_EXTERNAL_ROT', 'SHOULDER_INTERNAL_ROT',
    'KNEE_FLEX', 'KNEE_EXTEND',
]);
const physicalObsTypeSchema = z.enum([
    'POSTURE_FULL_BODY', 'FACE_EYE', 'HAND_FLAT', 'KNEE_COMPARE',
    'SHOULDER_SYMMETRY', 'GENERAL_APPEARANCE',
]);
const prakritiSchema = z.enum([
    'VATA', 'PITTA', 'KAPHA', 'VATA_PITTA', 'PITTA_KAPHA', 'VATA_KAPHA', 'TRIDOSHA',
]);
const agniSchema = z.enum(['MANDAGNI', 'TIKSHNA', 'VISHAMA', 'SAMA']);
const appetiteSchema = z.enum(['STRONG', 'MODERATE', 'WEAK', 'IRREGULAR']);
const sleepPositionSchema = z.enum([
    'BACK', 'LEFT_SIDE', 'RIGHT_SIDE', 'STOMACH', 'MIXED',
]);

// ─── Typed payload schemas ─────────────────────────────────────────────

const symptomSchema = z.object({
    subLocation: z.string().max(200).optional(),
    characters: z.array(painCharacterSchema).default([]),
    triggers: z.array(z.string().max(100)).default([]),
    relievingFactors: z.array(z.string().max(100)).default([]),
    timing: z.array(z.string().max(100)).default([]),
    severity: z.number().int().min(0).max(10),
    radiatesTo: z.string().max(200).optional(),
    associatedSymptoms: z.array(z.string().max(100)).default([]),
    warningSignsBeforeEpisode: z.array(z.string().max(100)).default([]),
    injuryHistory: z.string().max(500).optional(),
    occupationContext: z.string().max(500).optional(),
    freeText: z.string().max(2000).optional(),
});

const tongueSchema = z.object({
    observedOn: z.coerce.date().optional(),
    photoUrl: z.string().url().optional(),
    coatingColor: tongueColorSchema,
    coatingThickness: tongueThicknessSchema,
    dryness: z.boolean().default(false),
    cracks: z.boolean().default(false),
    tremor: z.boolean().default(false),
    correlatedPainLevel: z.number().int().min(0).max(10).optional(),
    notes: z.string().max(1000).optional(),
});

const stoolSchema = z.object({
    observedOn: z.coerce.date().optional(),
    consistency: stoolConsistencySchema,
    colour: stoolColourSchema,
    frequencyPerDay: z.number().int().min(0).max(20),
    daysSinceLastMovement: z.number().int().min(0).max(30).optional(),
    strainingEffort: z.number().int().min(1).max(5),
    incompleteEvacuation: z.boolean().default(false),
    bloatingGas: z.boolean().default(false),
    bloodPresent: z.boolean().default(false),
    mucusPresent: z.boolean().default(false),
    undigestedFood: z.boolean().default(false),
    relationshipToMeal: stoolMealRelSchema.default('NONE'),
    notes: z.string().max(1000).optional(),
});

const urineSchema = z.object({
    observedOn: z.coerce.date().optional(),
    colour: urineColourSchema,
    frequencyPerDay: z.number().int().min(0).max(30),
    burning: z.boolean().default(false),
    urgency: z.boolean().default(false),
    painCorrelation: z.boolean().default(false),
    notes: z.string().max(1000).optional(),
});

const romSchema = z.object({
    angleDegrees: z.number().min(0).max(360).optional(),
    restriction: z.string().max(200).optional(),
    painScore: z.number().int().min(0).max(10),
    crepitus: z.boolean().default(false),
    catchOrSharp: z.boolean().default(false),
    notes: z.string().max(500).optional(),
});

const physicalSchema = z.object({
    painZone: painZoneSchema.optional(),
    photoFrontUrl: z.string().url().optional(),
    photoSideUrl: z.string().url().optional(),
    photoBackUrl: z.string().url().optional(),
    photoExtraUrl: z.string().url().optional(),
    details: z.record(z.any()).default({}),
    notes: z.string().max(1000).optional(),
});

const voiceSchema = z.object({
    morningRecUrl: z.string().url().optional(),
    eveningRecUrl: z.string().url().optional(),
    fatigueNotes: z.string().max(1000).optional(),
});

const digestiveSchema = z.object({
    agniType: agniSchema.optional(),
    appetiteLevel: appetiteSchema.optional(),
    bloatingAfterMeals: z.boolean().default(false),
    bloatingDurationMins: z.number().int().min(0).max(1440).optional(),
    heartburnPerWeek: z.number().int().min(0).max(50).optional(),
    waterIntakeGlasses: z.number().int().min(0).max(40).optional(),
    coldFoodAggravates: z.boolean().default(false),
    foodTriggers: z.array(z.string().max(100)).default([]),
    incompatibleCombinations: z.array(z.string().max(100)).default([]),
    notes: z.string().max(1000).optional(),
});

const lifestyleSchema = z.object({
    pillowType: z.string().max(200).optional(),
    pillowFirmness: z.string().max(200).optional(),
    sleepPosition: sleepPositionSchema.optional(),
    sleepHours: z.number().min(0).max(24).optional(),
    screenHoursPerDay: z.number().int().min(0).max(24).optional(),
    occupation: z.string().max(200).optional(),
    pastInjuries: z.string().max(1000).optional(),
    regularExercise: z.string().max(500).optional(),
    stressEventsPast6mo: z.string().max(1000).optional(),
    notes: z.string().max(1000).optional(),
});

const constitutionSchema = z.object({
    prakriti: prakritiSchema.optional(),
    satvaRating: z.number().int().min(1).max(10).optional(),
    agniType: agniSchema.optional(),
    quizAnswers: z.record(z.any()).optional(),
});

// ─── Routes ────────────────────────────────────────────────────────────

router.get('/zones', (_req, res) => {
    res.json({ zones: ALL_ZONES });
});

// Create a submission manually (rarely needed — the triage hook auto-creates).
router.post('/', authorizeRoles('PATIENT'), async (req, res, next) => {
    try {
        const body = z
            .object({
                zones: z.array(painZoneSchema).min(1),
                appointmentId: z.string().optional(),
            })
            .parse(req.body);
        const sub = await SelfExamService.createManual(req.user.id, body);
        res.status(201).json(sub);
    } catch (err) { next(err); }
});

router.get('/mine', authorizeRoles('PATIENT'), async (req, res, next) => {
    try {
        res.json(await SelfExamService.listForPatient(req.user.id));
    } catch (err) { next(err); }
});

router.get(
    '/review-queue',
    authorizeRoles('DOCTOR', 'ADMIN_DOCTOR', 'ADMIN'),
    async (req, res, next) => {
        try {
            const { branchId, status } = req.query;
            res.json(await SelfExamService.listForReview({ branchId, status, user: req.user }));
        } catch (err) { next(err); }
    }
);

// Constitution quiz is patient-level (not per submission).
router.get('/constitution/me', authorizeRoles('PATIENT'), async (req, res, next) => {
    try {
        res.json(await SelfExamService.getConstitution(req.user.id));
    } catch (err) { next(err); }
});

router.post('/constitution', authorizeRoles('PATIENT'), async (req, res, next) => {
    try {
        const body = constitutionSchema.parse(req.body);
        res.json(await SelfExamService.upsertConstitution(req.user.id, body));
    } catch (err) { next(err); }
});

// Photo upload — returns the uploaded URL so the client can paste it into
// whichever typed observation row it belongs to. Only photo-bearing exams
// (tongue, physical, voice) use this. STOOL DOES NOT ACCEPT PHOTOS.
const upload = getUploadMiddleware({ maxSizeMb: 15, fieldName: 'file' });
router.post('/upload-asset', authorizeRoles('PATIENT'), upload, async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'file is required' });
        const filePath = await uploadToSupabase(req.file, BUCKETS.JOURNEY_MEDIA);
        res.status(201).json({ url: filePath });
    } catch (err) { next(err); }
});

// ─── Admin protocol CRUD ──────────────────────────────────────────────
// Lets ADMIN / ADMIN_DOCTOR tune the zone → test protocol per hospital.
// Placed BEFORE /:submissionId so Express doesn't shadow them.

router.get(
    '/protocols',
    authorizeRoles('ADMIN', 'ADMIN_DOCTOR'),
    async (req, res, next) => {
        try {
            if (!req.user.hospitalId) {
                return res.status(400).json({ error: 'No hospital context on token' });
            }
            res.json(await SelfExamService.listProtocols(req.user.hospitalId));
        } catch (err) { next(err); }
    }
);

router.put(
    '/protocols/:zone',
    authorizeRoles('ADMIN', 'ADMIN_DOCTOR'),
    async (req, res, next) => {
        try {
            const zone = req.params.zone;
            if (!req.user.hospitalId) {
                return res.status(400).json({ error: 'No hospital context on token' });
            }
            const body = z.object({ config: z.record(z.any()) }).parse(req.body);
            res.json(
                await SelfExamService.upsertProtocol(
                    req.user.hospitalId,
                    zone,
                    body.config,
                    req.user.id
                )
            );
        } catch (err) { next(err); }
    }
);

router.delete(
    '/protocols/:zone',
    authorizeRoles('ADMIN', 'ADMIN_DOCTOR'),
    async (req, res, next) => {
        try {
            if (!req.user.hospitalId) {
                return res.status(400).json({ error: 'No hospital context on token' });
            }
            res.json(
                await SelfExamService.resetProtocol(req.user.hospitalId, req.params.zone)
            );
        } catch (err) { next(err); }
    }
);

// Fetch the bundle attached to a specific appointment — used by the doctor
// dashboard to render the self-exam inline on the appointment row.
// Placed BEFORE `/:submissionId` so Express doesn't shadow it.
router.get('/by-appointment/:appointmentId', async (req, res, next) => {
    try {
        res.json(
            await SelfExamService.getByAppointment(
                req.params.appointmentId,
                req.user.id,
                req.user.role
            )
        );
    } catch (err) { next(err); }
});

// Single submission fetch (bundled with checklist + completion)
router.get('/:submissionId', async (req, res, next) => {
    try {
        res.json(
            await SelfExamService.get(req.params.submissionId, req.user.id, req.user.role)
        );
    } catch (err) { next(err); }
});

router.post(
    '/:submissionId/symptom-history',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            const body = z
                .object({ zone: painZoneSchema })
                .merge(symptomSchema)
                .parse(req.body);
            const { zone, ...payload } = body;
            res.json(
                await SelfExamService.upsertSymptomHistory(
                    req.params.submissionId,
                    req.user.id,
                    zone,
                    payload
                )
            );
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/tongue',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            const body = z
                .object({ dayIndex: z.number().int().min(1).max(7) })
                .merge(tongueSchema)
                .parse(req.body);
            const { dayIndex, ...payload } = body;
            res.json(
                await SelfExamService.upsertTongue(
                    req.params.submissionId,
                    req.user.id,
                    dayIndex,
                    payload
                )
            );
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/stool',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            const body = z
                .object({ dayIndex: z.number().int().min(1).max(7) })
                .merge(stoolSchema)
                .parse(req.body);
            const { dayIndex, ...payload } = body;
            res.json(
                await SelfExamService.upsertStool(
                    req.params.submissionId,
                    req.user.id,
                    dayIndex,
                    payload
                )
            );
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/urine',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            const body = z
                .object({ dayIndex: z.number().int().min(1).max(7) })
                .merge(urineSchema)
                .parse(req.body);
            const { dayIndex, ...payload } = body;
            res.json(
                await SelfExamService.upsertUrine(
                    req.params.submissionId,
                    req.user.id,
                    dayIndex,
                    payload
                )
            );
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/rom',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            const body = z
                .object({ joint: romJointSchema, direction: romDirectionSchema })
                .merge(romSchema)
                .parse(req.body);
            const { joint, direction, ...payload } = body;
            res.json(
                await SelfExamService.upsertRoM(
                    req.params.submissionId,
                    req.user.id,
                    joint,
                    direction,
                    payload
                )
            );
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/physical',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            const body = z
                .object({ observationType: physicalObsTypeSchema })
                .merge(physicalSchema)
                .parse(req.body);
            const { observationType, ...payload } = body;
            res.json(
                await SelfExamService.upsertPhysical(
                    req.params.submissionId,
                    req.user.id,
                    observationType,
                    payload
                )
            );
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/voice',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            const body = z
                .object({ dayIndex: z.number().int().min(1).max(7) })
                .merge(voiceSchema)
                .parse(req.body);
            const { dayIndex, ...payload } = body;
            res.json(
                await SelfExamService.upsertVoice(
                    req.params.submissionId,
                    req.user.id,
                    dayIndex,
                    payload
                )
            );
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/digestive',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            const body = digestiveSchema.parse(req.body);
            res.json(
                await SelfExamService.upsertDigestive(
                    req.params.submissionId,
                    req.user.id,
                    body
                )
            );
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/lifestyle',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            const body = lifestyleSchema.parse(req.body);
            res.json(
                await SelfExamService.upsertLifestyle(
                    req.params.submissionId,
                    req.user.id,
                    body
                )
            );
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/attach-appointment',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            const { appointmentId } = z
                .object({ appointmentId: z.string() })
                .parse(req.body);
            res.json(
                await SelfExamService.attachAppointment(
                    req.params.submissionId,
                    req.user.id,
                    appointmentId
                )
            );
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/submit',
    authorizeRoles('PATIENT'),
    async (req, res, next) => {
        try {
            res.json(await SelfExamService.submit(req.params.submissionId, req.user.id));
        } catch (err) { next(err); }
    }
);

router.post(
    '/:submissionId/review',
    authorizeRoles('DOCTOR', 'ADMIN_DOCTOR', 'ADMIN'),
    async (req, res, next) => {
        try {
            const body = z
                .object({ reviewNotes: z.string().max(5000).optional() })
                .parse(req.body);
            res.json(
                await SelfExamService.review(
                    req.params.submissionId,
                    req.user.id,
                    body
                )
            );
        } catch (err) { next(err); }
    }
);

export default router;
