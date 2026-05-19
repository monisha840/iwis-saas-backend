import prisma from '../lib/prisma.js';


/**
 * Analytics service for data aggregation and reporting
 */
class AnalyticsService {
    /**
     * Get patient progress analytics.
     *
     * Source switched from the legacy `Journey` model (session-counting,
     * Doctor.id-keyed) to `TreatmentJourney` (phase-based IWIS clinical
     * journey, User.id-keyed) — bug-fix for the empty Patient Progress
     * section. Existing product flows populate TreatmentJourney; the
     * legacy table is mostly empty in current installs.
     *
     * Response shape kept identical so the frontend stays unchanged:
     *   totalSessions      = total phases on the journey
     *   completedSessions  = phases with status COMPLETED
     *   progress           = completedPhases / totalPhases × 100
     *
     * `doctorId` filter accepts either Doctor.id or User.id — the column
     * is User.id on TreatmentJourney, so we resolve once if the caller
     * passed a Doctor.id by mistake.
     */
    async getPatientProgress(filters = {}) {
        const { startDate, endDate, doctorId, status, branchId } = filters;

        const where = {};
        if (startDate || endDate) {
            where.startDate = {};
            if (startDate) where.startDate.gte = new Date(startDate);
            if (endDate) where.startDate.lte = new Date(endDate);
        }
        if (status) where.status = status;
        // TreatmentJourney has its own branchId column — direct filter.
        if (branchId) where.branchId = branchId;
        if (doctorId) {
            const docRow = await prisma.doctor.findFirst({
                where:  { OR: [{ id: doctorId }, { userId: doctorId }] },
                select: { userId: true },
            });
            // If caller passed an id that doesn't match either form, fall
            // back to it as-is — the query will return nothing and the
            // empty state surfaces, which is the correct response for an
            // unknown doctor id.
            where.doctorId = docRow?.userId || doctorId;
        }

        const journeys = await prisma.treatmentJourney.findMany({
            where,
            include: {
                // patientId is User.id — nested include reaches the Patient profile.
                patient: { include: { patient: true } },
                // doctorId is User.id — same hop.
                doctor:  { include: { doctor: true } },
                phases:  { select: { status: true } },
            },
            orderBy: { startDate: 'desc' },
        });

        return journeys.map((journey) => {
            const totalPhases = journey.phases.length;
            const completedPhases = journey.phases.filter((p) => p.status === 'COMPLETED').length;
            const patientName = journey.patient?.patient?.fullName
                || journey.patient?.email
                || 'Unknown';
            const doctorName = journey.doctor?.doctor?.fullName
                || journey.doctor?.email
                || 'Unknown';
            return {
                patientId: journey.patient?.patient?.patientId
                    || journey.patient?.patient?.id
                    || journey.patient?.id
                    || null,
                patientName,
                totalSessions: totalPhases,
                completedSessions: completedPhases,
                progress: totalPhases > 0
                    ? Math.round((completedPhases / totalPhases) * 100)
                    : 0,
                lastSession: journey.updatedAt,
                status: journey.status,
                doctorName,
            };
        });
    }

    /**
     * Get doctor performance analytics
     * @param {Object} filters - Date range and doctor filters
     */
    async getDoctorPerformance(filters = {}) {
        const { startDate, endDate, branchId } = filters;

        const where = {};
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) where.createdAt.gte = new Date(startDate);
            if (endDate) where.createdAt.lte = new Date(endDate);
        }

        // Limit roster to doctors whose user belongs to the scoped branch.
        const doctorWhere = branchId ? { user: { branchId } } : {};
        // Within each doctor's nested appointment/prescription counts we also
        // restrict to the same branch so cross-branch activity isn't double-counted.
        const nestedWhere = { ...where, ...(branchId ? { branchId } : {}) };

        const doctors = await prisma.doctor.findMany({
            where: doctorWhere,
            include: {
                appointments: {
                    where: nestedWhere,
                },
                prescriptions: {
                    where: nestedWhere,
                },
            },
        });

        return doctors.map((doctor) => {
            const totalAppointments = doctor.appointments.length;
            const completedAppointments = doctor.appointments.filter(
                (a) => a.status === 'COMPLETED'
            ).length;
            const cancelledAppointments = doctor.appointments.filter(
                (a) => a.status === 'CANCELLED'
            ).length;

            return {
                doctorId: doctor.id,
                doctorName: doctor.fullName,
                specialization: doctor.specialization,
                totalAppointments,
                completedAppointments,
                cancelledAppointments,
                completionRate: totalAppointments > 0
                    ? Math.round((completedAppointments / totalAppointments) * 100)
                    : 0,
                totalPrescriptions: doctor.prescriptions.length,
                avgRating: 0, // TODO: Implement rating system
            };
        });
    }

    /**
     * Get appointment analytics
     * @param {Object} filters - Date range and status filters
     */
    async getAppointmentAnalytics(filters = {}) {
        const { startDate, endDate, status, doctorId, therapistId, branchId } = filters;

        const where = {};
        if (startDate || endDate) {
            where.date = {};
            if (startDate) where.date.gte = new Date(startDate);
            if (endDate) where.date.lte = new Date(endDate);
        }
        if (status) where.status = status;
        if (doctorId) where.doctorId = doctorId;
        if (therapistId) where.therapistId = therapistId;
        if (branchId) where.branchId = branchId;

        const appointments = await prisma.appointment.findMany({
            where,
            include: {
                patient: true,
                doctor: true,
                therapist: true,
            },
            orderBy: { date: 'desc' },
        });

        // Group by status
        const statusCounts = appointments.reduce((acc, apt) => {
            acc[apt.status] = (acc[apt.status] || 0) + 1;
            return acc;
        }, {});

        // Group by consultation mode
        const modeCounts = appointments.reduce((acc, apt) => {
            acc[apt.consultationMode] = (acc[apt.consultationMode] || 0) + 1;
            return acc;
        }, {});

        // Daily appointment trend
        const dailyTrend = appointments.reduce((acc, apt) => {
            const date = new Date(apt.date).toISOString().split('T')[0];
            acc[date] = (acc[date] || 0) + 1;
            return acc;
        }, {});

        return {
            total: appointments.length,
            byStatus: statusCounts,
            byMode: modeCounts,
            dailyTrend,
            appointments: appointments.map((apt) => ({
                appointmentId: apt.id,
                patientName: apt.patient.fullName,
                doctorName: apt.doctor?.fullName || 'N/A',
                therapistName: apt.therapist?.fullName || 'N/A',
                date: apt.date.toISOString().split('T')[0],
                time: apt.date.toTimeString().split(' ')[0],
                status: apt.status,
                type: apt.consultationMode,
            })),
        };
    }

    /**
     * Get prescription analytics
     */
    async getPrescriptionAnalytics(filters = {}) {
        const { startDate, endDate, doctorId, patientId, branchId } = filters;

        const where = {};
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) where.createdAt.gte = new Date(startDate);
            if (endDate) where.createdAt.lte = new Date(endDate);
        }
        if (doctorId) where.doctorId = doctorId;
        if (patientId) where.patientId = patientId;
        // Prescription has a direct branchId column on the model (see schema.prisma).
        if (branchId) where.branchId = branchId;

        const prescriptions = await prisma.prescription.findMany({
            where,
            include: {
                patient: true,
                doctor: true,
                therapist: true,
            },
        });

        // Top medications
        const medicationCounts = prescriptions.reduce((acc, rx) => {
            acc[rx.medicationName] = (acc[rx.medicationName] || 0) + 1;
            return acc;
        }, {});

        const topMedications = Object.entries(medicationCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10)
            .map(([name, count]) => ({ medication: name, count }));

        return {
            total: prescriptions.length,
            topMedications,
            byDoctor: prescriptions.reduce((acc, rx) => {
                const doctor = rx.doctor?.fullName || rx.therapist?.fullName || 'Unknown';
                acc[doctor] = (acc[doctor] || 0) + 1;
                return acc;
            }, {}),
        };
    }

    /**
     * Get dashboard summary statistics
     */
    async getDashboardStats(role, userId) {
        const stats = {};

        if (role === 'ADMIN' || role === 'ADMIN_DOCTOR') {
            const [patients, doctors, appointments, prescriptions] = await Promise.all([
                prisma.patient.count(),
                prisma.doctor.count(),
                prisma.appointment.count(),
                prisma.prescription.count(),
            ]);

            stats.totalPatients = patients;
            stats.totalDoctors = doctors;
            stats.totalAppointments = appointments;
            stats.totalPrescriptions = prescriptions;
        }

        if (role === 'DOCTOR' || role === 'ADMIN_DOCTOR') {
            const doctor = await prisma.doctor.findUnique({
                where: { userId },
                select: { id: true }
            });

            if (doctor) {
                const now = new Date();
                const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

                const [totalApts, totalRx, todayApts, completedApts] = await Promise.all([
                    prisma.appointment.count({ where: { doctorId: doctor.id } }),
                    prisma.prescription.count({ where: { doctorId: doctor.id } }),
                    prisma.appointment.count({
                        where: {
                            doctorId: doctor.id,
                            date: { gte: todayStart, lte: todayEnd }
                        }
                    }),
                    prisma.appointment.count({
                        where: {
                            doctorId: doctor.id,
                            status: 'COMPLETED'
                        }
                    })
                ]);

                stats.myAppointments = totalApts;
                stats.myPrescriptions = totalRx;
                stats.todayAppointments = todayApts;
                stats.completedSittings = completedApts;
            }
        }

        if (role === 'THERAPIST') {
            const therapist = await prisma.therapist.findUnique({
                where: { userId },
                select: { id: true }
            });

            if (therapist) {
                const now = new Date();
                const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

                const [todaySittings, completedSittings, activePatients, cancelledSittings, totalSittings] = await Promise.all([
                    prisma.appointment.count({
                        where: {
                            therapistId: therapist.id,
                            date: { gte: todayStart, lte: todayEnd }
                        }
                    }),
                    prisma.appointment.count({
                        where: {
                            therapistId: therapist.id,
                            status: 'COMPLETED'
                        }
                    }),
                    prisma.appointment.groupBy({
                        by: ['patientId'],
                        where: {
                            therapistId: therapist.id,
                            status: { not: 'COMPLETED' }
                        }
                    }),
                    prisma.appointment.count({
                        where: {
                            therapistId: therapist.id,
                            status: 'CANCELLED'
                        }
                    }),
                    prisma.appointment.count({
                        where: { therapistId: therapist.id }
                    }),
                ]);

                stats.todaySittings = todaySittings;
                stats.completedSittings = completedSittings;
                stats.activeCases = activePatients.length;
                stats.hoursWorked = (completedSittings * 0.75).toFixed(1);
                // % of all sessions ever scheduled that have been completed
                stats.recoveryProgress = totalSittings > 0
                    ? Math.round((completedSittings / totalSittings) * 100)
                    : 0;
                // % of non-pending sessions that were not cancelled (adherence)
                stats.sessionAdherence = (completedSittings + cancelledSittings) > 0
                    ? Math.round((completedSittings / (completedSittings + cancelledSittings)) * 100)
                    : 0;
            }
        }

        return stats;
    }

    /**
     * Get dynamic comparative progress report for a client
     * @param {string} patientId - The patient ID
     */
    async getClientProgressReport(patientId) {
        const patient = await prisma.patient.findUnique({
            where: { id: patientId },
            include: {
                dailyCheckIns: { orderBy: { createdAt: 'desc' } },
                appointments: {
                    where: { status: 'COMPLETED' },
                    orderBy: { date: 'desc' }
                }
            }
        });

        if (!patient) throw new Error('Patient not found');

        // Fetch medication adherence for the last 30 days
        const adherence = await this.getMedicationAdherence(patientId, 30);

        const totalSittings = patient.appointments.length;
        const currentCheckIn = patient.dailyCheckIns[0] || null;
        const historicalCheckIns = patient.dailyCheckIns.slice(1);

        const calculateAverage = (records, key) => {
            if (!records.length) return 0;
            const validRecords = records.filter(r => r[key] !== null && r[key] !== undefined);
            if (!validRecords.length) return 0;
            return validRecords.reduce((sum, r) => sum + r[key], 0) / validRecords.length;
        };

        const prevMetrics = {
            avgPain: calculateAverage(historicalCheckIns, 'painLevel'),
            avgMobility: calculateAverage(historicalCheckIns, 'mobilityScore'),
            avgSleep: calculateAverage(historicalCheckIns, 'sleepHours')
        };

        const currentMetrics = {
            pain: currentCheckIn?.painLevel || 0,
            mobility: currentCheckIn?.mobilityScore || 0,
            sleep: currentCheckIn?.sleepHours || 0,
            date: currentCheckIn?.createdAt
        };

        const calculateChange = (prev, curr, lowerIsBetter = false) => {
            if (prev === 0) return curr > 0 ? 100 : 0;
            const change = ((curr - prev) / prev) * 100;
            return lowerIsBetter ? -change : change;
        };

        const analysis = {
            painImprovement: calculateChange(prevMetrics.avgPain, currentMetrics.pain, true),
            mobilityImprovement: calculateChange(prevMetrics.avgMobility, currentMetrics.mobility),
            sleepImprovement: calculateChange(prevMetrics.avgSleep, currentMetrics.sleep),
            adherenceRate: adherence.overallRate
        };

        return {
            patientName: patient.fullName,
            totalPreviousSittings: totalSittings > 0 ? totalSittings - 1 : 0,
            previousData: {
                averages: prevMetrics,
                recordCount: historicalCheckIns.length,
                breakdown: historicalCheckIns.slice(0, 5).map(h => ({
                    date: h.createdAt,
                    pain: h.painLevel,
                    mobility: h.mobilityScore,
                    sleep: h.sleepHours
                }))
            },
            currentSession: {
                metrics: currentMetrics,
                notes: currentCheckIn?.notes || ''
            },
            adherence,
            progressAnalysis: {
                metrics: [
                    { label: 'Pain Level', change: analysis.painImprovement, current: currentMetrics.pain, previous: prevMetrics.avgPain },
                    { label: 'Mobility Score', change: analysis.mobilityImprovement, current: currentMetrics.mobility, previous: prevMetrics.avgMobility },
                    { label: 'Sleep Quality', change: analysis.sleepImprovement, current: currentMetrics.sleep, previous: prevMetrics.avgSleep }
                ],
                summary: this._generateSummary(analysis)
            }
        };
    }

    _generateSummary(analysis) {
        const trends = [];
        if (analysis.painImprovement > 5) trends.push("notable reduction in pain levels");
        else if (analysis.painImprovement < -5) trends.push("slight increase in reported pain");

        if (analysis.mobilityImprovement > 5) trends.push("significant improvement in mobility");
        if (analysis.sleepImprovement > 5) trends.push("better sleep patterns observed");

        let summary = trends.length === 0
            ? "Patient state is stable with no major changes in tracked metrics."
            : `The patient is showing a ${trends.join(' and ')}. Overall progress is positive.`;

        if (analysis.adherenceRate < 70) {
            summary += ` However, medication adherence is low (${analysis.adherenceRate}%), which may be affecting results.`;
        } else if (analysis.adherenceRate >= 90) {
            summary += ` Excellent medication adherence (${analysis.adherenceRate}%) is contributing to the recovery.`;
        }

        return summary;
    }

    /**
     * Get completed appointments for the current month with pagination and trends
     * @param {Object} filters - Role, branch, and pagination options
     */
    async getMonthlyCompletedAppointments(filters = {}) {
        const requestedPage = parseInt(filters.page) || 1;
        const page = Math.max(1, requestedPage);
        const limit = parseInt(filters.limit) || 10;
        const { role, userId, branchId } = filters;
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

        const where = {
            status: 'COMPLETED',
            date: {
                gte: startOfMonth,
                lte: endOfMonth
            }
        };

        // Role-based filtering.
        //
        // DOCTOR / THERAPIST → personal scope (their own completed appointments).
        // ADMIN / ADMIN_DOCTOR → org-wide oversight — NO personal-id filter.
        //
        // The previous code lumped ADMIN_DOCTOR in with DOCTOR, which
        // restricted Dr. Saleem's "this month" report to only HIS personal
        // completed appointments. Result: the Reports page showed an empty
        // section whenever an admin doctor hadn't personally consulted that
        // month, regardless of how many appointments the rest of the
        // hospital had completed. ADMIN_DOCTORs are now treated like
        // ADMIN here — they get the hospital-wide view.
        if (role === 'DOCTOR') {
            const doctor = await prisma.doctor.findUnique({ where: { userId } });
            if (doctor) where.doctorId = doctor.id;
        } else if (role === 'THERAPIST') {
            const therapist = await prisma.therapist.findUnique({ where: { userId } });
            if (therapist) where.therapistId = therapist.id;
        }

        // Branch filtering — when a branchId is provided (explicitly by an
        // admin via ?branchId, or implicitly from the caller's own
        // user.branchId for non-admins) scope the query to that branch.
        if (branchId) {
            where.branchId = branchId;
        }

        const [total, appointments] = await Promise.all([
            prisma.appointment.count({ where }),
            prisma.appointment.findMany({
                where,
                include: {
                    patient: true,
                    doctor: true,
                    therapist: true,
                    branch: true,
                },
                orderBy: { date: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            })
        ]);

        // Previous month stats for trend comparison
        const prevMonthWhere = { ...where, date: { gte: startOfPrevMonth, lte: endOfPrevMonth } };
        const prevMonthTotal = await prisma.appointment.count({ where: prevMonthWhere });

        let trend = 0;
        if (prevMonthTotal > 0) {
            trend = Math.round(((total - prevMonthTotal) / prevMonthTotal) * 100);
        } else if (total > 0) {
            trend = 100;
        }

        return {
            data: appointments.map(apt => ({
                id: apt.id,
                date: apt.date,
                patientName: apt.patient.fullName,
                doctorName: apt.doctor?.fullName || apt.therapist?.fullName || 'N/A',
                branchName: apt.branch?.name || 'Main',
                status: apt.status,
                sessionNotes: apt.sessionNotes || apt.notes
            })),
            meta: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / limit),
                trend,
                prevMonthTotal
            }
        };
    }

    /**
     * Get medication adherence analytics for a specific patient
     */
    async getMedicationAdherence(patientId, days = 30) {
        const now = new Date();
        const startDate = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));

        const logs = await prisma.medicationLog.findMany({
            where: {
                prescription: { patientId },
                date: { gte: startDate }
            },
            include: {
                prescription: true
            }
        });

        // Group by day for trend analysis
        const dailyTrendArr = {};
        logs.forEach(log => {
            const dateStr = log.date.toISOString().split('T')[0];
            if (!dailyTrendArr[dateStr]) {
                dailyTrendArr[dateStr] = { total: 0, taken: 0 };
            }
            dailyTrendArr[dateStr].total++;
            if (log.taken) dailyTrendArr[dateStr].taken++;
        });

        const trendData = Object.entries(dailyTrendArr).map(([date, data]) => ({
            date,
            adherenceRate: Math.round((data.taken / data.total) * 100)
        })).sort((a, b) => a.date.localeCompare(b.date));

        const totalExpected = logs.length;
        const totalTaken = logs.filter(l => l.taken).length;
        // No expected doses → no adherence to report. Returning 100 here was
        // misleading the doctor's progress card (showed a full bar against 0/0).
        const overallRate = totalExpected > 0 ? Math.round((totalTaken / totalExpected) * 100) : 0;

        return {
            patientId,
            overallRate,
            totalExpected,
            totalTaken,
            trendData
        };
    }

    /**
     * Get per-branch summary statistics for comparison.
     * Accessible by ADMIN and ADMIN_DOCTOR.
     */
    async getBranchSummary({ branchId } = {}) {
        const branches = await prisma.branch.findMany({
            where: { isActive: true, ...(branchId ? { id: branchId } : {}) },
            include: {
                appointments: {
                    select: { id: true, status: true },
                },
                patients: {
                    select: { id: true },
                },
                users: {
                    select: { id: true, role: true },
                },
            },
        });

        return branches.map((branch) => {
            const totalAppointments = branch.appointments.length;
            const completedAppointments = branch.appointments.filter(
                (a) => a.status === 'COMPLETED'
            ).length;
            const cancelledAppointments = branch.appointments.filter(
                (a) => a.status === 'CANCELLED'
            ).length;

            return {
                branchId: branch.id,
                branchName: branch.name,
                address: branch.address,
                totalPatients: branch.patients.length,
                totalAppointments,
                completedAppointments,
                cancelledAppointments,
                completionRate: totalAppointments > 0
                    ? Math.round((completedAppointments / totalAppointments) * 100)
                    : 0,
                totalDoctors: branch.users.filter((u) => u.role === 'DOCTOR' || u.role === 'ADMIN_DOCTOR').length,
                totalTherapists: branch.users.filter((u) => u.role === 'THERAPIST').length,
            };
        });
    }
}


export const analyticsService = new AnalyticsService();
