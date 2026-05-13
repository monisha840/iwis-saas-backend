import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireFeature } from '../utils/featureGate.js';
import { CommunicationController } from '../controllers/communication.controller.js';

const router = express.Router();

const clinicianRoles = ['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR'];

// All routes require authentication + feature flag
router.use(authMiddleware);
router.use(requireFeature('HANDOFF_NOTES'));

// DD/MM/YYYY string → required for create. Service converts to ISO before
// persisting. We don't accept Date objects from the wire — text-input only,
// matching the platform-wide DateInput component.
// currentMedications / activeConditions / appointmentId-driven auto-populate
// were removed from the handoff create form — clinicians now read those off
// the auto-loaded patient-history panel (Feature 18) instead. Prisma columns
// are intentionally retained so existing handoff rows still surface their
// data on the read side.
const createHandoffSchema = z.object({
  patientId:     z.string().min(1, 'Patient is required'),
  toClinicianId: z.string().min(1, 'Please select a receiving doctor'),
  handoffDate:   z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'Use DD/MM/YYYY format'),
  toBranchId:    z.string().optional(),
  summary:       z.string().min(1, 'Summary is required'),
  nextSteps:     z.string().optional(),
  urgency:       z.string().optional(),
});

// POST / — create handoff note
router.post(
  '/',
  roleMiddleware(clinicianRoles),
  validate({ body: createHandoffSchema }),
  CommunicationController.createHandoff,
);

// GET /received — received handoffs
router.get(
  '/received',
  roleMiddleware(clinicianRoles),
  CommunicationController.getReceivedHandoffs,
);

// GET /sent — sent handoffs
router.get(
  '/sent',
  roleMiddleware(clinicianRoles),
  CommunicationController.getSentHandoffs,
);

// GET /patient/:patientId — patient's handoffs
router.get(
  '/patient/:patientId',
  roleMiddleware([...clinicianRoles, 'ADMIN']),
  CommunicationController.getPatientHandoffs,
);

// PATCH /:id/read — mark handoff as read
router.patch(
  '/:id/read',
  roleMiddleware(clinicianRoles),
  CommunicationController.markHandoffRead,
);

// GET /auto-populate/:appointmentId — auto-populate handoff from appointment
router.get(
  '/auto-populate/:appointmentId',
  roleMiddleware(clinicianRoles),
  CommunicationController.autoPopulateHandoff,
);

// PATCH /:id — edit a draft before sending (sender-only, draft-only)
router.patch(
  '/:id',
  roleMiddleware(clinicianRoles),
  CommunicationController.updateHandoff,
);

// POST /:id/send — promote a DRAFT handoff to SENT + deliver notification
router.post(
  '/:id/send',
  roleMiddleware(clinicianRoles),
  CommunicationController.sendHandoff,
);

export default router;
