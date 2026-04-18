import express from 'express';
import { z } from 'zod';
import { AppointmentService } from '../services/appointment.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditAction, auditDelete } from '../middleware/auditLog.js';

// Valid transitions: from → allowed next statuses
const VALID_STATUS_TRANSITIONS = {
  PENDING:                    ['CONFIRMED', 'CANCELLED', 'PENDING_DOCTOR_APPROVAL', 'PENDING_THERAPIST_APPROVAL'],
  PENDING_DOCTOR_APPROVAL:    ['ACCEPTED', 'CANCELLED', 'PENDING_THERAPIST_APPROVAL'],
  PENDING_THERAPIST_APPROVAL: ['ACCEPTED', 'CANCELLED', 'PENDING_DOCTOR_APPROVAL'],
  CONFIRMED:                  ['COMPLETED', 'CANCELLED'],
  ACCEPTED:                   ['COMPLETED', 'CANCELLED'],
  SCHEDULED:                  ['CONFIRMED', 'CANCELLED'],
  COMPLETED:                  [],   // terminal
  CANCELLED:                  [],   // terminal
};

const router = express.Router();

const appointmentSchema = z.object({
  patientId: z.string().optional(),
  doctorId: z.string().nullable().optional(),
  therapistId: z.string().nullable().optional(),
  date: z.string(),
  status: z.enum(['PENDING', 'SCHEDULED', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'PENDING_THERAPIST_APPROVAL', 'PENDING_DOCTOR_APPROVAL', 'ACCEPTED']).optional(),
  triageSessionId: z.string().optional(),
  consultationType: z.enum(['DOCTOR', 'THERAPIST', 'COMBINED']).optional(),
  consultationMode: z.enum(['OFFLINE', 'ONLINE']).optional(),
  notes: z.string().optional(),
  branchId: z.string().optional(),
  contactDetails: z.object({
    fullName: z.string().min(2),
    phoneNumber: z.string(),
    email: z.string().email()
  }).optional()
});

const updateAppointmentSchema = z.object({
  date: z.string().optional(),
  status: z.enum(['PENDING', 'SCHEDULED', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'PENDING_THERAPIST_APPROVAL', 'PENDING_DOCTOR_APPROVAL', 'ACCEPTED']).optional(),
  notes: z.string().optional(),
  doctorId: z.string().nullable().optional(),
  therapistId: z.string().nullable().optional(),
  therapistDate: z.string().nullable().optional()
});

/**
 * @swagger
 * /appointments:
 *   get:
 *     tags: [Appointments]
 *     summary: List appointments (role-scoped)
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, CONFIRMED, COMPLETED, CANCELLED] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Paginated list of appointments }
 */
router.get('/', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']), async (req, res, next) => {
  try {
    const appointments = await AppointmentService.getAppointments(req.user, req.query);
    res.json(appointments);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /appointments:
 *   post:
 *     tags: [Appointments]
 *     summary: Create a new appointment
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [patientId, date, consultationType]
 *             properties:
 *               patientId: { type: string }
 *               doctorId: { type: string }
 *               therapistId: { type: string }
 *               date: { type: string, format: date }
 *               timeSlot: { type: string }
 *               consultationType: { type: string, enum: [DOCTOR, THERAPIST, COMBINED] }
 *               consultationMode: { type: string, enum: [OFFLINE, ONLINE] }
 *               notes: { type: string }
 *               branchId: { type: string }
 *     responses:
 *       201: { description: Appointment created }
 *       400: { description: Validation error or slot unavailable }
 */
router.post('/', authMiddleware, roleMiddleware(['PATIENT', 'ADMIN', 'ADMIN_DOCTOR']), validate({ body: appointmentSchema }), auditAction('CREATE_APPOINTMENT', 'Appointment', () => null), async (req, res, next) => {
  try {
    // Strict control for PATIENT: ignore administrative fields
    if (req.user.role === 'PATIENT') {
      const { status, ...patientBody } = req.body;
      const appointment = await AppointmentService.createAppointment(req.user, patientBody);
      return res.status(201).json(appointment);
    }

    const appointment = await AppointmentService.createAppointment(req.user, req.body);
    res.status(201).json(appointment);
  } catch (err) {
    next(err);
  }
});

router.get('/available-slots', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']), async (req, res, next) => {
  try {
    const { clinicianId, date } = req.query;
    if (!clinicianId || !date) {
      return res.status(400).json({ error: 'clinicianId and date are required' });
    }
    const slots = await AppointmentService.getAvailableSlots(clinicianId, date);
    res.json(slots);
  } catch (err) {
    next(err);
  }
});

router.get('/available-staff', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']), async (req, res, next) => {
  try {
    const staff = await AppointmentService.getAvailableStaff(req.user, req.query);
    res.json(staff);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']), validate({ body: updateAppointmentSchema }), auditAction('UPDATE_APPOINTMENT', 'Appointment', (req) => req.params.id), async (req, res, next) => {
  try {
    // Validate status transition if a new status is provided
    if (req.body.status) {
      const existing = await AppointmentService.getAppointmentById(req.params.id);
      if (existing) {
        const allowed = VALID_STATUS_TRANSITIONS[existing.status] ?? [];
        if (!allowed.includes(req.body.status)) {
          const err = new Error(`Invalid status transition from '${existing.status}' to '${req.body.status}'`);
          err.status = 400;
          return next(err);
        }
      }
    }
    const appointment = await AppointmentService.updateAppointment(req.params.id, req.user, req.body);
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']), auditDelete('Appointment'), async (req, res, next) => {
  try {
    await AppointmentService.cancelAppointment(req.params.id, req.user);
    res.json({ message: 'Appointment cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/approve', authMiddleware, roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']), auditAction('APPROVE_APPOINTMENT', 'Appointment', (req) => req.params.id), async (req, res, next) => {
  try {
    const appointment = await AppointmentService.approveAppointment(req.params.id, req.user);
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/reject', authMiddleware, roleMiddleware(['DOCTOR', 'ADMIN', 'ADMIN_DOCTOR']), auditAction('REJECT_APPOINTMENT', 'Appointment', (req) => req.params.id), async (req, res, next) => {
  try {
    const { reason } = req.body;
    const appointment = await AppointmentService.updateAppointment(req.params.id, req.user, {
      status: 'CANCELLED',
      notes: reason ? `Rejected: ${reason}` : undefined
    });
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

// POST /api/appointments/hold — soft-hold a slot for 10 minutes
const holdSchema = z.object({
  clinicianId: z.string(),
  date: z.string(),
  time: z.string(),
});

router.post('/hold', authMiddleware, validate({ body: holdSchema }), async (req, res, next) => {
  try {
    const result = await AppointmentService.holdSlot(
      req.body.clinicianId,
      req.body.date,
      req.body.time,
      req.user.id
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/appointments/slots — available slots with hold info
const slotsQuerySchema = z.object({
  clinicianId: z.string(),
  date: z.string(),
  branchId: z.string().optional(),
});

router.get('/slots', authMiddleware, async (req, res, next) => {
  try {
    const slots = await AppointmentService.getAvailableSlots(
      req.query.clinicianId,
      req.query.date,
      req.query.branchId
    );
    res.json(slots);
  } catch (err) {
    next(err);
  }
});

export default router;
