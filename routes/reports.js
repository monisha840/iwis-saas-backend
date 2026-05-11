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

// ── Medication Adherence Dashboard ──────────────────────────────────────────
//
// Aggregates the MedicationLog table (the existing source of truth for taken/
// missed doses) into a per-patient compliance percentage over the requested
// period, plus a daily trend, a per-medicine breakdown, and a non-adherent
// patient list. Powers the dedicated /medication-adherence page.
const adherenceSchema = z.object({
    branchId: z.string().optional(),
    period: z.enum(['7d', '30d', '90d']).optional().default('30d'),
});

router.get(
    '/medication-adherence',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    validate({ query: adherenceSchema }),
    async (req, res, next) => {
        try {
            const period = (typeof req.query.period === 'string' ? req.query.period : '30d');
            const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
            const cutoff = new Date(Date.now() - days * 86400 * 1000);
            cutoff.setHours(0, 0, 0, 0);

            // ADMIN / ADMIN_DOCTOR may pass branchId; we don't force a JWT
            // branchId because ADMIN_DOCTOR is hospital-scoped (no branch pin).
            const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : null;
            const patientWhere = branchId ? { branchId } : {};

            // Pull all logs in window joined to prescription → patient, then
            // aggregate in-memory. The MedicationLog table size in the IWIS
            // dataset is < 100K rows over 90 days — fine for this scale.
            const logs = await prisma.medicationLog.findMany({
                where: {
                    date: { gte: cutoff },
                    prescription: { patient: patientWhere },
                },
                select: {
                    date: true,
                    taken: true,
                    medicationName: true,
                    prescriptionId: true,
                    prescription: {
                        select: {
                            patientId: true,
                            medicationName: true,
                            patient: {
                                select: {
                                    id: true,
                                    fullName: true,
                                    profilePhoto: true,
                                },
                            },
                            doctor: { select: { fullName: true } },
                        },
                    },
                },
            });

            const dayKey = (d) => d.toISOString().slice(0, 10);

            // Per-patient aggregation.
            const perPatient = new Map();
            // Per-medicine aggregation.
            const perMed = new Map();
            // Daily trend (taken / total per day).
            const perDay = new Map();

            for (const l of logs) {
                const pid = l.prescription?.patientId;
                if (!pid) continue;
                const patientRow = l.prescription.patient;
                if (!patientRow) continue;

                if (!perPatient.has(pid)) {
                    perPatient.set(pid, {
                        patientId: pid,
                        patientName: patientRow.fullName ?? 'Unknown',
                        avatar: patientRow.profilePhoto ?? null,
                        doctorName: l.prescription.doctor?.fullName ?? '—',
                        total: 0,
                        taken: 0,
                        lastTaken: null,
                    });
                }
                const ag = perPatient.get(pid);
                ag.total += 1;
                if (l.taken) {
                    ag.taken += 1;
                    if (!ag.lastTaken || l.date > ag.lastTaken) ag.lastTaken = l.date;
                }

                const med = l.medicationName || l.prescription.medicationName || 'Unknown';
                if (!perMed.has(med)) perMed.set(med, { taken: 0, total: 0, patients: new Set() });
                const m = perMed.get(med);
                m.total += 1;
                if (l.taken) m.taken += 1;
                m.patients.add(pid);

                const k = dayKey(l.date);
                if (!perDay.has(k)) perDay.set(k, { taken: 0, total: 0 });
                const dEntry = perDay.get(k);
                dEntry.total += 1;
                if (l.taken) dEntry.taken += 1;
            }

            const patients = [...perPatient.values()].map((p) => {
                const rate = p.total === 0 ? 0 : Math.round((p.taken / p.total) * 100);
                return {
                    patientId: p.patientId,
                    patientName: p.patientName,
                    adherenceRate: rate,
                    missedDoses: p.total - p.taken,
                    lastTaken: p.lastTaken ? p.lastTaken.toISOString() : null,
                    assignedDoctorName: p.doctorName,
                };
            });

            const totalPatients = patients.length;
            const adherentPatients = patients.filter((p) => p.adherenceRate >= 80).length;
            const atRiskPatients = patients.filter((p) => p.adherenceRate >= 60 && p.adherenceRate < 80).length;
            const nonAdherentPatients = patients.filter((p) => p.adherenceRate < 60).length;

            const totalLogs = logs.length;
            const takenLogs = logs.filter((l) => l.taken).length;
            const overallRate = totalLogs === 0 ? 0 : Math.round((takenLogs / totalLogs) * 100);

            // Trend: walk every day in window so missing days render as 0%.
            const trend = [];
            for (let i = days - 1; i >= 0; i -= 1) {
                const d = new Date();
                d.setHours(0, 0, 0, 0);
                d.setDate(d.getDate() - i);
                const k = dayKey(d);
                const entry = perDay.get(k);
                trend.push({
                    date: k,
                    rate: entry && entry.total > 0 ? Math.round((entry.taken / entry.total) * 100) : 0,
                });
            }

            const byMedicine = [...perMed.entries()]
                .map(([medicineName, m]) => ({
                    medicineName,
                    adherenceRate: m.total === 0 ? 0 : Math.round((m.taken / m.total) * 100),
                    patientCount: m.patients.size,
                }))
                .sort((a, b) => a.adherenceRate - b.adherenceRate);

            const nonAdherentList = patients
                .filter((p) => p.adherenceRate < 80)
                .sort((a, b) => a.adherenceRate - b.adherenceRate);

            res.json({
                data: {
                    summary: {
                        overallRate,
                        totalPatients,
                        adherentPatients,
                        atRiskPatients,
                        nonAdherentPatients,
                    },
                    trend,
                    byMedicine,
                    nonAdherentList,
                },
            });
        } catch (err) { next(err); }
    },
);

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
