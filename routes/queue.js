/**
 * /api/queue routes — Live Patient Queue Management.
 *
 * Read endpoints (today queue, live board) are open to all clinical /
 * admin roles; the service layer enforces branch / doctor scoping via
 * PatientQueueService.canAccessQueue.
 *
 * Mutation endpoints are tightly role-gated:
 *   - arrived / start-consultation / end-consultation / mark-absent: any
 *     clinical role within scope (including front-desk via ADMIN /
 *     BRANCH_ADMIN), so the dashboard "Mark as Arrived" button works
 *     whether the doctor or the branch admin clicks it.
 *   - contact-absent: only ADMIN, ADMIN_DOCTOR, BRANCH_ADMIN — doctors
 *     should not be the ones reaching out to absent patients.
 */

import express from 'express';
import { authMiddleware, roleMiddleware, resolveDoctorId, resolveBranchId } from '../middleware/auth.js';
import { PatientQueueController } from '../controllers/patientQueue.controller.js';

const router = express.Router();

router.use(authMiddleware);
router.use(resolveDoctorId);
router.use(resolveBranchId);

// Read endpoints — branch / doctor scoping enforced inside the controller.
router.get(
  '/today',
  roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'ADMIN', 'SUPER_ADMIN']),
  PatientQueueController.getToday,
);
router.get(
  '/live-board',
  roleMiddleware(['BRANCH_ADMIN', 'ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN']),
  PatientQueueController.getLiveBoard,
);

// Mutations — clinical / admin roles only.
const QUEUE_WRITER_ROLES = ['DOCTOR', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'ADMIN', 'SUPER_ADMIN'];

router.post(
  '/:appointmentId/arrived',
  roleMiddleware(QUEUE_WRITER_ROLES),
  PatientQueueController.markArrived,
);
router.post(
  '/:appointmentId/start-consultation',
  roleMiddleware(QUEUE_WRITER_ROLES),
  PatientQueueController.startConsultation,
);
router.post(
  '/:appointmentId/end-consultation',
  roleMiddleware(QUEUE_WRITER_ROLES),
  PatientQueueController.endConsultation,
);
router.post(
  '/:appointmentId/mark-absent',
  roleMiddleware(QUEUE_WRITER_ROLES),
  PatientQueueController.markAbsent,
);

// Absent-contact flow is admin-only — front-desk function, not a doctor task.
router.post(
  '/:appointmentId/contact-absent',
  roleMiddleware(['BRANCH_ADMIN', 'ADMIN_DOCTOR', 'ADMIN', 'SUPER_ADMIN']),
  PatientQueueController.contactAbsent,
);

export default router;
