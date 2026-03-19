import express from 'express';
import { z } from 'zod';
import { UserService } from '../services/user.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditAction, auditDelete } from '../middleware/auditLog.js';

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
  doctorId: z.string(),
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

const createUserSchema = z.object({
  email: z.string().email(),
  password: staffPassword,
  fullName: z.string(),
  role: z.enum(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST']),
  branchId: z.string().optional(),
});

const updateDoctorSchema = z.object({
  email: z.string().email().optional(),
  fullName: z.string().optional(),
  specialization: z.string().optional(),
  qualification: z.string().optional(),
  yearsExperience: z.number().optional(),
  clinic: z.string().optional(),
});

const updateTherapistSchema = z.object({
  email: z.string().email().optional(),
  fullName: z.string().optional(),
  specialization: z.string().optional(),
  qualification: z.string().optional(),
  yearsExperience: z.number().optional(),
  clinic: z.string().optional(),
});

const updatePatientSchema = z.object({
  email: z.string().email().optional(),
  fullName: z.string().optional(),
  phoneNumber: z.string().optional(),
  age: z.number().optional(),
  gender: z.string().optional(),
  therapyType: z.string().optional(),
  patientId: z.string().optional(),
});

const updatePharmacistSchema = z.object({
  email: z.string().email().optional(),
  fullName: z.string().optional(),
  qualification: z.string().optional(),
  yearsExperience: z.number().optional(),
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

router.put('/patient/onboarding', authMiddleware, roleMiddleware(['PATIENT']), validate({ body: onboardingSchema }), async (req, res, next) => {
  try {
    await UserService.updateOnboarding(req.user.id, req.body);
    res.json({ message: 'Onboarding completed successfully' });
  } catch (err) {
    next(err);
  }
});

router.post('/create', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: createUserSchema }), auditAction('CREATE_USER', 'User', (req) => null), async (req, res, next) => {
  try {
    const user = await UserService.createUser(req.body);
    res.status(201).json({ id: user.id, email: user.email, role: user.role });
  } catch (err) {
    next(err);
  }
});

router.post('/assign-patient', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ body: assignPatientSchema }), async (req, res, next) => {
  try {
    await UserService.assignPatient(req.body);
    res.json({ message: 'Patient assigned to doctor successfully' });
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