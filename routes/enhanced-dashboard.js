/**
 * Enhanced Patient Dashboard routes.
 *
 * Mounted at /api/patient/dashboard (PATIENT-only).
 */

import express from 'express';
import { authMiddleware, roleMiddleware, resolvePatientId } from '../middleware/auth.js';
import { EnhancedDashboardController } from '../controllers/enhancedDashboard.controller.js';

const router = express.Router();

router.use(authMiddleware);
router.use(roleMiddleware(['PATIENT']));
router.use(resolvePatientId);

// Single-call dashboard summary (banner + tasks + meds + vitals + journey + zen + pain + smart messages)
router.get('/summary', EnhancedDashboardController.getSummary);

// Smart messages panel (paginated; future: ?cursor=)
router.get('/smart-messages', EnhancedDashboardController.getSmartMessages);

// Smart insight (recomputed pattern from last 14 check-ins)
router.get('/insight', EnhancedDashboardController.getInsight);

// Inline actions
router.post('/check-in', EnhancedDashboardController.submitCheckIn);
router.post('/medications/mark-taken', EnhancedDashboardController.markMedicationTaken);
router.post('/vitals/quick-log', EnhancedDashboardController.quickLogVital);
router.post('/pain/log', EnhancedDashboardController.logPainPoint);
router.post('/tasks/:taskId/complete', EnhancedDashboardController.completePhaseTask);

// Medication lifecycle — supply forecast + one-tap refill request
router.get('/medications/forecast', EnhancedDashboardController.getMedicationForecast);
router.post('/medications/:prescriptionId/request-refill', EnhancedDashboardController.requestMedicationRefill);

export default router;
