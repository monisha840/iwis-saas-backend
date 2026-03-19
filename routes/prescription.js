import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import { PrescriptionService } from '../services/prescription.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/prescriptions/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

const addPrescriptionSchema = z.object({
  patientId: z.string(),
  medicationName: z.string(),
  dosage: z.string(),
  frequency: z.string(),
  duration: z.string(),
  notes: z.string().optional(),
  videoUrl: z.string().url().optional().or(z.literal("")),
  sku: z.string().optional(),
});

router.get('/patient/:id', authMiddleware, async (req, res, next) => {
  try {
    const prescriptions = await PrescriptionService.getPatientPrescriptions(req.params.id, req.user);
    res.json(prescriptions);
  } catch (err) {
    next(err);
  }
});

const batchPrescriptionSchema = z.object({
  patientId: z.string(),
  medicines: z.array(z.object({
    medicationName: z.string(),
    dosage: z.string(),
    frequency: z.string(),
    duration: z.string(),
    notes: z.string().optional(),
    timing: z.string().optional(),
    vehicle: z.string().optional(),
    medicineId: z.string().optional(),
    videoUrl: z.string().url().optional().or(z.literal("")),
    sku: z.string().optional(),
  })),
});

router.post('/batch-add', authMiddleware, roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']), validate({ body: batchPrescriptionSchema }), async (req, res, next) => {
  try {
    const prescriptions = await PrescriptionService.createBatchPrescriptions(req.user, req.body.patientId, req.body.medicines);
    res.status(201).json(prescriptions);
  } catch (err) {
    next(err);
  }
});

router.post('/add', authMiddleware, roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']), upload.single('file'), validate({ body: addPrescriptionSchema }), async (req, res, next) => {
  try {
    const prescription = await PrescriptionService.addPrescription(req.user, req.body, req.file?.filename);
    res.status(201).json(prescription);
  } catch (err) {
    next(err);
  }
});

router.get('/patient/:id/view', authMiddleware, async (req, res, next) => {
  try {
    const prescriptions = await PrescriptionService.viewAnyPatientPrescriptions(req.params.id);
    res.json(prescriptions);
  } catch (err) {
    next(err);
  }
});

router.get('/download/:filename', authMiddleware, (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = `uploads/prescriptions/${filename}`;
    res.download(filepath, (err) => {
      if (err) {
        res.status(404).json({ error: 'File not found' });
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Download failed' });
  }
});

export default router;
