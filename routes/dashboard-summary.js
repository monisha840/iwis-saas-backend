/**
 * Role-scoped dashboard summary endpoints (spec §9.2).
 * Mounted at /api/dashboards.
 */

import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { DashboardSummaryController } from '../controllers/dashboardSummary.controller.js';

const router = express.Router();

router.use(authMiddleware);

// ADMIN_DOCTOR shares the doctor & therapist dashboards (their nav links land here).
router.get('/doctor/summary', roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR']), DashboardSummaryController.doctor);
router.get('/therapist/summary', roleMiddleware(['THERAPIST', 'ADMIN_DOCTOR']), DashboardSummaryController.therapist);
router.get('/admin-doctor/summary', roleMiddleware(['ADMIN_DOCTOR']), DashboardSummaryController.adminDoctor);
router.get('/admin/summary', roleMiddleware(['ADMIN']), DashboardSummaryController.admin);

// Staff lookup for todo assignment dropdown
router.get('/staff/assignable', roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), DashboardSummaryController.staff);

export default router;
