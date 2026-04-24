import express from 'express';
import { authMiddleware, roleMiddleware, resolvePatientId } from '../middleware/auth.js';
import { PortalController } from '../controllers/portal.controller.js';

const router = express.Router();

// All routes require authentication + PATIENT role
router.use(authMiddleware);
router.use(roleMiddleware(['PATIENT']));
router.use(resolvePatientId);

// GET /dashboard — REMOVED: superseded by /api/patient/dashboard/summary
// (EnhancedPatientDashboard) and the records-archive PatientPortal.

// GET /prescriptions — prescription history
router.get('/prescriptions', PortalController.getPrescriptions);

// GET /reports — reports/documents
router.get('/reports', PortalController.getReports);

// GET /appointments — paginated appointment history
router.get('/appointments', PortalController.getAppointments);

// GET /treatment-progress — treatment progress
router.get('/treatment-progress', PortalController.getTreatmentProgress);

export default router;
