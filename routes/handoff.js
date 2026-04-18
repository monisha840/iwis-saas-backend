import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { CommunicationController } from '../controllers/communication.controller.js';

const router = express.Router();

const clinicianRoles = ['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR'];

// All routes require authentication
router.use(authMiddleware);

// POST / — create handoff note
router.post(
  '/',
  roleMiddleware(clinicianRoles),
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

export default router;
