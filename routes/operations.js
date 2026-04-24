import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { OperationsController } from '../controllers/operations.controller.js';

const router = express.Router();

const ADMIN_ROLES = ['ADMIN', 'ADMIN_DOCTOR'];
const ALL_STAFF = ['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PHARMACIST'];
const INVENTORY_ROLES = ['ADMIN', 'ADMIN_DOCTOR', 'PHARMACIST'];
const CLINICIAN_ROLES = ['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR'];

// Path-prefix feature gates. Each operations sub-area maps to its own FeatureRegistry
// key so Super Admin can toggle them independently. Auth is asserted here first since
// feature gates read req.user.hospitalId.
router.use('/resource-sharing', authMiddleware, requireFeature('RESOURCE_SHARING'));
router.use('/inventory',        authMiddleware, requireFeature('CENTRALIZED_INVENTORY'));
router.use('/staff-activity',   authMiddleware, requireFeature('STAFF_ACTIVITY_FEED'));
router.use('/scorecards',       authMiddleware, requireFeature('PERFORMANCE_SCORECARDS'));
router.use('/attendance',       authMiddleware, requireFeature('STAFF_ATTENDANCE'));
router.use('/skills',           authMiddleware, requireFeature('STAFF_SKILL_MATRIX'));

// ── Resource Sharing ────────────────────────────────────────────────────────────

/** POST /api/operations/resource-sharing — create sharing request */
router.post(
    '/resource-sharing',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.createSharingRequest
);

/** GET /api/operations/resource-sharing — list sharing requests */
router.get(
    '/resource-sharing',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.getRequests
);

/** GET /api/operations/resource-sharing/today/:branchId — today's shared staff */
router.get(
    '/resource-sharing/today/:branchId',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.getSharedStaffToday
);

/** PATCH /api/operations/resource-sharing/:id/approve — approve request */
router.patch(
    '/resource-sharing/:id/approve',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.approveSharingRequest
);

/** PATCH /api/operations/resource-sharing/:id/reject — reject request */
router.patch(
    '/resource-sharing/:id/reject',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.rejectSharingRequest
);

// ── Centralized Inventory ───────────────────────────────────────────────────────

/** GET /api/operations/inventory/centralized — all-branches inventory view */
router.get(
    '/inventory/centralized',
    authMiddleware,
    roleMiddleware(INVENTORY_ROLES),
    OperationsController.getCentralizedInventory
);

/** POST /api/operations/inventory/transfer — create transfer request */
router.post(
    '/inventory/transfer',
    authMiddleware,
    roleMiddleware(INVENTORY_ROLES),
    OperationsController.createTransferRequest
);

/** GET /api/operations/inventory/transfers — list transfers */
router.get(
    '/inventory/transfers',
    authMiddleware,
    roleMiddleware(INVENTORY_ROLES),
    OperationsController.getTransfers
);

/** PATCH /api/operations/inventory/transfer/:id/approve — approve transfer */
router.patch(
    '/inventory/transfer/:id/approve',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.approveTransfer
);

/** PATCH /api/operations/inventory/transfer/:id/receive — mark transfer received */
router.patch(
    '/inventory/transfer/:id/receive',
    authMiddleware,
    roleMiddleware(['PHARMACIST', 'ADMIN']),
    OperationsController.receiveTransfer
);

// ── Staff Activity ──────────────────────────────────────────────────────────────

/** POST /api/operations/staff-activity — record activity event */
router.post(
    '/staff-activity',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.recordActivity
);

/** GET /api/operations/staff-activity/live — live feed for caller's branch */
router.get(
    '/staff-activity/live',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.getLiveStaffFeed
);

/** GET /api/operations/staff-activity/live/:branchId — live feed for specific branch */
router.get(
    '/staff-activity/live/:branchId',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.getLiveStaffFeed
);

/** GET /api/operations/staff-activity/all-branches — all branches feed */
router.get(
    '/staff-activity/all-branches',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.getAllBranchesStaffFeed
);

// ── Performance Scorecards ──────────────────────────────────────────────────────

/** GET /api/operations/scorecards/mine — own scorecards */
router.get(
    '/scorecards/mine',
    authMiddleware,
    roleMiddleware(CLINICIAN_ROLES),
    OperationsController.getMyScorecards
);

/** GET /api/operations/scorecards/branch/:branchId — branch scorecards */
router.get(
    '/scorecards/branch/:branchId',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.getBranchScorecards
);

/** POST /api/operations/scorecards/generate — batch generate scorecards */
router.post(
    '/scorecards/generate',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.generateScorecards
);

// ── Attendance ──────────────────────────────────────────────────────────────────

/** POST /api/operations/attendance/clock-in — clock in */
router.post(
    '/attendance/clock-in',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.clockIn
);

/** POST /api/operations/attendance/clock-out — clock out */
router.post(
    '/attendance/clock-out',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.clockOut
);

/** GET /api/operations/attendance/mine — own attendance history */
router.get(
    '/attendance/mine',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.getMyAttendance
);

/** GET /api/operations/attendance/branch/:branchId — branch attendance */
router.get(
    '/attendance/branch/:branchId',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.getBranchAttendance
);

/** GET /api/operations/attendance/stats — own attendance stats */
router.get(
    '/attendance/stats',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.getMyAttendanceStats
);

/** GET /api/operations/attendance/report/:branchId — punctuality report */
router.get(
    '/attendance/report/:branchId',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.getPunctualityReport
);

// ── Skill Matrix ────────────────────────────────────────────────────────────────

/** POST /api/operations/skills — add a skill */
router.post(
    '/skills',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.addSkill
);

/** DELETE /api/operations/skills/:skillType/:skillName — remove a skill */
router.delete(
    '/skills/:skillType/:skillName',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.removeSkill
);

/** GET /api/operations/skills/mine — own skills */
router.get(
    '/skills/mine',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.getMySkills
);

/** GET /api/operations/skills/matrix/:branchId — branch skill matrix */
router.get(
    '/skills/matrix/:branchId',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.getSkillMatrix
);

/** GET /api/operations/skills/search — find staff by skill */
router.get(
    '/skills/search',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']),
    OperationsController.findStaffBySkill
);

/** GET /api/operations/skills/expiring — expiring certifications */
router.get(
    '/skills/expiring',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.getExpiringCertifications
);

export default router;
