import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { PortalController } from '../controllers/portal.controller.js';

const router = express.Router();

// All routes require authentication + PATIENT role
router.use(authMiddleware);
router.use(roleMiddleware(['PATIENT']));

// GET /dashboard — patient dashboard
router.get('/dashboard', PortalController.getDashboard);

// GET /prescriptions — prescription history
router.get('/prescriptions', PortalController.getPrescriptions);

// GET /reports — reports/documents
router.get('/reports', PortalController.getReports);

// GET /treatment-progress — treatment progress
router.get('/treatment-progress', PortalController.getTreatmentProgress);

export default router;
