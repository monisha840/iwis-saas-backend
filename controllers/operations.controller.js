/**
 * OperationsController — HTTP layer for cross-branch resource sharing,
 * centralized inventory, staff activity, performance scorecards,
 * attendance, and skill matrix.
 */

import { ResourceSharingService } from '../services/resourceSharing.service.js';
import { StockTransferService } from '../services/stockTransfer.service.js';
import { StaffActivityService } from '../services/staffActivity.service.js';
import { PerformanceScorecardService } from '../services/performanceScorecard.service.js';
import { StaffAttendanceService } from '../services/staffAttendance.service.js';
import { StaffSkillService } from '../services/staffSkill.service.js';
import { ClinicianCalendarService } from '../services/clinicianCalendar.service.js';

export class OperationsController {
    // ── Resource Sharing ────────────────────────────────────────────────────────

    static async createSharingRequest(req, res, next) {
        try {
            const { userId, fromBranchId, toBranchId, date, startTime, endTime, reason } = req.body;
            const record = await ResourceSharingService.createSharingRequest(
                userId, fromBranchId, toBranchId, date, startTime, endTime, reason
            );
            res.status(201).json(record);
        } catch (err) { next(err); }
    }

    static async getRequests(req, res, next) {
        try {
            const { branchId, status, page, limit } = req.query;
            const data = await ResourceSharingService.getRequests({
                branchId,
                status,
                page: page ? parseInt(page) : undefined,
                limit: limit ? parseInt(limit) : undefined,
            });
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getSharedStaffToday(req, res, next) {
        try {
            const { branchId } = req.params;
            const data = await ResourceSharingService.getSharedStaffForBranch(branchId, new Date());
            res.json(data);
        } catch (err) { next(err); }
    }

    static async approveSharingRequest(req, res, next) {
        try {
            const record = await ResourceSharingService.approveSharingRequest(
                req.params.id,
                { id: req.user.id, role: req.user.role, branchId: req.user.branchId || null },
            );
            res.json(record);
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            next(err);
        }
    }

    static async rejectSharingRequest(req, res, next) {
        try {
            const record = await ResourceSharingService.rejectSharingRequest(
                req.params.id,
                { id: req.user.id, role: req.user.role, branchId: req.user.branchId || null },
            );
            res.json(record);
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            next(err);
        }
    }

    // ── Centralized Inventory ───────────────────────────────────────────────────

    static async getCentralizedInventory(req, res, next) {
        try {
            const data = await StockTransferService.getCentralizedInventory();
            res.json(data);
        } catch (err) { next(err); }
    }

    static async createTransferRequest(req, res, next) {
        try {
            const { medicineId, fromBranchId, toBranchId, quantity, notes } = req.body;
            const transfer = await StockTransferService.createTransferRequest(
                medicineId, fromBranchId, toBranchId, quantity, req.user.id, notes
            );
            res.status(201).json(transfer);
        } catch (err) { next(err); }
    }

    static async getTransfers(req, res, next) {
        try {
            const { branchId, status, page, limit } = req.query;
            const data = await StockTransferService.getTransfers({
                branchId,
                status,
                page: page ? parseInt(page) : undefined,
                limit: limit ? parseInt(limit) : undefined,
            });
            res.json(data);
        } catch (err) { next(err); }
    }

    static async approveTransfer(req, res, next) {
        try {
            const transfer = await StockTransferService.approveTransfer(
                req.params.id, req.user.id
            );
            res.json(transfer);
        } catch (err) { next(err); }
    }

    static async receiveTransfer(req, res, next) {
        try {
            const transfer = await StockTransferService.receiveTransfer(req.params.id);
            res.json(transfer);
        } catch (err) { next(err); }
    }

    // ── Staff Activity ──────────────────────────────────────────────────────────

    static async recordActivity(req, res, next) {
        try {
            const { activityType, metadata } = req.body;
            const record = await StaffActivityService.recordActivity(
                req.user.id, activityType, req.user.branchId, metadata
            );
            res.status(201).json(record);
        } catch (err) { next(err); }
    }

    static async getLiveStaffFeed(req, res, next) {
        try {
            const branchId = req.params.branchId || req.user.branchId;
            const data = await StaffActivityService.getLiveStaffFeed(branchId);
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getAllBranchesStaffFeed(req, res, next) {
        try {
            const data = await StaffActivityService.getAllBranchesStaffFeed();
            res.json(data);
        } catch (err) { next(err); }
    }

    // ── Performance Scorecards ──────────────────────────────────────────────────

    static async getMyScorecards(req, res, next) {
        try {
            const { periodType } = req.query;
            const data = await PerformanceScorecardService.getScorecards(
                req.user.id, { periodType }
            );
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getBranchScorecards(req, res, next) {
        try {
            const { branchId } = req.params;
            const { period } = req.query;
            const data = await PerformanceScorecardService.getBranchScorecards(branchId, period);
            res.json(data);
        } catch (err) { next(err); }
    }

    static async generateScorecards(req, res, next) {
        try {
            const { period, periodType } = req.body;
            const data = await PerformanceScorecardService.generateAllScorecards(period, periodType);
            res.json(data);
        } catch (err) { next(err); }
    }

    // ── Attendance ──────────────────────────────────────────────────────────────

    static async clockIn(req, res, next) {
        try {
            const record = await StaffAttendanceService.clockIn(req.user.id, req.user.branchId);
            res.json(record);
        } catch (err) {
            // Most clock-in failures are user-actionable ("already clocked
            // in", "on approved leave"), not server bugs — surface them as
            // 409s so the UI can show a sensible toast.
            if (/already clocked in|leave/i.test(err?.message || '')) {
                return res.status(409).json({ error: err.message });
            }
            next(err);
        }
    }

    static async clockOut(req, res, next) {
        try {
            const record = await StaffAttendanceService.clockOut(req.user.id);
            res.json(record);
        } catch (err) {
            if (/no active clock-in|already clocked out/i.test(err?.message || '')) {
                return res.status(409).json({ error: err.message });
            }
            next(err);
        }
    }

    static async setAttendance(req, res, next) {
        try {
            const { userId: targetUserId } = req.params;
            const { date, clockIn, clockOut, status, notes } = req.body;
            const record = await StaffAttendanceService.setAttendance({
                actorId: req.user.id,
                actorEmail: req.user.email,
                targetUserId,
                date,
                clockIn,
                clockOut,
                status,
                notes,
            });
            res.json(record);
        } catch (err) {
            if (/required|must be|not found|before/i.test(err?.message || '')) {
                return res.status(400).json({ error: err.message });
            }
            next(err);
        }
    }

    static async deleteAttendance(req, res, next) {
        try {
            const { userId: targetUserId } = req.params;
            const { date } = req.query;
            if (!date) return res.status(400).json({ error: 'date is required' });
            const result = await StaffAttendanceService.deleteAttendance({
                actorId: req.user.id,
                targetUserId,
                date,
            });
            res.json(result);
        } catch (err) { next(err); }
    }

    static async reconcileAttendance(req, res, next) {
        try {
            const { branchId } = req.params;
            const { date } = req.query;
            const targetDate = date ? new Date(date) : new Date();
            // Reconcile yesterday by default so the shift window has fully
            // closed (matches the nightly cron semantics).
            if (!date) targetDate.setDate(targetDate.getDate() - 1);
            const data = await StaffAttendanceService.reconcileDay({ date: targetDate, branchId });
            res.json({ date: targetDate.toISOString().slice(0, 10), ...data });
        } catch (err) { next(err); }
    }

    static async getMyAttendance(req, res, next) {
        try {
            const { startDate, endDate } = req.query;
            const data = await StaffAttendanceService.getAttendance(req.user.id, { startDate, endDate });
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getBranchAttendance(req, res, next) {
        try {
            const { branchId } = req.params;
            const { date } = req.query;
            const data = await StaffAttendanceService.getBranchAttendance(branchId, date || new Date());
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getMyAttendanceStats(req, res, next) {
        try {
            const { startDate, endDate } = req.query;
            const data = await StaffAttendanceService.getAttendanceStats(req.user.id, { startDate, endDate });
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getPunctualityReport(req, res, next) {
        try {
            const { branchId } = req.params;
            const { startDate, endDate } = req.query;
            const data = await StaffAttendanceService.getPunctualityReport(branchId, { startDate, endDate });
            res.json(data);
        } catch (err) { next(err); }
    }

    // ── Unified Clinician Calendar ──────────────────────────────────────────────

    static async getClinicianCalendar(req, res, next) {
        try {
            const userId = req.params.userId || req.user.id;
            const now = new Date();
            const year  = Number(req.query.year)  || now.getFullYear();
            const month = Number(req.query.month) || (now.getMonth() + 1);
            const data = await ClinicianCalendarService.getClinicianCalendar({ userId, year, month });
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getBranchCalendar(req, res, next) {
        try {
            const { branchId } = req.params;
            const now = new Date();
            const year  = Number(req.query.year)  || now.getFullYear();
            const month = Number(req.query.month) || (now.getMonth() + 1);
            const data = await ClinicianCalendarService.getBranchCalendar({ branchId, year, month });
            res.json(data);
        } catch (err) { next(err); }
    }

    // ── Skill Matrix ────────────────────────────────────────────────────────────

    static async addSkill(req, res, next) {
        try {
            const { skillType, skillName, proficiency, certifiedAt, expiresAt } = req.body;
            const skill = await StaffSkillService.addSkill(
                req.user.id, skillType, skillName, proficiency, certifiedAt, expiresAt
            );
            res.status(201).json(skill);
        } catch (err) { next(err); }
    }

    static async removeSkill(req, res, next) {
        try {
            const { skillType, skillName } = req.params;
            const result = await StaffSkillService.removeSkill(req.user.id, skillType, skillName);
            res.json(result);
        } catch (err) { next(err); }
    }

    static async getMySkills(req, res, next) {
        try {
            const data = await StaffSkillService.getUserSkills(req.user.id);
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getSkillMatrix(req, res, next) {
        try {
            const { branchId } = req.params;
            const data = await StaffSkillService.getSkillMatrix(branchId);
            res.json(data);
        } catch (err) { next(err); }
    }

    static async findStaffBySkill(req, res, next) {
        try {
            const { skillName, branchId } = req.query;
            const data = await StaffSkillService.findStaffBySkill(skillName, branchId);
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getExpiringCertifications(req, res, next) {
        try {
            const { daysAhead } = req.query;
            const data = await StaffSkillService.getExpiringCertifications(
                daysAhead ? parseInt(daysAhead) : 30
            );
            res.json(data);
        } catch (err) { next(err); }
    }
}
