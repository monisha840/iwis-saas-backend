import { DashboardSummaryService } from '../services/dashboardSummary.service.js';

export class DashboardSummaryController {
    static async doctor(req, res, next) {
        try {
            const data = await DashboardSummaryService.doctorSummary(req.user.id, { branchId: req.query.branchId });
            res.json(data);
        } catch (err) { next(err); }
    }

    static async therapist(req, res, next) {
        try {
            const data = await DashboardSummaryService.therapistSummary(req.user.id, { branchId: req.query.branchId });
            res.json(data);
        } catch (err) { next(err); }
    }

    static async adminDoctor(req, res, next) {
        try {
            const branchId = req.query.branchId || null;
            const data = await DashboardSummaryService.adminDoctorSummary(req.user.id, { branchId });
            res.json(data);
        } catch (err) { next(err); }
    }

    static async admin(req, res, next) {
        try {
            const data = await DashboardSummaryService.adminSummary(req.user.id, { branchId: req.query.branchId });
            res.json(data);
        } catch (err) { next(err); }
    }

    static async staff(req, res, next) {
        try {
            const data = await DashboardSummaryService.listAssignableStaff({
                id: req.user.id,
                role: req.user.role,
                branchId: req.user.branchId,
            });
            res.json({ staff: data });
        } catch (err) { next(err); }
    }
}
