import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import { PrescriptionService } from '../services/prescription.service.js';
import { MedicationLifecycleService } from '../services/medicationLifecycle.service.js';
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

// Advanced prescription search — text + status + date range + sort,
// with role-aware scoping (PATIENT to own; DOCTOR/THERAPIST to authored;
// ADMIN/ADMIN_DOCTOR/PHARMACIST to branch). Used by the new
// PrescriptionManagement filter UI + the pharmacist verification queue.
const prescriptionSearchSchema = z.object({
  q: z.string().optional(),
  status: z.enum(['ACTIVE', 'DISCONTINUED', 'FULLY_DISPENSED', 'OUT_OF_SUPPLY']).optional(),
  patientId: z.string().optional(),
  prescriberId: z.string().optional(),
  medicineId: z.string().optional(),
  hasVideo: z.preprocess(
    (v) => v === undefined ? undefined : (v === 'true' || v === true ? true : v === 'false' || v === false ? false : v),
    z.boolean().optional(),
  ),
  branchId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  sortBy: z.enum(['createdAt', 'medicationName', 'totalQuantity', 'dispensedQty']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.string().optional().transform(v => v ? parseInt(v, 10) : undefined),
  limit: z.string().optional().transform(v => v ? parseInt(v, 10) : undefined),
});

router.get('/search', authMiddleware, validate({ query: prescriptionSearchSchema }), async (req, res, next) => {
  try {
    const result = await PrescriptionService.searchPrescriptions(req.user, req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
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

// Inline-journey payload validated alongside the prescription batch. The
// service does the cross-row validation (e.g. THERAPIST_MEDICATION_RESTRICTION)
// because zod can't see req.user.role here.
const inlineJourneySchema = z.object({
  title:         z.string().min(1).max(200),
  condition:     z.string().min(1).max(200),
  goal:          z.string().min(1).max(500),
  targetEndDate: z.string().min(1),
  phases:        z.array(z.object({
    name:         z.string().min(1).max(120),
    durationDays: z.number().int().min(1),
    tasks:        z.array(z.object({
      type:        z.enum(['MEDICATION', 'EXERCISE', 'DIET', 'THERAPY', 'LIFESTYLE']),
      title:       z.string().min(1),
      description: z.string().optional(),
      frequency:   z.string().min(1),
    })).default([]),
  })).min(1),
});

// Optional home-therapy referral. The doctor toggles "therapy referral
// required" inside the prescription form and specifies a per-session mode
// (HOME / HOSPITAL) for each of the totalSessions sessions. Service does
// the cross-row validation (length match, role gate, patient branch).
const homeTherapySchema = z.object({
  totalSessions: z.number().int().min(1).max(50),
  sessionModes: z.array(z.enum(['HOME', 'HOSPITAL'])).min(1).max(50),
  // Optional scheduling interval between sessions, in days.
  // 1 = daily, 2 = every other day, 7 = weekly, etc. Null/undefined when
  // the doctor has not specified an interval.
  intervalDays: z.number().int().min(1).max(30).optional(),
  notes: z.string().max(500).optional(),
});

const batchPrescriptionSchema = z.object({
  patientId: z.string(),
  // Optional treatment-package context shared across all medicines in
  // this batch — written to Prescription.packageId on every row created.
  packageId: z.string().optional(),
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
  // Optional inline-journey draft. When present, the service wraps the
  // prescription rows + journey + phases + tasks in a single $transaction
  // and emits `journey_assigned` to the patient socket after commit.
  journey: inlineJourneySchema.optional(),
  // Optional home-therapy referral — when present, the service creates a
  // HomeTherapyRequest in PENDING_APPROVAL status inside the same tx.
  homeTherapy: homeTherapySchema.optional(),
});

const handleBatchAdd = async (req, res, next) => {
  try {
    const prescriptions = await PrescriptionService.createBatchPrescriptions(
      req.user,
      req.body.patientId,
      req.body.medicines,
      {
        packageId:    req.body.packageId    || null,
        journey:      req.body.journey      || null,
        homeTherapy:  req.body.homeTherapy  || null,
      },
    );
    res.status(201).json(prescriptions);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

router.post('/batch-add',
  authMiddleware,
  roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']),
  validate({ body: batchPrescriptionSchema }),
  auditAction('CREATE_PRESCRIPTION', 'Prescription', () => null),
  handleBatchAdd,
);

// Spec alias — POST /api/prescriptions accepts the same { patientId, medicines,
// journey?, packageId? } body as /batch-add. Kept as a sibling rather than a
// rewrite so existing /batch-add callers stay green.
router.post('/',
  authMiddleware,
  roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']),
  validate({ body: batchPrescriptionSchema }),
  auditAction('CREATE_PRESCRIPTION', 'Prescription', () => null),
  handleBatchAdd,
);

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

/**
 * Discontinue an active prescription. Stops all lifecycle reminders and
 * blocks further dose logging.
 * DOCTOR/THERAPIST: own only. ADMIN/ADMIN_DOCTOR: any in their hospital.
 */
const discontinueSchema = z.object({
  reason: z.string().max(500).optional(),
});
router.post('/:id/discontinue',
  authMiddleware,
  roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']),
  validate({ body: discontinueSchema }),
  auditAction('DISCONTINUE_PRESCRIPTION', 'Prescription', (req) => req.params.id),
  async (req, res, next) => {
    try {
      const result = await PrescriptionService.discontinuePrescription(req.user, req.params.id, req.body.reason);
      res.json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }
);

/**
 * Adherence + dispense history for a single prescription.
 * PATIENT: only their own. DOCTOR/THERAPIST: only if assigned. ADMIN/ADMIN_DOCTOR: any.
 */
router.get('/:id/adherence', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const rx = await prisma.prescription.findUnique({
      where: { id },
      select: {
        patientId: true,
        doctor: { select: { userId: true } },
        therapist: { select: { userId: true } },
      },
    });
    if (!rx) return res.status(404).json({ error: 'Prescription not found' });

    const role = req.user.role;
    if (role === 'PATIENT') {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
      });
      if (patient?.id !== rx.patientId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else if (role === 'DOCTOR' || role === 'THERAPIST') {
      const ownedByCaller = rx.doctor?.userId === req.user.id || rx.therapist?.userId === req.user.id;
      if (!ownedByCaller) return res.status(403).json({ error: 'Forbidden: not assigned to this prescription' });
    }
    // ADMIN / ADMIN_DOCTOR fall through

    const stats = await MedicationLifecycleService.getAdherenceStats(id);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

/**
 * Stream a one-page PDF rendition of a single prescription. Authorisation
 * mirrors GET /patient/:id — patients can pull their own, the authoring
 * clinician can pull what they prescribed, and ADMIN / ADMIN_DOCTOR can pull
 * any prescription. The PDF includes the prescriber's name + qualification,
 * the patient block, and dosage/frequency/duration/notes.
 */
router.get('/:id/pdf', authMiddleware, async (req, res, next) => {
  try {
    await PrescriptionService.streamPdf(req.params.id, req.user, res);
  } catch (err) {
    if (res.headersSent) {
      // Body already started — abort the response; don't send a JSON error after binary.
      try { res.end(); } catch { /* swallow */ }
      return;
    }
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
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
