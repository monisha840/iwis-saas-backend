/**
 * PortalController — HTTP layer for patient portal and visit summaries.
 */

import { PatientPortalService } from '../services/patientPortal.service.js';
import { VisitSummaryService } from '../services/visitSummary.service.js';

export class PortalController {
  // ── Patient Portal ─────────────────────────────────────────────────────────
  // getDashboard removed — superseded by EnhancedDashboardController.getSummary.

  static async getPrescriptions(req, res, next) {
    try {
      const result = await PatientPortalService.getMyPrescriptionHistory(req.user.patientId, req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getReports(req, res, next) {
    try {
      const result = await PatientPortalService.getMyReports(req.user.patientId, req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getAppointments(req, res, next) {
    try {
      const result = await PatientPortalService.getMyAppointmentHistory(req.user.patientId, req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getTreatmentProgress(req, res, next) {
    try {
      const result = await PatientPortalService.getMyTreatmentProgress(req.user.patientId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  // ── Visit Summaries ────────────────────────────────────────────────────────

  static async createVisitSummary(req, res, next) {
    try {
      const summary = await VisitSummaryService.createVisitSummary(
        req.body.appointmentId,
        req.user.id,
        req.body,
      );
      res.status(201).json(summary);
    } catch (err) {
      next(err);
    }
  }

  static async getVisitSummary(req, res, next) {
    try {
      const result = await VisitSummaryService.getVisitSummary(req.params.appointmentId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getPatientVisitSummaries(req, res, next) {
    try {
      const result = await VisitSummaryService.getPatientVisitSummaries(
        req.params.patientId,
        req.query,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  // Doctor / therapist sees the visit summaries they authored.
  static async getMyVisitSummaries(req, res, next) {
    try {
      // ADMIN_DOCTOR oversees consultations across the branch / hospital, so
      // their dashboard returns every visit summary in scope rather than
      // only the ones they personally authored. Plain DOCTOR / THERAPIST
      // continue to see their own.
      const isAdminDoctor = req.user.role === 'ADMIN_DOCTOR' || req.user.role === 'ADMIN';
      const result = await VisitSummaryService.listClinicianVisitSummaries(
        isAdminDoctor ? null : req.user.id,
        { ...req.query, branchId: isAdminDoctor ? (req.query.branchId || req.user.branchId || null) : undefined },
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async sendToPatient(req, res, next) {
    try {
      const result = await VisitSummaryService.sendToPatient(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async autoGenerate(req, res, next) {
    try {
      const result = await VisitSummaryService.autoGenerate(req.params.appointmentId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
