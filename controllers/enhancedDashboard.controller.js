/**
 * EnhancedDashboardController — HTTP layer for the proactive patient dashboard.
 */

import { EnhancedDashboardService } from '../services/enhancedDashboard.service.js';
import { MedicationLifecycleService } from '../services/medicationLifecycle.service.js';
import { RefillService } from '../services/refill.service.js';

export class EnhancedDashboardController {
  static async getSummary(req, res, next) {
    try {
      const result = await EnhancedDashboardService.getSummary(req.user.patientId, req.user.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async submitCheckIn(req, res, next) {
    try {
      const result = await EnhancedDashboardService.submitCheckIn(
        req.user.patientId,
        req.user.id,
        req.body || {},
      );
      res.status(201).json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }

  static async markMedicationTaken(req, res, next) {
    try {
      const { prescriptionId, slot } = req.body || {};
      const result = await EnhancedDashboardService.markMedicationTaken(
        req.user.patientId,
        prescriptionId,
        slot,
      );
      res.status(201).json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }

  static async quickLogVital(req, res, next) {
    try {
      const result = await EnhancedDashboardService.quickLogVital(req.user.id, req.body || {});
      res.status(201).json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }

  static async logPainPoint(req, res, next) {
    try {
      const result = await EnhancedDashboardService.logPainPoint(req.user.patientId, req.body || {});
      res.status(201).json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }

  static async completePhaseTask(req, res, next) {
    try {
      const result = await EnhancedDashboardService.completePhaseTask(req.user.id, req.params.taskId);
      res.status(201).json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }

  static async getSmartMessages(req, res, next) {
    try {
      const result = await EnhancedDashboardService.getSmartMessages(req.user.patientId, req.user.id);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  static async getInsight(req, res, next) {
    try {
      const result = await EnhancedDashboardService.computeSmartInsight(req.user.patientId);
      res.json(result || null);
    } catch (err) {
      next(err);
    }
  }

  // ── Medication lifecycle ──────────────────────────────────────────────
  static async getMedicationForecast(req, res, next) {
    try {
      const forecasts = await MedicationLifecycleService.getForecastsForPatient(req.user.patientId);
      res.json({ data: forecasts });
    } catch (err) {
      next(err);
    }
  }

  static async requestMedicationRefill(req, res, next) {
    try {
      const { prescriptionId } = req.params;
      const { notes } = req.body || {};
      const noteTag = notes ? `${notes} (auto-reminder)` : 'auto-reminder';
      const result = await RefillService.requestRefill(req.user.id, prescriptionId, noteTag);
      res.status(201).json(result);
    } catch (err) {
      if (err.message === 'Access denied') {
        return res.status(403).json({ error: err.message });
      }
      if (err.message?.includes('not found')) {
        return res.status(404).json({ error: err.message });
      }
      if (err.message?.includes('already pending')) {
        return res.status(409).json({ error: err.message });
      }
      next(err);
    }
  }
}

export default EnhancedDashboardController;
