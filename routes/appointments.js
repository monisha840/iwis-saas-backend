import express from 'express';
import { z } from 'zod';
import { AppointmentService } from '../services/appointment.service.js';
import { FollowUpService, FOLLOWUP_INTERVALS } from '../services/followUp.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditAction, auditDelete } from '../middleware/auditLog.js';
import prisma from '../lib/prisma.js';
import { notificationService } from '../services/notification.service.js';
import { WhatsAppService } from '../services/whatsapp.service.js';
import { VideoService } from '../services/video.service.js';

// Valid transitions: from → allowed next statuses
const VALID_STATUS_TRANSITIONS = {
  PENDING:                    ['CONFIRMED', 'CANCELLED', 'PENDING_DOCTOR_APPROVAL', 'PENDING_THERAPIST_APPROVAL'],
  PENDING_DOCTOR_APPROVAL:    ['ACCEPTED', 'CANCELLED', 'PENDING_THERAPIST_APPROVAL'],
  PENDING_THERAPIST_APPROVAL: ['ACCEPTED', 'CANCELLED', 'PENDING_DOCTOR_APPROVAL'],
  // CONFIRMED / ACCEPTED → IN_PROGRESS lets the therapist's "Start
  // Session" flow flip the appointment without going through the
  // doctor-centric queue (QueueEntry has a required doctorId, so
  // therapist-only appointments can't carry one).
  CONFIRMED:                  ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  ACCEPTED:                   ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS:                ['COMPLETED', 'CANCELLED'],
  SCHEDULED:                  ['CONFIRMED', 'CANCELLED'],
  COMPLETED:                  [],   // terminal
  CANCELLED:                  [],   // terminal
};

const router = express.Router();

const channelEnum = z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'IN_APP']);

const appointmentSchema = z.object({
  patientId: z.string().optional(),
  doctorId: z.string().nullable().optional(),
  therapistId: z.string().nullable().optional(),
  date: z.string(),
  status: z.enum(['PENDING', 'SCHEDULED', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'PENDING_THERAPIST_APPROVAL', 'PENDING_DOCTOR_APPROVAL', 'ACCEPTED', 'IN_PROGRESS']).optional(),
  triageSessionId: z.string().optional(),
  consultationType: z.enum(['DOCTOR', 'THERAPIST', 'COMBINED']).optional(),
  consultationMode: z.enum(['OFFLINE', 'ONLINE']).optional(),
  notes: z.string().optional(),
  branchId: z.string().optional(),
  contactDetails: z.object({
    fullName: z.string().min(2),
    phoneNumber: z.string(),
    email: z.string().email()
  }).optional(),
  // Optional per-appointment reminder template attached at booking time.
  customReminderTemplateId: z.string().nullable().optional(),
  customReminderBody: z.string().nullable().optional(),
  customReminderSubject: z.string().nullable().optional(),
  customReminderChannels: z.array(channelEnum).optional(),
  // Optional link to a TreatmentJourney — drives co-treater XP attribution
  // on JourneyFeedback. Server validates the journey exists and belongs to
  // the same patient before persisting.
  journeyId: z.string().nullable().optional(),
});

const reminderTemplatePatchSchema = z.object({
  templateId: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  channels: z.array(channelEnum).optional()
});

const followUpSchema = z.object({
  interval: z.enum(FOLLOWUP_INTERVALS),
  daysOffset: z.number().int().min(1).max(365).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

const updateAppointmentSchema = z.object({
  date: z.string().optional(),
  status: z.enum(['PENDING', 'SCHEDULED', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'PENDING_THERAPIST_APPROVAL', 'PENDING_DOCTOR_APPROVAL', 'ACCEPTED', 'IN_PROGRESS']).optional(),
  notes: z.string().optional(),
  doctorId: z.string().nullable().optional(),
  therapistId: z.string().nullable().optional(),
  therapistDate: z.string().nullable().optional(),
  // Required alongside status=COMPLETED unless a follow-up row already
  // exists for the appointment (validated server-side by the service).
  followUp: followUpSchema.optional(),
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
// ── Walk-In Appointment Booking (admin front-desk flow) ─────────────────────
//
// POST /api/appointments/walk-in — ADMIN / ADMIN_DOCTOR books a CONFIRMED
// appointment for a patient who arrived at the clinic. Bypasses the
// PENDING → APPROVED workflow used by patient-initiated bookings.
//
// Key behaviours that differ from the standard POST /:
//   - Status lands directly at CONFIRMED (not PENDING/PENDING_*_APPROVAL)
//   - doctorApproved / therapistApproved pre-set to true (no notification fan-out
//     to the clinician for approval — they get an in-app "booked for you" note)
//   - isWalkIn flag persisted for later reporting
//   - 409 with requiresOverride: true on conflict; client can resubmit with
//     overrideReason to force-book (the override reason is captured in notes
//     and the audit log)
//   - Past-time bookings are allowed (walk-in IS "right now")

const walkInSchema = z.object({
    patientId: z.string().optional(),
    guestPatientId: z.string().optional(),
    doctorId: z.string().min(1),
    therapistId: z.string().optional().nullable(),
    consultationType: z.enum(['DOCTOR', 'THERAPIST', 'COMBINED']).default('DOCTOR'),
    date: z.string().min(1),
    time: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format HH:mm'),
    notes: z.string().max(2000).optional(),
    overrideReason: z.string().max(500).optional(),
}).refine((d) => d.patientId || d.guestPatientId, {
    message: 'patientId or guestPatientId is required',
});

router.post(
    '/walk-in',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    validate({ body: walkInSchema }),
    async (req, res, next) => {
        try {
            const {
                patientId, guestPatientId, doctorId, therapistId,
                consultationType, date, time, notes, overrideReason,
            } = req.body;

            const resolvedPatientId = patientId || guestPatientId;

            // Build the appointment datetime from date + HH:mm.
            const [hours, minutes] = time.split(':').map(Number);
            const appointmentDate = new Date(date);
            appointmentDate.setHours(hours, minutes, 0, 0);

            // Conflict scan: any non-cancelled appointment within a ±15-minute
            // window for the same doctor (or therapist if specified). We use
            // the wider negative side (15 min before) because a 30-min slot
            // overlapping the start of an existing 1-hr appt is a real clash.
            const windowStart = new Date(appointmentDate.getTime() - 15 * 60 * 1000);
            const windowEnd = new Date(appointmentDate.getTime() + 30 * 60 * 1000);
            const conflict = await prisma.appointment.findFirst({
                where: {
                    OR: [
                        { doctorId },
                        ...(therapistId ? [{ therapistId }] : []),
                    ],
                    date: { gte: windowStart, lte: windowEnd },
                    status: { notIn: ['CANCELLED', 'REJECTED'] },
                },
                select: { id: true, status: true, date: true },
            });

            if (conflict && !overrideReason) {
                return res.status(409).json({
                    error: 'This slot is already booked',
                    conflictingAppointment: { id: conflict.id, status: conflict.status },
                    requiresOverride: true,
                });
            }

            // Branch resolution: prefer admin's branch; fall back to the
            // patient's branch so out-of-branch admins booking on behalf of a
            // patient still land in the right branch context.
            let branchIdToUse = req.user.branchId;
            if (!branchIdToUse) {
                const patientRow = await prisma.patient.findUnique({
                    where: { id: resolvedPatientId },
                    select: { branchId: true },
                });
                branchIdToUse = patientRow?.branchId || null;
            }
            if (!branchIdToUse) {
                return res.status(400).json({ error: 'No branch context available for this booking' });
            }

            const compiledNotes = overrideReason
                ? `Walk-in booking. Override reason: ${overrideReason}`
                : 'Walk-in booking by admin';

            const appointment = await prisma.appointment.create({
                data: {
                    patientId: resolvedPatientId,
                    doctorId,
                    therapistId: therapistId || null,
                    branchId: branchIdToUse,
                    date: appointmentDate,
                    status: 'CONFIRMED',
                    consultationType,
                    consultationMode: 'OFFLINE',
                    isWalkIn: true,
                    walkInNotes: notes || null,
                    doctorApproved: true,
                    therapistApproved: therapistId ? true : false,
                    notes: compiledNotes,
                },
                include: {
                    patient: {
                        select: {
                            id: true, fullName: true, phoneNumber: true,
                            user: { select: { id: true, email: true } },
                        },
                    },
                    doctor: { select: { id: true, userId: true, fullName: true } },
                    therapist: { select: { id: true, userId: true, fullName: true } },
                },
            });

            const patientName = appointment.patient?.fullName
                || appointment.patient?.user?.email
                || 'Walk-in patient';
            const dateLabel = appointmentDate.toLocaleDateString('en-IN', {
                day: 'numeric', month: 'short', year: 'numeric',
            });

            // In-app notification → assigned doctor (best-effort).
            try {
                if (appointment.doctor?.userId) {
                    await notificationService.createNotification({
                        userId: appointment.doctor.userId,
                        type: 'CLINICAL',
                        title: 'Walk-In Appointment Booked',
                        message: `${patientName} has been booked as a walk-in for ${time} on ${dateLabel} by admin.`,
                        priority: 'INFO',
                        relatedId: appointment.id,
                        data: { appointmentId: appointment.id, isWalkIn: true },
                    });
                }
                if (therapistId && appointment.therapist?.userId) {
                    await notificationService.createNotification({
                        userId: appointment.therapist.userId,
                        type: 'CLINICAL',
                        title: 'Walk-In Appointment Booked',
                        message: `${patientName} has been booked as a walk-in for ${time} on ${dateLabel} by admin.`,
                        priority: 'INFO',
                        relatedId: appointment.id,
                        data: { appointmentId: appointment.id, isWalkIn: true },
                    });
                }
            } catch (notifyErr) {
                console.warn('[walk-in] clinician notification skipped:', notifyErr.message);
            }

            // WhatsApp confirmation to patient (best-effort).
            try {
                const phone = appointment.patient?.phoneNumber;
                if (phone) {
                    await WhatsAppService.sendText(
                        phone,
                        `Hello ${patientName}! Your appointment at Al-Shifa has been confirmed for ${dateLabel} at ${time}. Please arrive 10 minutes early. Thank you!`,
                    );
                }
            } catch (smsErr) {
                console.warn('[walk-in] WhatsApp confirmation skipped:', smsErr.message);
            }

            // Audit log — best-effort.
            try {
                await prisma.auditLog.create({
                    data: {
                        userId: req.user.id,
                        action: 'WALK_IN_APPOINTMENT_CREATED',
                        entityType: 'Appointment',
                        entityId: appointment.id,
                        newData: {
                            patientId: resolvedPatientId,
                            doctorId,
                            therapistId: therapistId || null,
                            date: appointmentDate.toISOString(),
                            isWalkIn: true,
                            overrideReason: overrideReason || null,
                        },
                    },
                });
            } catch (auditErr) {
                console.warn('[walk-in] audit log skipped:', auditErr.message);
            }

            return res.status(201).json({ appointment });
        } catch (err) { next(err); }
    },
);

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
    // The service returns { slots, cacheStatus }. The booking flow expects a
    // bare array — keep the cacheStatus reachable as a response header for
    // ops + future client-side degraded-mode handling.
    const result = await AppointmentService.getAvailableSlots(clinicianId, date);
    if (result?.cacheStatus) res.set('X-Slot-Cache-Status', result.cacheStatus);
    res.json(result?.slots ?? []);
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

// GET /api/appointments/:id — single appointment fetch used by the
// Consultation Room (and any other surface that needs the full row).
// Was missing despite AppointmentsController.getById existing in the
// controllers file — that's why ConsultationRoom showed "Failed to
// fetch appointment details". Same role allowlist as the PUT below.
router.get('/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']), async (req, res, next) => {
  try {
    const appointment = await AppointmentService.getAppointmentById(req.params.id);
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    res.json(appointment);
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
    // Feature 5 — fire-and-forget follow-up task when this update flipped
    // the appointment to COMPLETED. Service inspects the patient's most
    // recent PAIN vital and only creates a task if value > 7.
    if (req.body.status === 'COMPLETED') {
      import('../services/followUpTask.service.js').then(({ fireFollowUpFromAppointmentCompletion }) => {
        fireFollowUpFromAppointmentCompletion(req.params.id);
      }).catch(() => { /* swallow — never block appointment update */ });
    }
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
    // Same shape as /available-slots: unwrap the array so callers don't
    // need to know about the internal { slots, cacheStatus } envelope.
    const result = await AppointmentService.getAvailableSlots(
      req.query.clinicianId,
      req.query.date,
      req.query.branchId
    );
    if (result?.cacheStatus) res.set('X-Slot-Cache-Status', result.cacheStatus);
    res.json(result?.slots ?? []);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/appointments/:id/reminder-template — attach or edit the per-appointment
// custom reminder message. Editable any time until the appointment is COMPLETED.
router.patch(
  '/:id/reminder-template',
  authMiddleware,
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']),
  validate({ body: reminderTemplatePatchSchema }),
  auditAction('UPDATE_APPOINTMENT_REMINDER', 'Appointment', (req) => req.params.id),
  async (req, res, next) => {
    try {
      const updated = await AppointmentService.updateReminderTemplate(req.params.id, req.user, req.body);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ── Follow-up schedule endpoints ────────────────────────────────────────
// Fetch the follow-up decision attached to a specific appointment. Any
// authenticated clinician/admin (or the owning patient — checked
// downstream) can read this for the consultation-room UI, patient
// portal history, or dashboard cards.
router.get('/:id/follow-up', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']), async (req, res, next) => {
  try {
    const followUp = await FollowUpService.getForAppointment(req.params.id);
    if (!followUp) return res.status(404).json({ error: 'No follow-up assigned to this appointment' });
    res.json({ data: followUp });
  } catch (err) {
    next(err);
  }
});

// Ad-hoc create/update of a follow-up WITHOUT flipping status (e.g. a
// doctor decides on the follow-up plan before marking the appointment
// COMPLETED, or edits the plan after the fact). Accepts the same
// payload shape as the PUT /:id completion flow.
const attachFollowUpSchema = z.object({ followUp: followUpSchema });

router.put('/:id/follow-up', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), validate({ body: attachFollowUpSchema }), auditAction('ATTACH_APPOINTMENT_FOLLOWUP', 'Appointment', (req) => req.params.id), async (req, res, next) => {
  try {
    const saved = await AppointmentService.attachFollowUp(req.params.id, req.user, req.body.followUp);
    res.json({ data: saved });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:id/video-session',
  authMiddleware,
  roleMiddleware(['DOCTOR', 'THERAPIST', 'PATIENT']),
  async (req, res, next) => {
    try {
      const appointment = await AppointmentService.getAppointmentById(req.params.id);
      if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

      const role = req.user.role;
      const userId = req.user.id;
      const isOwnDoctor    = role === 'DOCTOR'    && appointment.doctor?.userId    === userId;
      const isOwnTherapist = role === 'THERAPIST' && appointment.therapist?.userId === userId;
      const isOwnPatient   = role === 'PATIENT'   && appointment.patient?.userId   === userId;

      if (!isOwnDoctor && !isOwnTherapist && !isOwnPatient) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (appointment.consultationMode !== 'ONLINE') {
        return res.status(400).json({ error: 'Appointment is not a video consultation' });
      }
      if (!appointment.dailyRoomName) {
        return res.status(400).json({ error: 'Video room has not been provisioned for this appointment' });
      }
      if (!appointment.dailyRoomExpiry || appointment.dailyRoomExpiry <= new Date()) {
        return res.status(400).json({ error: 'Video room has expired' });
      }

      const isDailyRoom = typeof appointment.dailyRoomUrl === 'string'
        && appointment.dailyRoomUrl.includes('.daily.co/');

      let meetingToken = null;
      if (isDailyRoom) {
        const userName = isOwnDoctor
          ? (appointment.doctor?.fullName    || 'Doctor')
          : isOwnTherapist
            ? (appointment.therapist?.fullName || 'Therapist')
            : (appointment.patient?.fullName   || 'Patient');

        meetingToken = await VideoService.createMeetingToken({
          roomName:  appointment.dailyRoomName,
          userId,
          userName,
          isOwner:   isOwnDoctor || isOwnTherapist,
          expiresAt: appointment.dailyRoomExpiry,
        });
      }

      res.json({
        url:          appointment.dailyRoomUrl,
        roomName:     appointment.dailyRoomName,
        expiresAt:    appointment.dailyRoomExpiry,
        meetingToken,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
