import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { PortalController } from '../controllers/portal.controller.js';

const router = express.Router();

const clinicianRoles = ['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR'];

// All routes require authentication + feature flag
router.use(authMiddleware);
router.use(requireFeature('VISIT_SUMMARY'));

// POST / — create visit summary
router.post(
  '/',
  roleMiddleware(clinicianRoles),
  PortalController.createVisitSummary,
);

// GET /appointment/:appointmentId — get visit summary by appointment
router.get(
  '/appointment/:appointmentId',
  roleMiddleware([...clinicianRoles, 'PATIENT']),
  PortalController.getVisitSummary,
);

// GET /patient/:patientId — patient visit summary history
router.get(
  '/patient/:patientId',
  roleMiddleware([...clinicianRoles, 'ADMIN']),
  PortalController.getPatientVisitSummaries,
);

// POST /:id/send — send visit summary to patient
router.post(
  '/:id/send',
  roleMiddleware(clinicianRoles),
  PortalController.sendToPatient,
);

// GET /auto-generate/:appointmentId — auto-generate draft from appointment data
router.get(
  '/auto-generate/:appointmentId',
  roleMiddleware(clinicianRoles),
  PortalController.autoGenerate,
);

export default router;
