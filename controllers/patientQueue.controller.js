/**
 * Patient queue HTTP layer. Thin — all heavy lifting is in
 * services/patientQueue.service.js. Each route resolves the actor's
 * branch / doctor scope via canAccessQueue before delegating.
 */

import { PatientQueueService } from '../services/patientQueue.service.js';
import logger from '../lib/logger.js';

function denyIf(condition, res, message = 'Forbidden') {
  if (condition) {
    res.status(403).json({ error: message });
    return true;
  }
  return false;
}

export class PatientQueueController {
  /** GET /api/queue/today?doctorId=&branchId= */
  static async getToday(req, res, next) {
    try {
      const { doctorId: doctorIdParam, branchId: branchIdParam, date } = req.query || {};
      // Doctors default to their own queue when no param is given.
      const doctorId = doctorIdParam
        || (req.user.role === 'DOCTOR' || req.user.role === 'ADMIN_DOCTOR' ? req.user.doctorProfileId : null);
      const branchId = branchIdParam || req.user.branchId || null;
      if (!doctorId) {
        return res.status(400).json({ error: 'doctorId is required' });
      }
      if (denyIf(!PatientQueueService.canAccessQueue(req.user, { doctorId, branchId }), res)) return;
      const entries = await PatientQueueService.getTodayQueue({
        doctorId, branchId,
        date: date ? new Date(date) : new Date(),
      });
      res.json({ data: entries });
    } catch (err) { next(err); }
  }

  /** GET /api/queue/live-board?branchId=  ('all' or empty → cross-branch for admin roles) */
  static async getLiveBoard(req, res, next) {
    try {
      const { branchId: branchIdParam, date } = req.query || {};
      // ADMIN / ADMIN_DOCTOR / SUPER_ADMIN may view every branch — used by
      // the "All Branches" filter in the live-queue board.
      const isCrossBranchAdmin = ['ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN'].includes(req.user.role);
      const wantsAll = branchIdParam === 'all' || branchIdParam === '';
      let branchId;
      if (req.user.role === 'BRANCH_ADMIN') {
        // BRANCH_ADMIN is always pinned to their own branch.
        branchId = req.user.branchId;
      } else if (isCrossBranchAdmin && (wantsAll || !branchIdParam)) {
        branchId = null;
      } else {
        branchId = branchIdParam || req.user.branchId || null;
      }
      if (!branchId && !isCrossBranchAdmin) {
        return res.status(400).json({ error: 'branchId is required' });
      }
      if (branchId && denyIf(!PatientQueueService.canAccessQueue(req.user, { branchId }), res)) return;
      const board = await PatientQueueService.getLiveBoard({
        branchId,
        date: date ? new Date(date) : new Date(),
      });
      res.json(board);
    } catch (err) { next(err); }
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  static async _withQueueAccess(req, res, op) {
    try {
      const { appointmentId } = req.params;
      const entry = await PatientQueueService.ensureEntryForAppointment(appointmentId);
      if (denyIf(
        !PatientQueueService.canAccessQueue(req.user, { doctorId: entry.doctorId, branchId: entry.branchId }),
        res,
      )) return;
      const result = await op({ appointmentId, entry });
      res.json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error('[Queue] mutation failed', { err: err.message });
      res.status(500).json({ error: err.message || 'Server error' });
    }
  }

  static markArrived(req, res) {
    return PatientQueueController._withQueueAccess(req, res, ({ appointmentId }) =>
      PatientQueueService.markArrived(appointmentId, { actorUserId: req.user.id }),
    );
  }
  static startConsultation(req, res) {
    return PatientQueueController._withQueueAccess(req, res, ({ appointmentId }) =>
      PatientQueueService.startConsultation(appointmentId, { actorUserId: req.user.id }),
    );
  }
  static endConsultation(req, res) {
    return PatientQueueController._withQueueAccess(req, res, ({ appointmentId }) =>
      PatientQueueService.endConsultation(appointmentId, { actorUserId: req.user.id }),
    );
  }
  static markAbsent(req, res) {
    return PatientQueueController._withQueueAccess(req, res, ({ appointmentId }) =>
      PatientQueueService.markAbsent(appointmentId, { actorUserId: req.user.id }),
    );
  }
  static contactAbsent(req, res) {
    const { contactNote } = req.body || {};
    return PatientQueueController._withQueueAccess(req, res, ({ appointmentId }) =>
      PatientQueueService.contactAbsent(appointmentId, { actorUserId: req.user.id, contactNote }),
    );
  }
}

export default PatientQueueController;
