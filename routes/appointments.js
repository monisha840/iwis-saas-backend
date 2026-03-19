import express from 'express';
import { z } from 'zod';
import { AppointmentService } from '../services/appointment.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

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
  notes: z.string().optional()
});

router.get('/', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']), async (req, res, next) => {
  try {
    const appointments = await AppointmentService.getAppointments(req.user, req.query);
    res.json(appointments);
  } catch (err) {
    next(err);
  }
});

router.post('/', authMiddleware, roleMiddleware(['PATIENT', 'ADMIN', 'ADMIN_DOCTOR']), validate({ body: appointmentSchema }), async (req, res, next) => {
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

router.put('/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']), validate({ body: updateAppointmentSchema }), async (req, res, next) => {
  try {
    const appointment = await AppointmentService.updateAppointment(req.params.id, req.user, req.body);
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']), async (req, res, next) => {
  try {
    await AppointmentService.cancelAppointment(req.params.id, req.user);
    res.json({ message: 'Appointment cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/approve', authMiddleware, roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
  try {
    const appointment = await AppointmentService.approveAppointment(req.params.id, req.user);
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/reject', authMiddleware, roleMiddleware(['DOCTOR', 'ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
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

export default router;
