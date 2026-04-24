import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { analyticsService } from '../services/analytics.service.js';
import { exportService } from '../services/export.service.js';
import { validate } from '../middleware/validate.js';
import { createReadStream, unlink } from 'fs';
import logger from '../lib/logger.js';

const router = express.Router();

const dateRangeSchema = z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    branchId: z.string().optional(),
});

const progressReportSchema = dateRangeSchema.extend({
    doctorId: z.string().optional(),
    status: z.string().optional(),
});

const appointmentAnalyticsSchema = dateRangeSchema.extend({
    status: z.string().optional(),
    doctorId: z.string().optional(),
    therapistId: z.string().optional(),
});

const prescriptionAnalyticsSchema = dateRangeSchema.extend({
    doctorId: z.string().optional(),
    patientId: z.string().optional(),
});

router.get('/patient-progress', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']), validate({ query: progressReportSchema }), async (req, res, next) => {
    try {
        const data = await analyticsService.getPatientProgress(req.query);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
});

router.get('/patient-progress/export/csv', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']), validate({ query: progressReportSchema }), async (req, res, next) => {
    try {
        const data = await analyticsService.getPatientProgress(req.query);
        const filepath = await exportService.exportPatientProgress(data);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="patient_progress.csv"');

        const fileStream = createReadStream(filepath);
        fileStream.pipe(res);
        fileStream.on('end', () => {
            unlink(filepath, (err) => {
                if (err) logger.error('Failed to delete temp file:', err);
            });
        });
    } catch (err) {
        next(err);
    }
});

router.get('/doctor-performance', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ query: dateRangeSchema }), async (req, res, next) => {
    try {
        const data = await analyticsService.getDoctorPerformance(req.query);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
});

router.get('/doctor-performance/export/pdf', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ query: dateRangeSchema }), async (req, res, next) => {
    try {
        const { startDate, endDate } = req.query;
        const data = await analyticsService.getDoctorPerformance(req.query);
        const filepath = await exportService.exportDoctorPerformance(data, {
            generatedAt: new Date(),
            dateRange: startDate && endDate ? `${startDate} to ${endDate}` : 'All time',
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="doctor_performance.pdf"');

        const fileStream = createReadStream(filepath);
        fileStream.pipe(res);
        fileStream.on('end', () => {
            unlink(filepath, (err) => {
                if (err) logger.error('Failed to delete temp file:', err);
            });
        });
    } catch (err) {
        next(err);
    }
});

router.get('/appointments', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), validate({ query: appointmentAnalyticsSchema }), async (req, res, next) => {
    try {
        const data = await analyticsService.getAppointmentAnalytics(req.query);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
});

router.get('/appointments/export/csv', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), validate({ query: appointmentAnalyticsSchema }), async (req, res, next) => {
    try {
        const result = await analyticsService.getAppointmentAnalytics(req.query);
        const filepath = await exportService.exportAppointments(result.appointments);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="appointments.csv"');

        const fileStream = createReadStream(filepath);
        fileStream.pipe(res);
        fileStream.on('end', () => {
            unlink(filepath, (err) => {
                if (err) logger.error('Failed to delete temp file:', err);
            });
        });
    } catch (err) {
        next(err);
    }
});

router.get('/prescriptions', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), validate({ query: prescriptionAnalyticsSchema }), async (req, res, next) => {
    try {
        const data = await analyticsService.getPrescriptionAnalytics(req.query);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
});

router.get('/dashboard-stats', authMiddleware, async (req, res, next) => {
    try {
        const stats = await analyticsService.getDashboardStats(req.user.role, req.user.id);
        res.json({ success: true, data: stats });
    } catch (err) {
        next(err);
    }
});

router.get('/patient/:patientId/progress', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), async (req, res, next) => {
    try {
        const data = await analyticsService.getClientProgressReport(req.params.patientId);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
});

router.get('/branch-summary', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
        const data = await analyticsService.getBranchSummary({ branchId });
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
});

router.get('/monthly-completed-appointments', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PHARMACIST']), async (req, res, next) => {
    try {
        // Admins may override the branch scope via ?branchId=…; everyone else
        // is locked to their own user.branchId for row-level safety.
        const isAdminCaller = req.user.role === 'ADMIN' || req.user.role === 'ADMIN_DOCTOR';
        const queryBranch = typeof req.query.branchId === 'string' ? req.query.branchId : null;
        const effectiveBranchId = isAdminCaller
            ? (queryBranch || null)
            : req.user.branchId;
        const filters = {
            role: req.user.role,
            userId: req.user.id,
            branchId: effectiveBranchId,
            page: req.query.page,
            limit: req.query.limit
        };
        const data = await analyticsService.getMonthlyCompletedAppointments(filters);
        res.json({ success: true, ...data });
    } catch (err) {
        next(err);
    }
});

export default router;
