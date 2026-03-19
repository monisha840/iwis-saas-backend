import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import { TriageService } from '../services/triage.service.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/documents/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

const triageSchema = z.object({
    painArea: z.string(),
    painSeverity: z.number().min(0).max(10),
    duration: z.string(),
    symptoms: z.array(z.string()).optional(),
    medicalHistory: z.string().optional(),
    medications: z.string().optional(),
    documentIds: z.array(z.string()).optional(),
});

router.post('/submit', authMiddleware, validate({ body: triageSchema }), async (req, res, next) => {
    try {
        const triageSession = await TriageService.submitTriage(req.user.id, req.body);
        res.status(201).json(triageSession);
    } catch (err) {
        next(err);
    }
});

router.post('/upload', authMiddleware, upload.single('file'), async (req, res, next) => {
    try {
        const document = await TriageService.uploadDocument(req.user.id, req.file, req.body);
        res.status(201).json(document);
    } catch (err) {
        next(err);
    }
});

router.get('/my-sessions', authMiddleware, async (req, res, next) => {
    try {
        const sessions = await TriageService.getMySessions(req.user.id);
        res.json(sessions);
    } catch (err) {
        next(err);
    }
});

export default router;
