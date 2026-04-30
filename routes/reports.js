import express from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
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

/**
 * GET /api/reports/workload-distribution?month=YYYY&year=YYYY&branchId=…
 *
 * Per-clinician monthly workload breakdown for the admin dashboard chart.
 * Inline JS aggregation over a single Appointment.findMany — for a typical
 * month at clinic scale (100 clinicians × 1k appts) this is fast enough that
 * a denormalised summary table isn't worth the maintenance cost.
 */
const workloadSchema = z.object({
    month:    z.string().regex(/^\d+$/).optional(),
    year:     z.string().regex(/^\d+$/).optional(),
    branchId: z.string().optional(),
});

function _workingDaysInMonth(year, month0Indexed) {
    const last = new Date(year, month0Indexed + 1, 0).getDate();
    let count = 0;
    for (let d = 1; d <= last; d++) {
        const dow = new Date(year, month0Indexed, d).getDay();
        if (dow !== 0) count++; // Sunday off; tweak to match clinic policy if needed
    }
    return count;
}

function _weekIndexInMonth(date) {
    // Calendar weeks: 1–7 → 0, 8–14 → 1, 15–21 → 2, 22–28 → 3, 29–31 → 4.
    return Math.min(4, Math.floor((date.getDate() - 1) / 7));
}

router.get('/workload-distribution', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), validate({ query: workloadSchema }), async (req, res, next) => {
    try {
        const now = new Date();
        const month = req.query.month ? parseInt(req.query.month, 10) : (now.getMonth() + 1);
        const year  = req.query.year  ? parseInt(req.query.year, 10)  : now.getFullYear();
        if (month < 1 || month > 12) return res.status(400).json({ error: 'Invalid month (1-12)' });

        const monthStart = new Date(year, month - 1, 1);
        const monthEnd   = new Date(year, month, 1); // exclusive
        const branchId   = typeof req.query.branchId === 'string' && req.query.branchId.length > 0
            ? req.query.branchId : null;

        const appts = await prisma.appointment.findMany({
            where: {
                date: { gte: monthStart, lt: monthEnd },
                ...(branchId ? { branchId } : {}),
            },
            select: {
                date: true,
                status: true,
                doctorId: true,
                therapistId: true,
                doctor:    { select: { id: true, fullName: true } },
                therapist: { select: { id: true, fullName: true } },
            },
        });

        const workingDays = _workingDaysInMonth(year, month - 1);
        const weekCount = Math.ceil(new Date(year, month, 0).getDate() / 7);

        // Bucket: keyed by `{role}:{id}`. Each clinician aggregates appointments
        // attached via either doctorId or therapistId (an appointment with both
        // is counted on each side — surfaces the workload from that side's view).
        const byClinician = new Map();

        function bucketFor(key, name, role) {
            let b = byClinician.get(key);
            if (!b) {
                b = {
                    id: key.split(':')[1], name: name || 'Unknown', role,
                    totalAppointments: 0, completedAppointments: 0, cancelledAppointments: 0, noShowCount: 0,
                    appointmentsByWeek: Array(weekCount).fill(0),
                    perDay: new Map(),
                };
                byClinician.set(key, b);
            }
            return b;
        }

        const weeklyTotals = Array(weekCount).fill(0);

        for (const a of appts) {
            const week = _weekIndexInMonth(a.date);
            weeklyTotals[week] = (weeklyTotals[week] || 0) + 1;

            const targets = [];
            if (a.doctorId)    targets.push({ key: `DOCTOR:${a.doctorId}`,       name: a.doctor?.fullName,    role: 'DOCTOR' });
            if (a.therapistId) targets.push({ key: `THERAPIST:${a.therapistId}`, name: a.therapist?.fullName, role: 'THERAPIST' });

            for (const t of targets) {
                const b = bucketFor(t.key, t.name, t.role);
                b.totalAppointments++;
                if (a.status === 'COMPLETED')                       b.completedAppointments++;
                if (a.status === 'CANCELLED' || a.status === 'REJECTED') b.cancelledAppointments++;
                if (a.status === 'NO_SHOW')                         b.noShowCount++;
                b.appointmentsByWeek[week] = (b.appointmentsByWeek[week] || 0) + 1;
                const dayKey = a.date.toISOString().slice(0, 10);
                b.perDay.set(dayKey, (b.perDay.get(dayKey) || 0) + 1);
            }
        }

        const clinicians = Array.from(byClinician.values()).map((b) => {
            let peakDay = null, peakCount = 0;
            for (const [day, count] of b.perDay) {
                if (count > peakCount) { peakDay = day; peakCount = count; }
            }
            return {
                id: b.id,
                name: b.name,
                role: b.role,
                totalAppointments: b.totalAppointments,
                completedAppointments: b.completedAppointments,
                cancelledAppointments: b.cancelledAppointments,
                noShowCount: b.noShowCount,
                avgDailyLoad: workingDays > 0 ? +(b.totalAppointments / workingDays).toFixed(2) : 0,
                peakDay,
                appointmentsByWeek: b.appointmentsByWeek,
            };
        });

        const totalAppointments = clinicians.reduce((sum, c) => sum + c.totalAppointments, 0);
        const avgPerClinician = clinicians.length > 0
            ? +(totalAppointments / clinicians.length).toFixed(2)
            : 0;
        const topPerformer = clinicians.length > 0
            ? clinicians.reduce((best, c) => (c.totalAppointments > best.totalAppointments ? c : best)).name
            : null;
        // "Underloaded" = avgDailyLoad < 60% of branch average.
        const branchAvgDaily = clinicians.length > 0
            ? clinicians.reduce((s, c) => s + c.avgDailyLoad, 0) / clinicians.length
            : 0;
        const underloadedCount = clinicians.filter((c) => c.avgDailyLoad < branchAvgDaily * 0.6).length;

        res.json({
            month,
            year,
            summary: {
                totalAppointments,
                avgPerClinician,
                topPerformer,
                underloadedCount,
            },
            clinicians,
            weeklyTotals,
        });
    } catch (err) { next(err); }
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
