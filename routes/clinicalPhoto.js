import express from 'express';
import { z } from 'zod';
import { ClinicalPhotoService } from '../services/clinicalPhoto.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { getUploadMiddleware, uploadToSupabase, BUCKETS } from '../middleware/upload.js';
import prisma from '../lib/prisma.js';

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature('CLINICAL_PHOTOS'));

const upload = getUploadMiddleware({ maxSizeMb: 15, fieldName: 'file' });

const metaSchema = z.object({
    patientId:        z.string(),
    journeyId:        z.string().optional(),
    phaseId:          z.string().optional(),
    // Phase B1 — optional FK that links the upload to an in-progress
    // therapy session. When omitted, the upload behaves exactly as
    // pre-B1: legacy journey/phase or standalone /clinical-photos flows
    // are unaffected.
    therapySessionId: z.string().optional(),
    category:   z.enum(['SKIN_CONDITION','SWELLING_OEDEMA','WOUND_HEALING','WEIGHT_CHANGE','GENERAL_PROGRESS']),
    stage:      z.enum(['BEFORE','DURING','AFTER']),
    bodyRegion: z.string().optional(),
    notes:      z.string().optional(),
});

router.post('/', upload, async (req, res, next) => {
    try {
        const data = metaSchema.parse(req.body);
        if (!req.file) return res.status(400).json({ error: 'file is required' });

        // Patients can only upload DURING photos (clinician owns BEFORE/AFTER framing).
        if (req.user.role === 'PATIENT' && data.stage !== 'DURING') {
            return res.status(403).json({ error: 'Patients can only upload DURING-stage photos' });
        }

        // Phase B1 session-bound upload validation. Mirrors the auth +
        // status semantics of the therapy-session mutation endpoints:
        //   - session must exist
        //   - caller must be the assigned therapist (or admin)
        //   - session must be IN_PROGRESS (no photos on completed sessions)
        if (data.therapySessionId) {
            const session = await prisma.therapySession.findUnique({
                where: { id: data.therapySessionId },
                select: { id: true, therapistId: true, status: true, patientId: true },
            });
            if (!session) {
                return res.status(400).json({ error: 'therapySessionId is invalid' });
            }
            const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'ADMIN_DOCTOR';
            const isOwn = session.therapistId === req.user.id;
            if (!isAdmin && !isOwn) {
                return res.status(403).json({ error: 'You are not assigned to this session' });
            }
            if (session.status !== 'IN_PROGRESS') {
                return res.status(400).json({
                    error: 'Cannot attach photos to a completed or abandoned session',
                    code: 'SESSION_LOCKED',
                });
            }
            // Defensive: ensure the patient context lines up with the
            // session. Stops a malformed upload from associating one
            // patient's photo with another patient's session.
            if (data.patientId !== session.patientId) {
                return res.status(400).json({ error: 'patientId does not match the session patient' });
            }
        }

        const filePath = await uploadToSupabase(req.file, BUCKETS.JOURNEY_MEDIA, { hospitalId: req.user.hospitalId, patientId: data.patientId });
        const photo = await ClinicalPhotoService.create({
            ...data,
            filePath,
            uploadedById: req.user.id,
        });
        res.status(201).json(photo);
    } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
    try {
        res.json(await ClinicalPhotoService.list(req.query));
    } catch (err) { next(err); }
});

router.get('/compare', async (req, res, next) => {
    try {
        if (!req.query.patientId) return res.status(400).json({ error: 'patientId is required' });
        res.json(await ClinicalPhotoService.getComparison(req.query));
    } catch (err) { next(err); }
});

router.delete('/:id', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST'), async (req, res, next) => {
    try {
        await ClinicalPhotoService.delete(req.params.id);
        res.json({ success: true });
    } catch (err) { next(err); }
});

export default router;
