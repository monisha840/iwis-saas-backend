import express from 'express';
import { z } from 'zod';
import { UserService } from '../services/user.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditAction, auditDelete } from '../middleware/auditLog.js';
import { getUploadMiddleware, uploadToSupabase, BUCKETS } from '../middleware/upload.js';

const router = express.Router();

const onboardingSchema = z.object({
  gender: z.string().optional(),
  sleepBedtime: z.string().optional(),
  sleepWakeTime: z.string().optional(),
  sleepDuration: z.number().optional(),
  painLevel: z.number().min(0).max(10).optional(),
  painLocations: z.array(z.string()).optional(),
  otherHealthInputs: z.record(z.any()).optional(),
});

const assignPatientSchema = z.object({
  patientId: z.string(),
  doctorId:  z.string(),
  type:      z.enum(['PRIMARY', 'CONSULTING', 'TEMPORARY']).default('PRIMARY').optional(),
  reason:    z.string().optional(),
});

const unassignPatientSchema = z.object({
  patientId: z.string(),
  doctorId:  z.string(),
  type:      z.enum(['PRIMARY', 'CONSULTING', 'TEMPORARY']).optional(),
  reason:    z.string().optional(),
});

const listDoctorsSchema = z.object({
  branchId: z.string().optional(),
  search:   z.string().optional(),
});

const listTherapistsSchema = z.object({
  branchId: z.string().optional(),
  search:   z.string().optional(),
});

const listPatientsSchema = z.object({
  branchId: z.string().optional(),
  search:   z.string().optional(),
});

const staffPassword = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

const GENDERS = ['FEMALE', 'MALE', 'OTHER', 'PREFER_NOT_TO_SAY'];
const phoneShape = z.string()
  .regex(/^\+?[0-9]{7,15}$/, 'Phone must be 7-15 digits, optional leading +');

// Date-only ISO (YYYY-MM-DD) that parses to a plausible past date (0-130 years).
const dobShape = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(s + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return false;
    const ageYears = (Date.now() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    return ageYears >= 0 && ageYears <= 130;
  }, 'Date of birth must be a valid past date');

// One schema, role-conditional required fields enforced via superRefine so each
// missing field returns a path-targeted error (better UX than a single blob).
const createUserSchema = z.object({
  email: z.string().email(),
  password: staffPassword,
  fullName: z.string().min(2, 'Full name is required'),
  role: z.enum(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST']),
  branchId: z.string().min(1, 'Branch is required'),

  phoneNumber: phoneShape.optional(),

  // Patient-only
  dob: dobShape.optional(),
  gender: z.enum(GENDERS).optional(),
  therapyType: z.string().optional(),

  // Clinician-only (DOCTOR / ADMIN_DOCTOR / THERAPIST / PHARMACIST)
  specialization:  z.string().min(1).optional(),
  qualification:   z.string().min(1).optional(),
  yearsExperience: z.number().int().min(0).max(80).optional(),
  clinic:          z.string().optional(),
  // Certificate / medical registration number. Required for DOCTOR,
  // ADMIN_DOCTOR, and THERAPIST via superRefine below.
  registrationNumber: z.string().trim().min(1).optional(),

  // Therapist-only — optional additional AyurvedicSkill tags written to
  // TherapistSkill rows at creation time. Saves an extra admin step.
  initialSkills: z.array(z.enum([
    'ABHYANGA', 'SHIRODHARA', 'PANCHAKARMA_GENERAL', 'BASTI', 'VIRECHANA',
    'NASYA', 'KIZHI', 'NJAVARA', 'PIZHICHIL', 'MARMA_THERAPY', 'YOGA_THERAPY', 'NATUROPATHY',
  ])).optional(),
}).superRefine((val, ctx) => {
  const req = (field) => {
    if (val[field] === undefined || val[field] === null || val[field] === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for ${val.role}` });
    }
  };

  if (val.role === 'PATIENT') {
    req('dob');
    req('gender');
    req('phoneNumber');
  }
  if (val.role === 'DOCTOR' || val.role === 'ADMIN_DOCTOR' || val.role === 'THERAPIST') {
    req('specialization');
    req('qualification');
    req('yearsExperience');
    req('registrationNumber');
  }
  if (val.role === 'PHARMACIST') {
    req('qualification');
    req('yearsExperience');
  }
});

const updateDoctorSchema = z.object({
  email: z.string().email().min(1, 'Email is required').optional(),
  fullName: z.string().min(2, 'Full name is required').optional(),
  specialization: z.string().nullable().optional(),
  qualification: z.string().nullable().optional(),
  yearsExperience: z.number().int().nonnegative().nullable().optional(),
  clinic: z.string().nullable().optional(),
  branchId: z.string().min(1, 'Branch is required').optional(),
});

const updateTherapistSchema = z.object({
  email: z.string().email().min(1, 'Email is required').optional(),
  fullName: z.string().min(2, 'Full name is required').optional(),
  specialization: z.string().nullable().optional(),
  qualification: z.string().nullable().optional(),
  yearsExperience: z.number().int().nonnegative().nullable().optional(),
  clinic: z.string().nullable().optional(),
  branchId: z.string().min(1, 'Branch is required').optional(),
});

const updatePatientSchema = z.object({
  email: z.string().email().min(1, 'Email is required').optional(),
  fullName: z.string().min(2, 'Full name is required').optional(),
  phoneNumber: z.string().regex(/^\+?[0-9]{7,15}$/, 'Invalid phone format').nullable().optional(),
  age: z.number().int().min(0).max(150).nullable().optional(),
  gender: z.string().nullable().optional(),
  therapyType: z.string().nullable().optional(),
  patientId: z.string().nullable().optional(),
  branchId: z.string().min(1, 'Branch is required').optional(),
});

const updatePharmacistSchema = z.object({
  email: z.string().email().min(1, 'Email is required').optional(),
  fullName: z.string().min(2, 'Full name is required').optional(),
  qualification: z.string().nullable().optional(),
  yearsExperience: z.number().int().nonnegative().nullable().optional(),
  branchId: z.string().min(1, 'Branch is required').optional(),
});

router.get('/list-therapists', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ query: listTherapistsSchema }), async (req, res, next) => {
  try {
    const { branchId, search } = req.query;
    const data = await UserService.listTherapists({ branchId, search });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/doctor-gamification', authMiddleware, roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'ADMIN', 'THERAPIST']), async (req, res, next) => {
  try {
    const data = await UserService.getClinicalGamification();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/list-doctors', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ query: listDoctorsSchema }), async (req, res, next) => {
  try {
    const { branchId, search } = req.query;
    const data = await UserService.listDoctors({ branchId, search });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/list-pharmacists', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
  try {
    const data = await UserService.listPharmacists();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/list-patients', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PHARMACIST']), validate({ query: listPatientsSchema }), async (req, res, next) => {
  try {
    const { branchId: queryBranchId, search } = req.query;
    // Branch-scoped roles default to their own branch when no explicit branchId is requested.
    // ADMINs and ADMIN_DOCTORs see all patients across branches.
    const branchId = queryBranchId ||
      (['PHARMACIST', 'DOCTOR', 'THERAPIST'].includes(req.user.role) ? req.user.branchId : null);
    const data = await UserService.listPatients({ branchId, search });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const data = await UserService.getCurrentUser(req.user.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * Feature set for the current user's hospital. The UI reads this once after
 * login to hide nav items / CTAs for features the tenant has disabled.
 *
 * Returns BOTH:
 *   - registered: every feature key present in FeatureRegistry (the universe)
 *   - enabled: the subset enabled for this hospital (isCore bypass applied)
 *
 * The frontend treats unregistered keys as fail-open so newly-built features
 * surface in nav even before their FeatureRegistry row has been seeded. Only
 * keys that are registered BUT not in the enabled list get hidden.
 */
router.get('/features', authMiddleware, async (req, res, next) => {
  try {
    const { default: prisma } = await import('../lib/prisma.js');
    const registryRows = await prisma.featureRegistry.findMany({ select: { key: true } });
    const registered = registryRows.map(r => r.key);

    // SUPER_ADMIN: every registered feature counts as enabled.
    if (req.user.role === 'SUPER_ADMIN' || !req.user.hospitalId) {
      return res.json({
        registered,
        enabled: registered,
        isSuperAdmin: req.user.role === 'SUPER_ADMIN',
      });
    }

    const rows = await prisma.hospitalFeatureFlag.findMany({
      where: { hospitalId: req.user.hospitalId },
      include: { feature: { select: { key: true, isCore: true } } },
    });
    const enabled = rows
      .filter(r => r.feature.isCore || r.enabled)
      .map(r => r.feature.key);

    res.json({ registered, enabled, isSuperAdmin: false });
  } catch (err) {
    next(err);
  }
});

// Self-service profile update. Email / role / branch are intentionally excluded —
// those are identity/tenancy changes that must go through an admin.
// phoneNumber / bio / languages apply to clinicians (DOCTOR / ADMIN_DOCTOR /
// THERAPIST / PHARMACIST) and patients — the service layer picks the right row.
const updateMeSchema = z.object({
  fullName: z.string().min(2).max(100).optional(),
  phoneNumber: z.string().regex(/^\+?[0-9]{7,15}$/).nullable().optional(),
  profilePhoto: z.string().url().nullable().optional(),
  clinic: z.string().max(200).nullable().optional(),
  bio: z.string().max(1000).nullable().optional(),
  languages: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  dob: dobShape.optional(),
  gender: z.enum(GENDERS).optional(),
  therapyType: z.string().max(100).nullable().optional(),
});

router.patch(
  '/me',
  authMiddleware,
  validate({ body: updateMeSchema }),
  auditAction('UPDATE_SELF_PROFILE', 'User', (req) => req.user.id),
  async (req, res, next) => {
    try {
      const data = await UserService.updateMe(req.user.id, req.body);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

const photoUpload = getUploadMiddleware({ maxSizeMb: 5, fieldName: 'file' });
router.post(
  '/me/photo',
  authMiddleware,
  photoUpload,
  auditAction('UPDATE_SELF_PROFILE_PHOTO', 'User', (req) => req.user.id),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file is required' });
      if (!req.file.mimetype?.startsWith('image/')) {
        return res.status(400).json({ error: 'Only image files are accepted' });
      }
      const url = await uploadToSupabase(req.file, BUCKETS.PROFILE_PICTURES);
      const data = await UserService.updateMe(req.user.id, { profilePhoto: url });
      res.json({ url, user: data });
    } catch (err) {
      next(err);
    }
  }
);

router.put('/patient/onboarding', authMiddleware, roleMiddleware(['PATIENT']), validate({ body: onboardingSchema }), async (req, res, next) => {
  try {
    await UserService.updateOnboarding(req.user.id, req.body);
    res.json({ message: 'Onboarding completed successfully' });
  } catch (err) {
    next(err);
  }
});

// Role-creation matrix — enforces privilege boundaries at the API layer.
// Without this, any ADMIN could create another ADMIN or elevate to ADMIN_DOCTOR.
// Keep in sync with roleMiddleware() gate below.
const ROLE_CREATE_MATRIX = {
  SUPER_ADMIN:  ['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST'],
  ADMIN_DOCTOR: ['ADMIN', 'DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST'],
  ADMIN:        ['DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST'],
};

router.post(
  '/create',
  authMiddleware,
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN']),
  validate({ body: createUserSchema }),
  (req, res, next) => {
    const allowed = ROLE_CREATE_MATRIX[req.user.role] || [];
    if (!allowed.includes(req.body.role)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `${req.user.role} cannot create a user with role ${req.body.role}`,
      });
    }
    next();
  },
  auditAction('CREATE_USER', 'User', (req) => null),
  async (req, res, next) => {
    try {
      const user = await UserService.createUser(req.body);
      res.status(201).json({ id: user.id, email: user.email, role: user.role });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/assign-patient', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: assignPatientSchema }), async (req, res, next) => {
  try {
    const record = await UserService.assignPatient({
      ...req.body,
      assignedById:     req.user.id,
      // ADMIN has cross-branch authority; ADMIN_DOCTOR is branch-scoped.
      allowCrossBranch: req.user.role === 'ADMIN',
    });
    res.json({ message: 'Patient assigned to doctor successfully', assignment: record });
  } catch (err) {
    next(err);
  }
});

router.post('/unassign-patient', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: unassignPatientSchema }), async (req, res, next) => {
  try {
    const result = await UserService.unassignPatient({
      patientId: req.body.patientId,
      doctorId:  req.body.doctorId,
      type:      req.body.type,
      endReason: req.body.reason,
      endedById: req.user.id,
    });
    res.json({ message: 'Assignment ended', ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/patient/:id/assignments', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']), async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status) : 'ACTIVE';
    const data = await UserService.getPatientAssignments(req.params.id, { status });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/list-unassigned-patients', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
  try {
    // ADMIN_DOCTOR defaults to their own branch; ADMIN sees hospital-wide
    // unless a branchId is explicitly passed.
    const branchId = req.query.branchId
      ? String(req.query.branchId)
      : (req.user.role === 'ADMIN_DOCTOR' ? req.user.branchId : null);
    const data = await UserService.listUnassignedPatients({
      branchId,
      hospitalId: req.user.hospitalId ?? null,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/patient/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PHARMACIST']), async (req, res, next) => {
  try {
    const data = await UserService.getPatientById(req.params.id, req.user);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/doctor/stats', authMiddleware, roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR']), async (req, res, next) => {
  try {
    const data = await UserService.getDoctorStats(req.user.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/admin/stats', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
  try {
    const data = await UserService.getAdminStats();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/assigned-patients', authMiddleware, roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']), async (req, res, next) => {
  try {
    const data = await UserService.getAssignedPatients(req.user.id, req.user.role);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.delete('/doctor/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), auditDelete('User'), async (req, res, next) => {
  try {
    await UserService.deleteUser('doctor', req.params.id);
    res.json({ message: 'Doctor deleted successfully', id: req.params.id });
  } catch (err) {
    next(err);
  }
});

router.delete('/therapist/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), auditDelete('User'), async (req, res, next) => {
  try {
    await UserService.deleteUser('therapist', req.params.id);
    res.json({ message: 'Therapist deleted successfully', id: req.params.id });
  } catch (err) {
    next(err);
  }
});

router.delete('/patient/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), auditDelete('User'), async (req, res, next) => {
  try {
    await UserService.deleteUser('patient', req.params.id);
    res.json({ message: 'Patient deleted successfully', id: req.params.id });
  } catch (err) {
    next(err);
  }
});

router.delete('/pharmacist/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), auditDelete('User'), async (req, res, next) => {
  try {
    await UserService.deleteUser('pharmacist', req.params.id);
    res.json({ message: 'Pharmacist deleted successfully', id: req.params.id });
  } catch (err) {
    next(err);
  }
});

router.put('/doctor/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: updateDoctorSchema }), auditAction('UPDATE_USER', 'User', (req) => req.params.id), async (req, res, next) => {
  try {
    await UserService.updateProfile('doctor', req.params.id, req.body);
    res.json({ message: 'Doctor updated successfully' });
  } catch (err) {
    next(err);
  }
});

router.put('/therapist/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: updateTherapistSchema }), auditAction('UPDATE_USER', 'User', (req) => req.params.id), async (req, res, next) => {
  try {
    await UserService.updateProfile('therapist', req.params.id, req.body);
    res.json({ message: 'Therapist updated successfully' });
  } catch (err) {
    next(err);
  }
});

router.put('/patient/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: updatePatientSchema }), auditAction('UPDATE_USER', 'User', (req) => req.params.id), async (req, res, next) => {
  try {
    await UserService.updateProfile('patient', req.params.id, req.body);
    res.json({ message: 'Patient updated successfully' });
  } catch (err) {
    next(err);
  }
});

router.put('/pharmacist/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: updatePharmacistSchema }), auditAction('UPDATE_USER', 'User', (req) => req.params.id), async (req, res, next) => {
  try {
    await UserService.updateProfile('pharmacist', req.params.id, req.body);
    res.json({ message: 'Pharmacist updated successfully' });
  } catch (err) {
    next(err);
  }
});

export default router;