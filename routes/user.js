import express from 'express';
import { z } from 'zod';
import { UserService } from '../services/user.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditAction, auditDelete } from '../middleware/auditLog.js';
import { getUploadMiddleware, uploadToSupabase, BUCKETS } from '../middleware/upload.js';
import prisma from '../lib/prisma.js';

const router = express.Router();

const onboardingSchema = z.object({
  gender: z.string().optional(),
  // One or more preferred therapy types. Five canonical values exposed by the
  // onboarding UI today (AYURVEDA, YOGA, UNANI, SIDDHA, HOMEOPATHY) plus any
  // free-text values an admin may have entered through the bulk-import or
  // CreateUser flows. The `.min(1)` is mandatory — losing it would silently
  // weaken the "select at least one" requirement to "zero or more". Optional
  // at the wire level so a partial / resumed onboarding submission still
  // validates cleanly; the service-layer write is `undefined`-skipped when
  // not provided.
  therapyTypes: z.array(z.string().trim().min(1)).min(1, 'Select at least one therapy type').optional(),
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
  // When true, restrict the result to patients with at least one active or
  // completed appointment under the calling clinician. Used by pages that must
  // only show "my patients" (e.g. diet prescriptions) — falls back to the
  // branch-scoped list for ADMIN and ADMIN_DOCTOR.
  assignedToMe: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
});

const staffPassword = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

// Patient passwords are auto-generated as `<FirstName>@123` and the
// patient is forced to change them on first login, so we only require
// that the value is non-empty here. The strict staffPassword rules
// would reject short first names like "Al@123" (6 chars).
const patientPassword = z.string().min(4).max(128);

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
  // Validated post-superRefine based on role: staffPassword strength is
  // enforced for non-patient roles; patients use the auto-generated
  // `<FirstName>@123` value which only needs the non-empty check.
  password: z.string().min(1).max(128),
  fullName: z.string().min(2, 'Full name is required'),
  role: z.enum(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST']),
  // branchId is optional at the schema level. The service layer enforces
  // the per-role requirement (DOCTOR / BRANCH_ADMIN must have a branchId for
  // branch-scoped middleware to function), so optional here lets PATIENT /
  // ADMIN / ADMIN_DOCTOR / PHARMACIST records be created without one.
  branchId: z.string().min(1).optional(),

  phoneNumber: phoneShape.optional(),

  // Patient-only
  dob: dobShape.optional(),
  gender: z.enum(GENDERS).optional(),
  therapyTypes: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  // Human-readable Patient ID (e.g. "John@123"). Auto-generated by the
  // Create User UI for the PATIENT role; doubles as the initial password.
  patientId: z.string().trim().min(1).max(64).optional(),
  // Intake medical history captured at admission. Stored on the Patient
  // record's onboardingData JSON so it surfaces in triage/consultation.
  medicalHistory: z.object({
    patientType: z.enum(['NEW', 'RETURNING']),
    previousDoctorName: z.string().nullable().optional(),
    previousDoctorDetails: z.string().nullable().optional(),
  }).optional(),

  // ── Home Therapy: location & contact ───────────────────────────────────
  // Used for the home-therapy live-map and route planning. All optional at
  // intake; required only when the doctor flips a prescription's "therapy
  // referral required" toggle. Geocoded server-side on save.
  addressLine1:     z.string().trim().min(1).max(200).optional(),
  addressLine2:     z.string().trim().max(200).optional(),
  city:             z.string().trim().min(1).max(100).optional(),
  state:            z.string().trim().min(1).max(100).optional(),
  pincode:          z.string().trim().regex(/^[0-9]{6}$/, 'Pincode must be 6 digits').optional(),
  primaryPhone:     phoneShape.optional(),
  alternativePhone: phoneShape.optional(),

  // Clinician-only (DOCTOR / ADMIN_DOCTOR / THERAPIST / PHARMACIST)
  specialization:  z.string().min(1).optional(),
  qualification:   z.string().min(1).optional(),
  yearsExperience: z.number().int().min(0).max(80).optional(),
  clinic:          z.string().optional(),
  // Certificate / medical registration number. Required for DOCTOR,
  // ADMIN_DOCTOR, and THERAPIST via superRefine below.
  registrationNumber: z.string().trim().min(1).optional(),

  // Therapist-only — optional additional AyurvedicSkill tags written to
  // TherapistSkill rows at creation time. Accepts two formats:
  //   1. ['SHIRODHARA', 'ABHYANGA']            → bare enum strings; default proficiency
  //   2. [{ skill: 'SHIRODHARA', proficiency: 'CERTIFIED' }, ...] → structured rows
  // The structured form is preferred so the admin can pick a proficiency
  // level per skill from the Create User form. Bare strings remain accepted
  // for back-compat with older clients.
  initialSkills: z.array(z.union([
    z.enum([
      'ABHYANGA', 'SHIRODHARA', 'PANCHAKARMA_GENERAL', 'BASTI', 'VIRECHANA',
      'NASYA', 'KIZHI', 'NJAVARA', 'PIZHICHIL', 'MARMA_THERAPY', 'YOGA_THERAPY', 'NATUROPATHY',
    ]),
    z.object({
      skill: z.enum([
        'ABHYANGA', 'SHIRODHARA', 'PANCHAKARMA_GENERAL', 'BASTI', 'VIRECHANA',
        'NASYA', 'KIZHI', 'NJAVARA', 'PIZHICHIL', 'MARMA_THERAPY', 'YOGA_THERAPY', 'NATUROPATHY',
      ]),
      proficiency: z.enum(['CERTIFIED', 'EXPERIENCED', 'LEARNING']).default('EXPERIENCED'),
    }),
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
    // Patient password is auto-generated; only require it to be non-empty.
    const patientCheck = patientPassword.safeParse(val.password);
    if (!patientCheck.success) {
      patientCheck.error.issues.forEach((iss) => ctx.addIssue({ ...iss, path: ['password'] }));
    }
  } else {
    // All non-patient roles must satisfy the strong staffPassword policy.
    const staffCheck = staffPassword.safeParse(val.password);
    if (!staffCheck.success) {
      staffCheck.error.issues.forEach((iss) => ctx.addIssue({ ...iss, path: ['password'] }));
    }
  }
  if (val.role === 'DOCTOR' || val.role === 'ADMIN_DOCTOR') {
    req('specialization');
    req('qualification');
    req('yearsExperience');
    req('registrationNumber');
  }
  if (val.role === 'THERAPIST') {
    // Therapists no longer carry specialization — gender (MALE / FEMALE) is
    // the only categorical attribute. Skill matrix is seeded via initialSkills.
    req('gender');
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
  // Specialization removed — therapists are categorized by gender only.
  gender: z.enum(GENDERS).nullable().optional(),
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
  therapyTypes: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  patientId: z.string().nullable().optional(),
  branchId: z.string().min(1, 'Branch is required').optional(),

  // Home Therapy address & contact — re-geocoded server-side on every save
  addressLine1:     z.string().trim().max(200).nullable().optional(),
  addressLine2:     z.string().trim().max(200).nullable().optional(),
  city:             z.string().trim().max(100).nullable().optional(),
  state:            z.string().trim().max(100).nullable().optional(),
  pincode:          z.string().trim().regex(/^[0-9]{6}$/, 'Pincode must be 6 digits').nullable().optional(),
  primaryPhone:     z.string().regex(/^\+?[0-9]{7,15}$/, 'Invalid phone format').nullable().optional(),
  alternativePhone: z.string().regex(/^\+?[0-9]{7,15}$/, 'Invalid phone format').nullable().optional(),
});

const updatePharmacistSchema = z.object({
  email: z.string().email().min(1, 'Email is required').optional(),
  fullName: z.string().min(2, 'Full name is required').optional(),
  qualification: z.string().nullable().optional(),
  yearsExperience: z.number().int().nonnegative().nullable().optional(),
  branchId: z.string().min(1, 'Branch is required').optional(),
});

// DOCTOR + THERAPIST need this to populate the Receiving Clinician dropdown
// on the Handoff Notes form. Branch scoping below still keeps non-admins
// pinned to their own branch so they can't enumerate staff elsewhere.
router.get('/list-therapists', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR', 'THERAPIST']), validate({ query: listTherapistsSchema }), async (req, res, next) => {
  try {
    const { search } = req.query;
    // BRANCH_ADMIN, DOCTOR, THERAPIST are hard-pinned to their JWT branch —
    // query param is ignored so it can't be used to peek at staff elsewhere.
    const branchScoped = ['BRANCH_ADMIN', 'DOCTOR', 'THERAPIST'].includes(req.user.role);
    const branchId = branchScoped ? req.user.branchId : req.query.branchId;
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

// DOCTOR + THERAPIST also need this for handoff routing. Branch scoping
// below pins non-admins to their JWT branch.
router.get('/list-doctors', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR', 'THERAPIST']), validate({ query: listDoctorsSchema }), async (req, res, next) => {
  try {
    const { search } = req.query;
    const branchScoped = ['BRANCH_ADMIN', 'DOCTOR', 'THERAPIST'].includes(req.user.role);
    const branchId = branchScoped ? req.user.branchId : req.query.branchId;
    // Exclude the calling admin doctor from the dropdown — the AssignPatient
    // page surfaces them via a dedicated "Assign to me" button instead, so the
    // dropdown is reserved for assigning to other clinicians.
    const excludeUserId = req.user.role === 'ADMIN_DOCTOR' ? req.user.id : null;
    const data = await UserService.listDoctors({ branchId, search, excludeUserId });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/list-pharmacists', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']), async (req, res, next) => {
  try {
    // BRANCH_ADMIN is hard-pinned to their JWT branch — same scoping rule
    // used by /list-doctors and /list-therapists so a branch admin can't
    // peek at staff in another branch.
    const branchId = req.user.role === 'BRANCH_ADMIN' ? req.user.branchId : (req.query.branchId || null);
    const data = await UserService.listPharmacists({ branchId });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/list-patients', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR', 'THERAPIST', 'PHARMACIST']), validate({ query: listPatientsSchema }), async (req, res, next) => {
  try {
    const { branchId: queryBranchId, search, assignedToMe } = req.query;
    // Branch-scoped roles are hard-pinned to their JWT branchId so the query
    // param can't be used to peek at patients in another branch.
    // ADMINs and ADMIN_DOCTORs see all patients across branches.
    const isBranchScoped = ['BRANCH_ADMIN', 'PHARMACIST', 'DOCTOR', 'THERAPIST'].includes(req.user.role);
    const branchId = isBranchScoped
      ? req.user.branchId
      : (queryBranchId || null);

    // Resolve the caller's Doctor/Therapist primary key when "my patients only"
    // is requested. ADMIN_DOCTORs bypass — they consult on every patient.
    let assignedDoctorId = null;
    let assignedTherapistId = null;
    const wantAssignedFilter = assignedToMe === true || assignedToMe === 'true';
    if (wantAssignedFilter && req.user.role === 'DOCTOR') {
      const doctor = await prisma.doctor.findFirst({
        where: { userId: req.user.id },
        select: { id: true },
      });
      // Orphan account (no Doctor row) → return empty rather than fall back to
      // an unscoped list, otherwise the filter would silently leak every patient.
      if (!doctor) return res.json([]);
      assignedDoctorId = doctor.id;
    } else if (wantAssignedFilter && req.user.role === 'THERAPIST') {
      const therapist = await prisma.therapist.findFirst({
        where: { userId: req.user.id },
        select: { id: true },
      });
      if (!therapist) return res.json([]);
      assignedTherapistId = therapist.id;
    }

    const data = await UserService.listPatients({
      branchId, search, assignedDoctorId, assignedTherapistId,
    });
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
//
// addressLine1..pincode + primaryPhone/alternativePhone are PATIENT-only and
// drive the Home Therapy geocoder. Empty strings are accepted for stringy
// fields so the patient dashboard can clear a value; the regex-validated
// fields (pincode, phones) accept either a valid value, empty string, or null.
const optionalEmptyOrRegex = (re, message) =>
  z.union([z.literal(''), z.string().regex(re, message)]).nullable().optional();

const updateMeSchema = z.object({
  fullName: z.string().min(2).max(100).optional(),
  phoneNumber: z.string().regex(/^\+?[0-9]{7,15}$/).nullable().optional(),
  profilePhoto: z.string().url().nullable().optional(),
  clinic: z.string().max(200).nullable().optional(),
  bio: z.string().max(1000).nullable().optional(),
  languages: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  dob: dobShape.optional(),
  gender: z.enum(GENDERS).optional(),
  therapyTypes: z.array(z.string().trim().min(1).max(100)).max(20).optional(),

  addressLine1:     z.string().trim().max(200).nullable().optional(),
  addressLine2:     z.string().trim().max(200).nullable().optional(),
  city:             z.string().trim().max(100).nullable().optional(),
  state:            z.string().trim().max(100).nullable().optional(),
  pincode:          optionalEmptyOrRegex(/^[0-9]{6}$/, 'Pincode must be 6 digits'),
  primaryPhone:     optionalEmptyOrRegex(/^\+?[0-9]{7,15}$/, 'Invalid phone format'),
  alternativePhone: optionalEmptyOrRegex(/^\+?[0-9]{7,15}$/, 'Invalid phone format'),
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
  SUPER_ADMIN:  ['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST'],
  ADMIN_DOCTOR: ['ADMIN', 'BRANCH_ADMIN', 'DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST'],
  ADMIN:        ['BRANCH_ADMIN', 'DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST'],
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

router.post('/assign-patient', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']), validate({ body: assignPatientSchema }), async (req, res, next) => {
  try {
    // BRANCH_ADMIN: defence-in-depth check — verify both targets belong to the
    // caller's branch BEFORE delegating to the service layer. The service
    // already enforces branch parity between patient and doctor, but the spec
    // requires an explicit "Assignment targets must belong to your branch."
    // error and binds the branch to req.user.branchId (not query/body).
    if (req.user.role === 'BRANCH_ADMIN') {
      const [patient, doctor] = await Promise.all([
        prisma.patient.findUnique({ where: { id: req.body.patientId }, select: { branchId: true } }),
        prisma.doctor.findUnique({ where: { id: req.body.doctorId },  include: { user: { select: { branchId: true } } } }),
      ]);
      const doctorBranchId = doctor?.user?.branchId ?? null;
      if (!patient || !doctor
        || patient.branchId !== req.user.branchId
        || doctorBranchId !== req.user.branchId) {
        return res.status(403).json({ error: 'Assignment targets must belong to your branch.' });
      }
    }

    const record = await UserService.assignPatient({
      ...req.body,
      assignedById:     req.user.id,
      // ADMIN has cross-branch authority; ADMIN_DOCTOR + BRANCH_ADMIN are branch-scoped.
      allowCrossBranch: req.user.role === 'ADMIN',
    });
    res.json({ message: 'Patient assigned to doctor successfully', assignment: record });
  } catch (err) {
    next(err);
  }
});

router.post('/unassign-patient', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']), validate({ body: unassignPatientSchema }), async (req, res, next) => {
  try {
    if (req.user.role === 'BRANCH_ADMIN') {
      const [patient, doctor] = await Promise.all([
        prisma.patient.findUnique({ where: { id: req.body.patientId }, select: { branchId: true } }),
        prisma.doctor.findUnique({ where: { id: req.body.doctorId },  include: { user: { select: { branchId: true } } } }),
      ]);
      const doctorBranchId = doctor?.user?.branchId ?? null;
      if (!patient || !doctor
        || patient.branchId !== req.user.branchId
        || doctorBranchId !== req.user.branchId) {
        return res.status(403).json({ error: 'Assignment targets must belong to your branch.' });
      }
    }

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

router.get('/patient/:id/assignments', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR']), async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status) : 'ACTIVE';
    const data = await UserService.getPatientAssignments(req.params.id, { status });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/user/export — flattened export of every user across roles.
// Returns JSON by default; `?format=csv` streams a downloadable CSV.
router.get('/export', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
  try {
    const branchId = req.query.branchId
      ? String(req.query.branchId)
      : (req.user.role === 'ADMIN_DOCTOR' ? req.user.branchId : null);
    const role = req.query.role ? String(req.query.role) : null;
    const includeDeleted = req.query.includeDeleted === 'true';
    const rows = await UserService.exportAllUsers({ branchId, role, includeDeleted });

    if (req.query.format === 'csv') {
      const header = ['id', 'fullName', 'email', 'role', 'branchId', 'branchName', 'phoneNumber', 'status', 'createdAt'];
      // Escape per RFC 4180: wrap in quotes, double internal quotes.
      const csvCell = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csvRows = [
        header.join(','),
        ...rows.map((r) => header.map((h) => csvCell(r[h])).join(',')),
      ].join('\r\n');
      const filename = `users-export-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csvRows);
    }

    res.json({ users: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

router.get('/list-unassigned-patients', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']), async (req, res, next) => {
  try {
    // BRANCH_ADMIN is hard-pinned to their JWT branch; ADMIN_DOCTOR defaults to
    // their own branch but can pass a query param; ADMIN sees hospital-wide.
    const branchId = req.user.role === 'BRANCH_ADMIN'
      ? req.user.branchId
      : (req.query.branchId
          ? String(req.query.branchId)
          : (req.user.role === 'ADMIN_DOCTOR' ? req.user.branchId : null));
    const data = await UserService.listUnassignedPatients({
      branchId,
      hospitalId: req.user.hospitalId ?? null,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/patient/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR', 'THERAPIST', 'PHARMACIST']), async (req, res, next) => {
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

// PATCH alias — the home-therapy spec uses PATCH for partial address edits.
// Both verbs route to the same handler so callers can use either.
router.patch('/patient/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: updatePatientSchema }), auditAction('UPDATE_USER', 'User', (req) => req.params.id), async (req, res, next) => {
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