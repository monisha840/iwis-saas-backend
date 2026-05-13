import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * GamificationAnalyticsService — provides admin-level analytics
 * on how gamification is impacting engagement and outcomes.
 */
export class GamificationAnalyticsService {
    /**
     * Get engagement overview: how many clinicians are actively competing.
     */
    static async getEngagementOverview() {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const [totalClinicians, activeStreaks, recentAudits, totalBadgesAwarded, anomalies] = await Promise.all([
            // Total clinicians
            Promise.all([
                prisma.doctor.count(),
                prisma.therapist.count()
            ]).then(([d, t]) => d + t),

            // Clinicians with active streaks (>0)
            prisma.clinicianStreak.count({ where: { currentStreak: { gt: 0 } } }),

            // Clinicians scored in last 7 days
            prisma.leaderboardAudit.groupBy({
                by: ['participantId'],
                where: { calculationDate: { gte: sevenDaysAgo } },
                _count: true
            }),

            // Total badges awarded
            prisma.userBadge.count(),

            // Unresolved anomalies
            prisma.gamificationAnomaly.count({ where: { resolved: false } })
        ]);

        return {
            totalClinicians,
            activelyCompeting: recentAudits.length,
            competitionRate: totalClinicians > 0
                ? Math.round((recentAudits.length / totalClinicians) * 100)
                : 0,
            activeStreaks,
            streakRate: totalClinicians > 0
                ? Math.round((activeStreaks / totalClinicians) * 100)
                : 0,
            totalBadgesAwarded,
            unresolvedAnomalies: anomalies
        };
    }

    /**
     * Score distribution: average score over time (last 12 weeks).
     *
     * Always emits 12 weekly buckets — older code returned an empty array
     * when LeaderboardAudit had no records, which left the
     * "Average Score Trend (12 Weeks)" chart blank on fresh installs. We
     * now fall back to averaged XPLedger amounts per week so the chart at
     * least surfaces clinician activity even before the first audit run.
     */
    static async getScoreTrend() {
        const buckets = [];
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
            const weekStart = new Date(now);
            weekStart.setHours(0, 0, 0, 0);
            weekStart.setDate(weekStart.getDate() - i * 7);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekEnd.getDate() + 7);
            buckets.push({
                weekStart,
                weekEnd,
                week: weekStart.toISOString().split('T')[0],
                label: `${weekStart.getDate()}/${weekStart.getMonth() + 1}`,
                avgScore: 0,
                sampleSize: 0,
                source: 'EMPTY',
            });
        }

        const earliest = buckets[0].weekStart;
        const latest = buckets[buckets.length - 1].weekEnd;

        // Primary source: LeaderboardAudit. We pull all rows in the 12-week
        // window and bucket by week. If a bucket ends up with zero samples
        // we'll backfill it from XPLedger below.
        const audits = await prisma.leaderboardAudit.findMany({
            where: { calculationDate: { gte: earliest, lt: latest } },
            select: { score: true, calculationDate: true },
        }).catch(() => []);
        for (const audit of audits) {
            const t = new Date(audit.calculationDate).getTime();
            const idx = buckets.findIndex(b => t >= b.weekStart.getTime() && t < b.weekEnd.getTime());
            if (idx === -1) continue;
            buckets[idx].avgScore = (buckets[idx].avgScore * buckets[idx].sampleSize + audit.score) / (buckets[idx].sampleSize + 1);
            buckets[idx].sampleSize += 1;
            buckets[idx].source = 'AUDIT';
        }

        const needsFallback = buckets.some(b => b.sampleSize === 0);
        if (needsFallback) {
            const xpRows = await prisma.xPLedger.findMany({
                where: { createdAt: { gte: earliest, lt: latest } },
                select: { xpAmount: true, createdAt: true },
            }).catch(() => []);
            for (const row of xpRows) {
                const t = new Date(row.createdAt).getTime();
                const idx = buckets.findIndex(b => t >= b.weekStart.getTime() && t < b.weekEnd.getTime());
                if (idx === -1) continue;
                if (buckets[idx].source === 'AUDIT') continue; // prefer audit data
                buckets[idx].avgScore = (buckets[idx].avgScore * buckets[idx].sampleSize + row.xpAmount) / (buckets[idx].sampleSize + 1);
                buckets[idx].sampleSize += 1;
                buckets[idx].source = 'XP_FALLBACK';
            }
        }

        return buckets.map(b => ({
            week: b.week,
            label: b.label,
            avgScore: Math.round(b.avgScore * 10) / 10,
            sampleSize: b.sampleSize,
            source: b.source,
        }));
    }

    /**
     * Correlation analysis: do higher-scoring clinicians have better patient outcomes?
     */
    static async getOutcomeCorrelation() {
        // Get latest scores per clinician
        const latestScores = await prisma.leaderboardAudit.findMany({
            orderBy: { calculationDate: 'desc' },
            distinct: ['participantId'],
            select: { participantId: true, score: true, participantRole: true }
        });

        // Bucket clinicians into score ranges
        const buckets = {
            'low_0_40': { min: 0, max: 40, clinicians: [], avgOutcome: 0 },
            'mid_40_70': { min: 40, max: 70, clinicians: [], avgOutcome: 0 },
            'high_70_90': { min: 70, max: 90, clinicians: [], avgOutcome: 0 },
            'top_90_100': { min: 90, max: 100, clinicians: [], avgOutcome: 0 },
        };

        for (const entry of latestScores) {
            for (const bucket of Object.values(buckets)) {
                if (entry.score >= bucket.min && entry.score < bucket.max) {
                    bucket.clinicians.push(entry.participantId);
                    break;
                }
            }
        }

        // For each bucket, compute average journey success rate
        for (const [key, bucket] of Object.entries(buckets)) {
            if (bucket.clinicians.length === 0) continue;

            const journeys = await prisma.journey.findMany({
                where: {
                    OR: [
                        { doctorId: { in: bucket.clinicians } },
                        { therapistId: { in: bucket.clinicians } }
                    ]
                },
                select: { status: true }
            });

            const total = journeys.length;
            const completed = journeys.filter(j => j.status === 'COMPLETED').length;
            bucket.avgOutcome = total > 0 ? Math.round((completed / total) * 100) : 0;
        }

        return Object.entries(buckets).map(([key, b]) => ({
            scoreRange: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            clinicianCount: b.clinicians.length,
            avgJourneySuccessRate: b.avgOutcome
        }));
    }

    /**
     * Badge distribution: how many of each badge have been awarded.
     */
    static async getBadgeDistribution() {
        const badges = await prisma.badge.findMany({
            where: { isActive: true },
            include: { _count: { select: { awards: true } } },
            orderBy: { tier: 'asc' }
        });

        return badges.map(b => ({
            code: b.code,
            name: b.name,
            tier: b.tier,
            icon: b.icon,
            awardedCount: b._count.awards
        }));
    }

    /**
     * Config impact analysis: compare metrics before/after a config change.
     */
    static async getConfigImpact() {
        // Get the two most recent configs to find when a change happened
        const configs = await prisma.leaderboardConfig.findMany({
            orderBy: { createdAt: 'desc' },
            take: 2
        });

        if (configs.length < 2) {
            return { hasComparison: false, message: 'Need at least 2 config versions for comparison' };
        }

        const changeDate = configs[0].createdAt;
        const fourWeeksBefore = new Date(changeDate.getTime() - 28 * 24 * 60 * 60 * 1000);
        const fourWeeksAfter = new Date(changeDate.getTime() + 28 * 24 * 60 * 60 * 1000);

        const [beforeAudits, afterAudits] = await Promise.all([
            prisma.leaderboardAudit.findMany({
                where: { calculationDate: { gte: fourWeeksBefore, lt: changeDate } },
                select: { score: true }
            }),
            prisma.leaderboardAudit.findMany({
                where: { calculationDate: { gte: changeDate, lte: fourWeeksAfter } },
                select: { score: true }
            })
        ]);

        const avgBefore = beforeAudits.length > 0
            ? beforeAudits.reduce((s, a) => s + a.score, 0) / beforeAudits.length
            : 0;
        const avgAfter = afterAudits.length > 0
            ? afterAudits.reduce((s, a) => s + a.score, 0) / afterAudits.length
            : 0;

        return {
            hasComparison: true,
            configChangedAt: changeDate,
            before: {
                avgScore: Math.round(avgBefore * 10) / 10,
                sampleSize: beforeAudits.length,
                period: `${fourWeeksBefore.toISOString().split('T')[0]} to ${changeDate.toISOString().split('T')[0]}`
            },
            after: {
                avgScore: Math.round(avgAfter * 10) / 10,
                sampleSize: afterAudits.length,
                period: `${changeDate.toISOString().split('T')[0]} to ${fourWeeksAfter.toISOString().split('T')[0]}`
            },
            impact: Math.round((avgAfter - avgBefore) * 10) / 10,
            impactPercent: avgBefore > 0
                ? Math.round(((avgAfter - avgBefore) / avgBefore) * 1000) / 10
                : 0
        };
    }

    /**
     * Patient gamification overview.
     */
    static async getPatientGamificationStats() {
        const [totalPatients, activePatients, avgPoints, streakData, challengeCompletions] = await Promise.all([
            prisma.patient.count(),
            prisma.patient.count({ where: { zenPoints: { gt: 0 } } }),
            prisma.patient.aggregate({ _avg: { zenPoints: true }, _max: { zenPoints: true } }),
            prisma.patientStreak.aggregate({
                _avg: { currentStreak: true },
                _max: { currentStreak: true },
                _count: true
            }),
            prisma.patientChallengeCompletion.count()
        ]);

        return {
            totalPatients,
            activePatients,
            engagementRate: totalPatients > 0 ? Math.round((activePatients / totalPatients) * 100) : 0,
            avgZenPoints: Math.round(avgPoints._avg?.zenPoints || 0),
            maxZenPoints: avgPoints._max?.zenPoints || 0,
            avgStreakDays: Math.round(streakData._avg?.currentStreak || 0),
            longestStreak: streakData._max?.currentStreak || 0,
            totalChallengesCompleted: challengeCompletions
        };
    }
}
