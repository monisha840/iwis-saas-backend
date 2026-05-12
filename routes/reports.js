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
