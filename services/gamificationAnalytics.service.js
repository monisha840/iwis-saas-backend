import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * GamificationAnalyticsService — provides admin-level analytics
 * on how gamification is impacting engagement and outcomes.
 */
export class GamificationAnalyticsService {
    /**
     * Get engagement overview: how many clinicians are actively competing.
     *
     * Audit fixes #5 + #11:
     *  - totalClinicians excludes soft-deleted users (the underlying User
     *    row's deletedAt was previously ignored, perpetually deflating
     *    competitionRate / streakRate as ex-clinicians accumulated).
     *  - activeStreaks adds an "updated within the last 7 days" guard so
     *    stale streak rows (clinicians whose ClinicianStreak hasn't been
     *    decremented to 0 yet) don't get counted as "active".
     */
    static async getEngagementOverview() {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const [totalClinicians, activeStreaks, recentAudits, totalBadgesAwarded, anomalies] = await Promise.all([
            // Total clinicians — exclude soft-deleted users.
            Promise.all([
                prisma.doctor.count({ where: { user: { deletedAt: null } } }),
                prisma.therapist.count({ where: { user: { deletedAt: null } } }),
            ]).then(([d, t]) => d + t),

            // Clinicians with a non-zero streak that was updated in the
            // last 7 days. The freshness guard avoids counting "ghost
            // streaks" left over from clinicians who haven't logged in
            // for months.
            prisma.clinicianStreak.count({
                where: { currentStreak: { gt: 0 }, updatedAt: { gte: sevenDaysAgo } },
            }),

            // Clinicians scored in last 7 days
            prisma.leaderboardAudit.groupBy({
                by: ['participantId'],
                where: { calculationDate: { gte: sevenDaysAgo } },
                _count: true,
            }),

            // Total badges awarded
            prisma.userBadge.count(),

            // Unresolved anomalies
            prisma.gamificationAnomaly.count({ where: { resolved: false } }),
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
            unresolvedAnomalies: anomalies,
        };
    }

    /**
     * Score distribution: average score over time (last 12 weeks).
     *
     * Source: LeaderboardAudit.score ONLY. The previous implementation
     * fell back to averaging XPLedger.xpAmount (raw XP, 10-1000 range)
     * when audit rows were missing — that mixed two incompatible units
     * on the same Y-axis, producing a dishonest trend line where a week
     * showing "35.7" could mean "avg excellence 35.7%" OR "avg XP grant
     * of 35.7 points". Audit fix #2: rely on a single source, return
     * `avgScore: null` for empty buckets so the chart can show a gap
     * rather than a fake zero.
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
                sum: 0,
                sampleSize: 0,
            });
        }

        const earliest = buckets[0].weekStart;
        const latest = buckets[buckets.length - 1].weekEnd;

        const audits = await prisma.leaderboardAudit.findMany({
            where: { calculationDate: { gte: earliest, lt: latest } },
            select: { score: true, calculationDate: true },
        }).catch(() => []);

        for (const audit of audits) {
            const t = new Date(audit.calculationDate).getTime();
            const idx = buckets.findIndex((b) => t >= b.weekStart.getTime() && t < b.weekEnd.getTime());
            if (idx === -1) continue;
            buckets[idx].sum += audit.score;
            buckets[idx].sampleSize += 1;
        }

        // Emit sample-size + an explicit null for empty buckets so the
        // chart can render gaps instead of misleading zeros (audit fix #18).
        return buckets.map((b) => ({
            week: b.week,
            label: b.label,
            avgScore: b.sampleSize > 0 ? Math.round((b.sum / b.sampleSize) * 10) / 10 : null,
            sampleSize: b.sampleSize,
            source: b.sampleSize > 0 ? 'AUDIT' : 'EMPTY',
        }));
    }

    /**
     * Correlation analysis: do higher-scoring clinicians have better patient outcomes?
     *
     * Audit fixes #3, #4, #10:
     *   - Top bucket now includes score === 100 (was `score < 100`, so a
     *     perfect score fell into NO bucket and the clinician was silently
     *     dropped from the analysis).
     *   - `participantId` in LeaderboardAudit is Doctor.id / Therapist.id.
     *     TreatmentJourney.doctorId is User.id (per platform doc gotcha).
     *     We resolve Doctor.id → User.id in one batched query per bucket
     *     before joining against TreatmentJourney. Journey (legacy) is
     *     still consulted as a fallback so therapist-led sessions stay
     *     visible — they have no TreatmentJourney link today.
     */
    static async getOutcomeCorrelation() {
        // Get latest scores per clinician
        const latestScores = await prisma.leaderboardAudit.findMany({
            orderBy: { calculationDate: 'desc' },
            distinct: ['participantId'],
            select: { participantId: true, score: true, participantRole: true },
        });

        // Bucket clinicians into score ranges. The top bucket is inclusive
        // on the upper bound to capture perfect 100s.
        const buckets = {
            low_0_40:   { min: 0,  max: 40,  inclusiveMax: false, clinicians: [], avgOutcome: 0 },
            mid_40_70:  { min: 40, max: 70,  inclusiveMax: false, clinicians: [], avgOutcome: 0 },
            high_70_90: { min: 70, max: 90,  inclusiveMax: false, clinicians: [], avgOutcome: 0 },
            top_90_100: { min: 90, max: 100, inclusiveMax: true,  clinicians: [], avgOutcome: 0 },
        };

        for (const entry of latestScores) {
            for (const bucket of Object.values(buckets)) {
                const fitsMin = entry.score >= bucket.min;
                const fitsMax = bucket.inclusiveMax ? entry.score <= bucket.max : entry.score < bucket.max;
                if (fitsMin && fitsMax) {
                    bucket.clinicians.push({ id: entry.participantId, role: entry.participantRole });
                    break;
                }
            }
        }

        for (const [, bucket] of Object.entries(buckets)) {
            if (bucket.clinicians.length === 0) continue;

            const doctorIds    = bucket.clinicians.filter((c) => c.role === 'DOCTOR').map((c) => c.id);
            const therapistIds = bucket.clinicians.filter((c) => c.role === 'THERAPIST').map((c) => c.id);

            // Resolve Doctor.id → User.id for the TreatmentJourney join.
            const doctorUsers = doctorIds.length
                ? await prisma.doctor.findMany({
                    where: { id: { in: doctorIds } },
                    select: { userId: true },
                })
                : [];
            const doctorUserIds = doctorUsers.map((d) => d.userId);

            // TreatmentJourney is keyed by User.id (canonical IWIS model).
            // Therapists are not linked into TreatmentJourney today.
            const tjPromise = doctorUserIds.length
                ? prisma.treatmentJourney.findMany({
                    where: { doctorId: { in: doctorUserIds } },
                    select: { status: true },
                })
                : Promise.resolve([]);

            // Legacy Journey model keys on Doctor.id / Therapist.id.
            const legacyPromise = (doctorIds.length || therapistIds.length)
                ? prisma.journey.findMany({
                    where: {
                        OR: [
                            ...(doctorIds.length    ? [{ doctorId:    { in: doctorIds } }]    : []),
                            ...(therapistIds.length ? [{ therapistId: { in: therapistIds } }] : []),
                        ],
                    },
                    select: { status: true },
                })
                : Promise.resolve([]);

            const [tjRows, legacyRows] = await Promise.all([tjPromise, legacyPromise]);
            const all = [...tjRows, ...legacyRows];
            const total = all.length;
            const completed = all.filter((j) => j.status === 'COMPLETED').length;
            bucket.avgOutcome = total > 0 ? Math.round((completed / total) * 100) : 0;
        }

        return Object.entries(buckets).map(([key, b]) => ({
            scoreRange: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            clinicianCount: b.clinicians.length,
            avgJourneySuccessRate: b.avgOutcome,
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
     *
     * Audit fix #9: previously this would happily return a huge "negative
     * impact" reading the moment a new config was created — the "after"
     * window was [now, now+4w] (entirely future), so `avgAfter = 0` and
     * the chart showed "Impact: -85.0" against a populated "before".
     * Now we require at least MIN_AFTER_SAMPLES rows in the after window
     * before publishing an impact figure.
     */
    static MIN_CONFIG_IMPACT_SAMPLES = 5;

    static async getConfigImpact() {
        // Get the two most recent configs to find when a change happened
        const configs = await prisma.leaderboardConfig.findMany({
            orderBy: { createdAt: 'desc' },
            take: 2,
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
                select: { score: true },
            }),
            prisma.leaderboardAudit.findMany({
                where: { calculationDate: { gte: changeDate, lte: fourWeeksAfter } },
                select: { score: true },
            }),
        ]);

        // Guard: don't publish an impact reading until enough data has
        // accumulated post-change. Otherwise a fresh config that was
        // created 5 minutes ago shows a fake "huge regression" against
        // 4 weeks of pre-change data.
        if (afterAudits.length < this.MIN_CONFIG_IMPACT_SAMPLES) {
            return {
                hasComparison: false,
                configChangedAt: changeDate,
                message: `Not enough data after config change yet (need ≥ ${this.MIN_CONFIG_IMPACT_SAMPLES} score events, have ${afterAudits.length}).`,
                afterSampleSize: afterAudits.length,
                requiredAfterSamples: this.MIN_CONFIG_IMPACT_SAMPLES,
            };
        }

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
     *
     * Audit fixes #6 + #7:
     *  - "Active patient" is now "earned zen points in the last 30 days"
     *    (queried via ZenPointsLedger) rather than "ever had zenPoints > 0"
     *    on the lifetime accumulator. A patient who earned 50 points six
     *    months ago and went dark since is no longer counted as engaged.
     *  - avgZenPoints is now averaged across ACTIVE patients only. Mixing
     *    in dormant accounts dragged the headline KPI toward zero and made
     *    it useless as an engagement signal.
     *  - totalPatients also excludes soft-deleted accounts.
     */
    static async getPatientGamificationStats() {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const [totalPatients, activeLedgerRows, maxAgg, streakData, challengeCompletions] = await Promise.all([
            prisma.patient.count({ where: { user: { deletedAt: null } } }),
            // Distinct patients who earned ≥ 1 point in the last 30 days.
            prisma.zenPointsLedger.groupBy({
                by: ['patientId'],
                where: { createdAt: { gte: thirtyDaysAgo }, points: { gt: 0 } },
                _count: true,
            }).catch(() => []),
            prisma.patient.aggregate({ _max: { zenPoints: true } }),
            prisma.patientStreak.aggregate({
                _avg: { currentStreak: true },
                _max: { currentStreak: true },
                _count: true,
            }),
            prisma.patientChallengeCompletion.count(),
        ]);

        const activePatientIds = activeLedgerRows.map((r) => r.patientId).filter(Boolean);
        const activePatients = activePatientIds.length;

        // Average zenPoints across ACTIVE patients only — avoids the prior
        // "average dragged to zero by dormant accounts" problem.
        let avgZenPoints = 0;
        if (activePatients > 0) {
            const activeAgg = await prisma.patient.aggregate({
                where: { id: { in: activePatientIds } },
                _avg: { zenPoints: true },
            });
            avgZenPoints = Math.round(activeAgg._avg?.zenPoints || 0);
        }

        return {
            totalPatients,
            activePatients,
            engagementRate: totalPatients > 0 ? Math.round((activePatients / totalPatients) * 100) : 0,
            avgZenPoints,
            maxZenPoints: maxAgg._max?.zenPoints || 0,
            avgStreakDays: Math.round(streakData._avg?.currentStreak || 0),
            longestStreak: streakData._max?.currentStreak || 0,
            totalChallengesCompleted: challengeCompletions,
            activeWindowDays: 30,
        };
    }
}
