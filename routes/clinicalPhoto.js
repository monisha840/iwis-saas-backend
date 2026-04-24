import express from 'express';
import { z } from 'zod';
import { ClinicalPhotoService } from '../services/clinicalPhoto.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { getUploadMiddleware, uploadToSupabase, BUCKETS } from '../middleware/upload.js';

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature('CLINICAL_PHOTOS'));

const upload = getUploadMiddleware({ maxSizeMb: 15, fieldName: 'file' });

const metaSchema = z.object({
    patientId:  z.string(),
    journeyId:  z.string().optional(),
    phaseId:    z.string().optional(),
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

        const filePath = await uploadToSupabase(req.file, BUCKETS.JOURNEY_MEDIA);
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
