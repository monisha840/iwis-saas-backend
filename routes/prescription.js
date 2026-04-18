import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import { PrescriptionService } from '../services/prescription.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditAction } from '../middleware/auditLog.js';
import prisma from '../lib/prisma.js';

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
    const patientId = req.params.id;

    // IDOR protection: verify the caller has access to this patient's prescriptions
    if (req.user.role === 'PATIENT') {
      const patientRecord = await prisma.patient.findUnique({
        where: { userId: req.user.id },
        select: { id: true }
      });
      if (patientRecord?.id !== patientId) {
        return res.status(403).json({ error: 'Forbidden: you can only view your own prescriptions' });
      }
    } else if (req.user.role === 'DOCTOR' || req.user.role === 'THERAPIST') {
      const isAssigned = await prisma.appointment.findFirst({
        where: {
          patientId,
          status: { in: ['CONFIRMED', 'COMPLETED', 'ASSIGNED'] },
          OR: [
            { doctor: { userId: req.user.id } },
            { therapist: { userId: req.user.id } },
          ]
        }
      });
      if (!isAssigned) {
        const journeyAssigned = await prisma.journey.findFirst({
          where: {
            patientId,
            OR: [
              { doctor: { userId: req.user.id } },
              { therapist: { userId: req.user.id } },
            ]
          }
        });
        if (!journeyAssigned) return res.status(403).json({ error: 'Forbidden: not assigned to this patient' });
      }
    }
    // ADMIN and ADMIN_DOCTOR can access any patient's prescriptions

    const prescriptions = await PrescriptionService.getPatientPrescriptions(patientId, req.user);
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

router.post('/batch-add', authMiddleware, roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']), validate({ body: batchPrescriptionSchema }), auditAction('CREATE_PRESCRIPTION', 'Prescription', () => null), async (req, res, next) => {
  try {
    const prescriptions = await PrescriptionService.createBatchPrescriptions(req.user, req.body.patientId, req.body.medicines);
    res.status(201).json(prescriptions);
  } catch (err) {
    next(err);
  }
});

router.post('/add', authMiddleware, roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']), upload.single('file'), validate({ body: addPrescriptionSchema }), auditAction('CREATE_PRESCRIPTION', 'Prescription', () => null), async (req, res, next) => {
  try {
    const prescription = await PrescriptionService.addPrescription(req.user, req.body, req.file?.filename);
    res.status(201).json(prescription);
  } catch (err) {
    next(err);
  }
});

router.get('/patient/:id/view', authMiddleware, async (req, res, next) => {
  try {
    const patientId = req.params.id;

    // IDOR protection: verify the caller has access to this patient's prescriptions
    if (req.user.role === 'PATIENT') {
      const patientRecord = await prisma.patient.findUnique({
        where: { userId: req.user.id },
        select: { id: true }
      });
      if (patientRecord?.id !== patientId) {
        return res.status(403).json({ error: 'Forbidden: you can only view your own prescriptions' });
      }
    } else if (req.user.role === 'DOCTOR' || req.user.role === 'THERAPIST') {
      const isAssigned = await prisma.appointment.findFirst({
        where: {
          patientId,
          status: { in: ['CONFIRMED', 'COMPLETED', 'ASSIGNED'] },
          OR: [
            { doctor: { userId: req.user.id } },
            { therapist: { userId: req.user.id } },
          ]
        }
      });
      if (!isAssigned) {
        const journeyAssigned = await prisma.journey.findFirst({
          where: {
            patientId,
            OR: [
              { doctor: { userId: req.user.id } },
              { therapist: { userId: req.user.id } },
            ]
          }
        });
        if (!journeyAssigned) return res.status(403).json({ error: 'Forbidden: not assigned to this patient' });
      }
    }
    // ADMIN and ADMIN_DOCTOR can access any patient's prescriptions

    const prescriptions = await PrescriptionService.getPatientPrescriptions(patientId, req.user);
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
