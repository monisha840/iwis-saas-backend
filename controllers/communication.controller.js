/**
 * CommunicationController — HTTP layer for announcements and handoff notes.
 */

import { AnnouncementService } from '../services/announcement.service.js';
import { HandoffNoteService } from '../services/handoffNote.service.js';

export class CommunicationController {
  // ── Announcements ──────────────────────────────────────────────────────────

  static async createAnnouncement(req, res, next) {
    try {
      const announcement = await AnnouncementService.createAnnouncement(req.user.id, req.body);
      res.status(201).json(announcement);
    } catch (err) {
      next(err);
    }
  }

  static async getAnnouncements(req, res, next) {
    try {
      const result = await AnnouncementService.getAnnouncements(
        req.user.id,
        req.user.role,
        req.user.branchId,
        req.user.hospitalId,
        req.query,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async markAnnouncementRead(req, res, next) {
    try {
      const result = await AnnouncementService.markAsRead(req.params.id, req.user.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async updateAnnouncement(req, res, next) {
    try {
      const result = await AnnouncementService.updateAnnouncement(req.params.id, req.body, req.user.id);
      res.json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }

  static async deleteAnnouncement(req, res, next) {
    try {
      const result = await AnnouncementService.deleteAnnouncement(req.params.id, req.user.id);
      res.json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }

  // ── Handoff Notes ──────────────────────────────────────────────────────────

  static async createHandoff(req, res, next) {
    try {
      const handoff = await HandoffNoteService.createHandoffNote(req.user.id, req.body);
      res.status(201).json(handoff);
    } catch (err) {
      next(err);
    }
  }

  static async getReceivedHandoffs(req, res, next) {
    try {
      const result = await HandoffNoteService.getReceivedHandoffs(req.user.id, req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getSentHandoffs(req, res, next) {
    try {
      const result = await HandoffNoteService.getSentHandoffs(req.user.id, req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getPatientHandoffs(req, res, next) {
    try {
      const result = await HandoffNoteService.getPatientHandoffs(req.params.patientId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async markHandoffRead(req, res, next) {
    try {
      const result = await HandoffNoteService.markAsRead(req.params.id, req.user.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async autoPopulateHandoff(req, res, next) {
    try {
      const result = await HandoffNoteService.autoPopulateFromAppointment(
        req.params.appointmentId,
        req.user.id,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async updateHandoff(req, res, next) {
    try {
      const result = await HandoffNoteService.updateDraft(req.params.id, req.user.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async sendHandoff(req, res, next) {
    try {
      const result = await HandoffNoteService.sendDraft(req.params.id, req.user.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
