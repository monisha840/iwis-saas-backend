import express from 'express';
import prisma from '../lib/prisma.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { OperationsController } from '../controllers/operations.controller.js';

const router = express.Router();

const ADMIN_ROLES = ['ADMIN', 'ADMIN_DOCTOR'];
// Branch-scoped admin operations: BRANCH_ADMIN may call them but only against
// their own branch — enforced by `requireOwnBranch` for path-param routes.
const BRANCH_SCOPED_ADMIN_ROLES = [...ADMIN_ROLES, 'BRANCH_ADMIN'];
const ALL_STAFF = ['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR', 'THERAPIST', 'PHARMACIST'];
const INVENTORY_ROLES = ['ADMIN', 'ADMIN_DOCTOR', 'PHARMACIST'];
const CLINICIAN_ROLES = ['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR'];

// For BRANCH_ADMIN callers, require that the :branchId path param matches the
// branchId on their JWT. ADMIN / ADMIN_DOCTOR are allowed to query any branch.
function requireOwnBranch(paramName = 'branchId') {
    return (req, res, next) => {
        if (req.user?.role === 'BRANCH_ADMIN' && req.params[paramName] !== req.user.branchId) {
            return res.status(403).json({ error: 'Forbidden: branch mismatch' });
        }
        next();
    };
}

// For BRANCH_ADMIN callers, require that the :userId path param resolves to a
// user whose branchId matches the JWT branchId.
async function requireUserInOwnBranch(req, res, next) {
    try {
        if (req.user?.role !== 'BRANCH_ADMIN') return next();
        const target = await prisma.user.findUnique({
            where: { id: req.params.userId },
            select: { branchId: true },
        });
        if (!target || target.branchId !== req.user.branchId) {
            return res.status(403).json({ error: 'Forbidden: user is not in your branch' });
        }
        next();
    } catch (err) {
        next(err);
    }
}

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

/** PATCH /api/operations/resource-sharing/:id — edit a PENDING request.
 *  Authorization handled in service: creator, source-branch admin,
 *  destination-branch admin, or global ADMIN. */
router.patch(
    '/resource-sharing/:id',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.updateSharingRequest
);

/** DELETE /api/operations/resource-sharing/:id — delete a PENDING request */
router.delete(
    '/resource-sharing/:id',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.deleteSharingRequest
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

/** GET /api/operations/scorecards/branch/:branchId — branch scorecards.
 *  BRANCH_ADMIN may only request their own branch (enforced by requireOwnBranch);
 *  ADMIN / ADMIN_DOCTOR may query any branch. */
router.get(
    '/scorecards/branch/:branchId',
    authMiddleware,
    roleMiddleware(BRANCH_SCOPED_ADMIN_ROLES),
    requireOwnBranch('branchId'),
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

/** GET /api/operations/attendance/branch/:branchId — branch attendance.
 *  BRANCH_ADMIN may only request their own branch. */
router.get(
    '/attendance/branch/:branchId',
    authMiddleware,
    roleMiddleware(BRANCH_SCOPED_ADMIN_ROLES),
    requireOwnBranch('branchId'),
    OperationsController.getBranchAttendance
);

/** GET /api/operations/attendance/stats — own attendance stats */
router.get(
    '/attendance/stats',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.getMyAttendanceStats
);

/** GET /api/operations/attendance/report/:branchId — punctuality report.
 *  BRANCH_ADMIN may only request their own branch. */
router.get(
    '/attendance/report/:branchId',
    authMiddleware,
    roleMiddleware(BRANCH_SCOPED_ADMIN_ROLES),
    requireOwnBranch('branchId'),
    OperationsController.getPunctualityReport
);

/** PUT /api/operations/attendance/user/:userId — admin override.
 *  Body: { date: 'YYYY-MM-DD', clockIn?: 'HH:mm', clockOut?: 'HH:mm',
 *          status?: AttendanceStatus, notes?: string }
 *  Upserts the row; re-derives status from schedule + times when `status`
 *  is omitted, honors explicit `status` otherwise. */
router.put(
    '/attendance/user/:userId',
    authMiddleware,
    roleMiddleware(BRANCH_SCOPED_ADMIN_ROLES),
    requireUserInOwnBranch,
    OperationsController.setAttendance
);

/** DELETE /api/operations/attendance/user/:userId?date=YYYY-MM-DD — admin override. */
router.delete(
    '/attendance/user/:userId',
    authMiddleware,
    roleMiddleware(BRANCH_SCOPED_ADMIN_ROLES),
    requireUserInOwnBranch,
    OperationsController.deleteAttendance
);

/** POST /api/operations/attendance/reconcile/:branchId — manual reconciliation.
 *  Converts planned leave / WFH blocks + no-show shifts into attendance rows
 *  for the requested date (defaults to yesterday).                           */
router.post(
    '/attendance/reconcile/:branchId',
    authMiddleware,
    roleMiddleware(ADMIN_ROLES),
    OperationsController.reconcileAttendance
);

// ── Unified Clinician Calendar ──────────────────────────────────────────────────

/** GET /api/operations/calendar/clinician/:userId?year=&month=
 *  Unified per-day view: schedule, blocks (leave/WFH), attendance row,
 *  appointment counts + morning/afternoon/evening distribution. */
router.get(
    '/calendar/clinician/:userId',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    requireUserInOwnBranch,
    OperationsController.getClinicianCalendar
);

/** GET /api/operations/calendar/clinician (no param) — own calendar.
 *  Convenience route so clinicians don't need to know their own userId. */
router.get(
    '/calendar/clinician',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.getClinicianCalendar
);

/** GET /api/operations/calendar/branch/:branchId?year=&month=
 *  Branch-wide workload heatmap — one row per clinician, one cell per day.
 *  BRANCH_ADMIN may only request their own branch. */
router.get(
    '/calendar/branch/:branchId',
    authMiddleware,
    roleMiddleware(BRANCH_SCOPED_ADMIN_ROLES),
    requireOwnBranch('branchId'),
    OperationsController.getBranchCalendar
);

// ── Skill Matrix ────────────────────────────────────────────────────────────────

/** POST /api/operations/skills — add a skill (clinicians edit their own skills;
 *  BRANCH_ADMIN is explicitly excluded — skill editing belongs to ADMIN /
 *  ADMIN_DOCTOR or the clinician themself, never to a branch admin). */
router.post(
    '/skills',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PHARMACIST']),
    OperationsController.addSkill
);

/** DELETE /api/operations/skills/:skillType/:skillName — remove a skill */
router.delete(
    '/skills/:skillType/:skillName',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PHARMACIST']),
    OperationsController.removeSkill
);

/** GET /api/operations/skills/mine — own skills */
router.get(
    '/skills/mine',
    authMiddleware,
    roleMiddleware(ALL_STAFF),
    OperationsController.getMySkills
);

/** GET /api/operations/skills/matrix/:branchId — branch skill matrix.
 *  BRANCH_ADMIN may read their own branch (read-only — POST/DELETE /skills
 *  remain blocked since BRANCH_ADMIN is not in ALL_STAFF for those handlers). */
router.get(
    '/skills/matrix/:branchId',
    authMiddleware,
    roleMiddleware(BRANCH_SCOPED_ADMIN_ROLES),
    requireOwnBranch('branchId'),
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
