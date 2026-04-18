import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * PerformanceScorecardService — generates and retrieves doctor/therapist performance scorecards.
 */
export class PerformanceScorecardService {
    /**
     * Generate (or update) a scorecard for a single clinician for a given period.
     */
    static async generateScorecard(clinicianId, clinicianRole, period, periodType = 'MONTHLY') {
        const { start, end } = PerformanceScorecardService._parsePeriod(period, periodType);

        // Determine the profile field based on role
        const isDoctor = clinicianRole === 'DOCTOR' || clinicianRole === 'ADMIN_DOCTOR';
        const profileField = isDoctor ? 'doctorId' : 'therapistId';

        // Look up the clinician's profile ID
        const profileRelation = isDoctor ? 'doctor' : 'therapist';
        const user = await prisma.user.findUnique({
            where: { id: clinicianId },
            include: { [profileRelation]: { select: { id: true } } },
        });
        const profileId = user?.[profileRelation]?.id;
        if (!profileId) throw new Error(`No ${profileRelation} profile found for user ${clinicianId}`);

        // 1. Patients seen (completed appointments)
        const completedAppointments = await prisma.appointment.findMany({
            where: {
                [profileField]: profileId,
                status: 'COMPLETED',
                date: { gte: start, lte: end },
            },
            include: {
                feedback: { select: { rating: true } },
            },
        });

        const patientsSeenCount = completedAppointments.length;

        // 2. Average consultation duration (rough estimate from appointment metadata)
        // Use 20 min default if we don't have exact duration tracking
        const avgConsultationMins = patientsSeenCount > 0 ? 20 : 0;

        // 3. Average patient rating from AppointmentFeedback
        const feedbacks = completedAppointments
            .filter((a) => a.feedback)
            .map((a) => a.feedback.rating);
        const avgPatientRating =
            feedbacks.length > 0
                ? feedbacks.reduce((sum, r) => sum + r, 0) / feedbacks.length
                : 0;

        // 4. No-show rate
        const totalAppointments = await prisma.appointment.count({
            where: {
                [profileField]: profileId,
                date: { gte: start, lte: end },
            },
        });
        const noShowCount = await prisma.appointment.count({
            where: {
                [profileField]: profileId,
                status: 'NO_SHOW',
                date: { gte: start, lte: end },
            },
        });
        const noShowRate = totalAppointments > 0 ? (noShowCount / totalAppointments) * 100 : 0;

        // 5. Treatment completion rate (journeys completed / total journeys)
        let treatmentCompletionRate = 0;
        if (isDoctor) {
            const totalJourneys = await prisma.treatmentJourney.count({
                where: { doctorId: clinicianId, startDate: { gte: start, lte: end } },
            });
            const completedJourneys = await prisma.treatmentJourney.count({
                where: { doctorId: clinicianId, status: 'COMPLETED', startDate: { gte: start, lte: end } },
            });
            treatmentCompletionRate =
                totalJourneys > 0 ? (completedJourneys / totalJourneys) * 100 : 0;
        }

        // 6. Prescription accuracy — default to 100% unless we have rejection data
        const prescriptionAccuracy = 100;

        // 7. On-time rate — appointments where clinician was available on schedule
        // Approximation: non-cancelled, non-rescheduled / total
        const cancelledCount = await prisma.appointment.count({
            where: {
                [profileField]: profileId,
                status: { in: ['CANCELLED', 'RESCHEDULED'] },
                date: { gte: start, lte: end },
            },
        });
        const onTimeRate =
            totalAppointments > 0
                ? ((totalAppointments - cancelledCount) / totalAppointments) * 100
                : 0;

        // 8. Overall score — weighted composite
        const overallScore = PerformanceScorecardService._calculateOverallScore({
            avgPatientRating,
            noShowRate,
            treatmentCompletionRate,
            onTimeRate,
            patientsSeenCount,
        });

        // Upsert the scorecard
        const scorecard = await prisma.performanceScorecard.upsert({
            where: {
                clinicianId_period_periodType: { clinicianId, period, periodType },
            },
            create: {
                clinicianId,
                clinicianRole,
                period,
                periodType,
                patientsSeenCount,
                avgConsultationMins,
                avgPatientRating,
                noShowRate,
                treatmentCompletionRate,
                prescriptionAccuracy,
                onTimeRate,
                overallScore,
                rawMetrics: {
                    totalAppointments,
                    noShowCount,
                    cancelledCount,
                    feedbackCount: feedbacks.length,
                },
            },
            update: {
                clinicianRole,
                patientsSeenCount,
                avgConsultationMins,
                avgPatientRating,
                noShowRate,
                treatmentCompletionRate,
                prescriptionAccuracy,
                onTimeRate,
                overallScore,
                generatedAt: new Date(),
                rawMetrics: {
                    totalAppointments,
                    noShowCount,
                    cancelledCount,
                    feedbackCount: feedbacks.length,
                },
            },
        });

        logger.info(`[PerformanceScorecard] Generated for ${clinicianId} period=${period}: score=${overallScore.toFixed(1)}`);
        return scorecard;
    }

    /**
     * Get scorecards for a clinician.
     */
    static async getScorecards(clinicianId, { periodType } = {}) {
        const where = { clinicianId };
        if (periodType) where.periodType = periodType;

        return prisma.performanceScorecard.findMany({
            where,
            orderBy: { period: 'desc' },
        });
    }

    /**
     * Get all scorecards for a branch in a given period.
     */
    static async getBranchScorecards(branchId, period) {
        // Find all clinicians in this branch
        const users = await prisma.user.findMany({
            where: {
                branchId,
                role: { in: ['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST'] },
                deletedAt: null,
            },
            select: { id: true, email: true, role: true },
        });

        const clinicianIds = users.map((u) => u.id);
        if (clinicianIds.length === 0) return [];

        const scorecards = await prisma.performanceScorecard.findMany({
            where: {
                clinicianId: { in: clinicianIds },
                period,
            },
            orderBy: { overallScore: 'desc' },
        });

        // Attach user info
        const userMap = {};
        for (const u of users) userMap[u.id] = u;

        return scorecards.map((sc) => ({
            ...sc,
            clinician: userMap[sc.clinicianId] || null,
        }));
    }

    /**
     * Batch generate scorecards for all clinicians.
     */
    static async generateAllScorecards(period, periodType = 'MONTHLY') {
        const clinicians = await prisma.user.findMany({
            where: {
                role: { in: ['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST'] },
                deletedAt: null,
            },
            select: { id: true, role: true },
        });

        const results = [];
        for (const clinician of clinicians) {
            try {
                const sc = await PerformanceScorecardService.generateScorecard(
                    clinician.id,
                    clinician.role,
                    period,
                    periodType
                );
                results.push(sc);
            } catch (err) {
                logger.warn(`[PerformanceScorecard] Failed for ${clinician.id}: ${err.message}`);
            }
        }

        logger.info(`[PerformanceScorecard] Batch generated ${results.length}/${clinicians.length} scorecards for ${period}`);
        return { generated: results.length, total: clinicians.length, scorecards: results };
    }

    /**
     * Calculate weighted overall score.
     */
    static _calculateOverallScore({ avgPatientRating, noShowRate, treatmentCompletionRate, onTimeRate, patientsSeenCount }) {
        // Normalize rating to 0-100 scale (1-5 → 0-100)
        const ratingScore = (avgPatientRating / 5) * 100;
        // Invert no-show rate (lower is better)
        const noShowScore = Math.max(0, 100 - noShowRate * 2);
        // Volume bonus (capped at 100)
        const volumeScore = Math.min(100, patientsSeenCount * 2);

        // Weighted composite
        const weights = {
            rating: 0.25,
            noShow: 0.15,
            completion: 0.20,
            onTime: 0.20,
            volume: 0.20,
        };

        return (
            ratingScore * weights.rating +
            noShowScore * weights.noShow +
            treatmentCompletionRate * weights.completion +
            onTimeRate * weights.onTime +
            volumeScore * weights.volume
        );
    }

    /**
     * Parse period string into start/end dates.
     */
    static _parsePeriod(period, periodType) {
        if (periodType === 'QUARTERLY') {
            // e.g. "2026-Q1"
            const [year, q] = period.split('-Q');
            const quarterStart = (parseInt(q) - 1) * 3;
            const start = new Date(parseInt(year), quarterStart, 1);
            const end = new Date(parseInt(year), quarterStart + 3, 0, 23, 59, 59, 999);
            return { start, end };
        }
        // MONTHLY: e.g. "2026-04"
        const [year, month] = period.split('-').map(Number);
        const start = new Date(year, month - 1, 1);
        const end = new Date(year, month, 0, 23, 59, 59, 999);
        return { start, end };
    }
}
