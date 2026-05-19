import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';

const MS_IN_A_DAY = 24 * 60 * 60 * 1000;

/**
 * BadgeService — manages achievement badges for clinicians.
 *
 * Badge types:
 *   - cumulative: threshold on a total count (e.g., 100 appointments)
 *   - streak: threshold on consecutive active days
 *   - rate: threshold on a percentage metric (e.g., 95% adherence)
 *   - milestone: one-off events (e.g., first completed journey)
 */
export class BadgeService {
    /**
     * Seed default badge definitions if they don't exist.
     */
    static async seedDefaults() {
        // Always (idempotently) seed todo-related badges — the early-return below
        // only skips the legacy seed when any badge already exists.
        await this.seedTodoBadges();

        const existing = await prisma.badge.count();
        if (existing > 0) return;

        const defaults = [
            // Streak badges
            { code: 'STREAK_7', name: '7-Day Streak', description: 'Active 7 consecutive days', icon: 'Flame', tier: 'BRONZE', criteria: { type: 'streak', metric: 'activeDays', threshold: 7 } },
            { code: 'STREAK_14', name: '14-Day Streak', description: 'Active 14 consecutive days', icon: 'Flame', tier: 'SILVER', criteria: { type: 'streak', metric: 'activeDays', threshold: 14 } },
            { code: 'STREAK_30', name: '30-Day Streak', description: 'Active 30 consecutive days', icon: 'Flame', tier: 'GOLD', criteria: { type: 'streak', metric: 'activeDays', threshold: 30 } },

            // Cumulative appointment badges
            { code: 'APPOINTMENTS_25', name: 'Rising Star', description: 'Completed 25 appointments', icon: 'Star', tier: 'BRONZE', criteria: { type: 'cumulative', metric: 'appointments', threshold: 25 } },
            { code: 'APPOINTMENTS_100', name: 'Century Club', description: 'Completed 100 appointments', icon: 'Award', tier: 'SILVER', criteria: { type: 'cumulative', metric: 'appointments', threshold: 100 } },
            { code: 'APPOINTMENTS_500', name: 'Patient Champion', description: 'Completed 500 appointments', icon: 'Trophy', tier: 'GOLD', criteria: { type: 'cumulative', metric: 'appointments', threshold: 500 } },
            { code: 'APPOINTMENTS_1000', name: 'Legendary Healer', description: 'Completed 1000 appointments', icon: 'Crown', tier: 'PLATINUM', criteria: { type: 'cumulative', metric: 'appointments', threshold: 1000 } },

            // Rate badges
            { code: 'ADHERENCE_95', name: 'Adherence Expert', description: 'Maintained 95%+ patient adherence', icon: 'CheckCircle', tier: 'SILVER', criteria: { type: 'rate', metric: 'adherence', threshold: 95 } },
            { code: 'RESPONSE_UNDER_15', name: 'Lightning Responder', description: 'Average response time under 15 minutes', icon: 'Zap', tier: 'GOLD', criteria: { type: 'rate', metric: 'responseTime', threshold: 15, comparison: 'lt' } },
            { code: 'SUCCESS_90', name: 'Recovery Maestro', description: '90%+ journey success rate', icon: 'Heart', tier: 'GOLD', criteria: { type: 'rate', metric: 'successRate', threshold: 90 } },

            // Milestone badges
            { code: 'FIRST_JOURNEY_COMPLETE', name: 'First Recovery', description: 'Completed your first patient journey', icon: 'Flag', tier: 'BRONZE', criteria: { type: 'milestone', metric: 'journeysCompleted', threshold: 1 } },
            { code: 'JOURNEYS_10', name: 'Journey Master', description: 'Completed 10 patient journeys', icon: 'Map', tier: 'SILVER', criteria: { type: 'milestone', metric: 'journeysCompleted', threshold: 10 } },

            // Score-based badges
            { code: 'SCORE_90', name: 'Master of Wellness', description: 'Achieved an excellence score of 90+', icon: 'Shield', tier: 'PLATINUM', criteria: { type: 'rate', metric: 'excellenceScore', threshold: 90 } },
            { code: 'TOP_3', name: 'Podium Finish', description: 'Ranked in the top 3 on the leaderboard', icon: 'Medal', tier: 'GOLD', criteria: { type: 'rank', metric: 'leaderboardRank', threshold: 3, comparison: 'lte' } },
        ];

        await prisma.badge.createMany({ data: defaults });
        logger.info(`[BadgeService] Seeded ${defaults.length} default badge definitions`);
    }

    /**
     * Idempotent seed of todo-completion badges (spec §7.5).
     * Safe to call on every startup — uses skipDuplicates on unique `code`.
     */
    static async seedTodoBadges() {
        const todoBadges = [
            { code: 'TASK_STARTER', name: 'Task Starter', description: 'Completed your first task', icon: 'CheckSquare', tier: 'BRONZE', criteria: { type: 'milestone', metric: 'todosCompleted', threshold: 1 } },
            { code: 'TASK_CONSISTENT_7', name: '7-Day Task Streak', description: 'Completed at least one task per day for 7 days', icon: 'Flame', tier: 'SILVER', criteria: { type: 'streak', metric: 'todoStreak', threshold: 7 } },
            { code: 'TASK_CONSISTENT_30', name: '30-Day Task Streak', description: 'Completed at least one task per day for 30 days', icon: 'Flame', tier: 'GOLD', criteria: { type: 'streak', metric: 'todoStreak', threshold: 30 } },
            { code: 'TASK_MASTER_50', name: 'Task Master', description: 'Completed 50 assigned tasks', icon: 'Trophy', tier: 'GOLD', criteria: { type: 'cumulative', metric: 'todosCompletedAssigned', threshold: 50 } },
            { code: 'TASK_MASTER_200', name: 'Task Legend', description: 'Completed 200 assigned tasks', icon: 'Crown', tier: 'PLATINUM', criteria: { type: 'cumulative', metric: 'todosCompletedAssigned', threshold: 200 } },
            { code: 'DELEGATION_PRO', name: 'Delegation Pro', description: 'Assigned 50 tasks to others', icon: 'Users', tier: 'SILVER', criteria: { type: 'cumulative', metric: 'todosAssignedToOthers', threshold: 50 } },
        ];
        try {
            await prisma.badge.createMany({ data: todoBadges, skipDuplicates: true });
            logger.info('[BadgeService] Todo badges seed complete');
        } catch (err) {
            logger.warn(`[BadgeService] Todo badge seed failed: ${err.message}`);
        }
    }

    /**
     * Check and award all eligible badges for a clinician.
     * Called after score recalculation.
     */
    static async checkAndAwardBadges(participantId, role, metrics, score, rank = null) {
        // Get the User ID from the profile ID
        const userRecord = role === 'DOCTOR'
            ? await prisma.doctor.findUnique({ where: { id: participantId }, select: { userId: true } })
            : await prisma.therapist.findUnique({ where: { id: participantId }, select: { userId: true } });

        if (!userRecord) return [];

        const userId = userRecord.userId;
        const badges = await prisma.badge.findMany({ where: { isActive: true } });
        const existingAwards = await prisma.userBadge.findMany({
            where: { userId },
            select: { badgeId: true }
        });
        const awardedBadgeIds = new Set(existingAwards.map(a => a.badgeId));

        // Gather current stats
        const stats = await this._gatherStats(participantId, metrics, score, rank);
        const newAwards = [];

        for (const badge of badges) {
            if (awardedBadgeIds.has(badge.id)) continue;

            const { criteria } = badge;
            if (this._meetsThreshold(stats, criteria)) {
                try {
                    const award = await prisma.userBadge.create({
                        data: { userId, badgeId: badge.id }
                    });
                    newAwards.push({ ...badge, awardId: award.id });

                    // Real-time notification
                    emitToUser(userId, 'badge_earned', {
                        badge: { code: badge.code, name: badge.name, icon: badge.icon, tier: badge.tier },
                        message: `You earned the "${badge.name}" badge!`
                    });
                } catch (err) {
                    // Unique-constraint race (badge already awarded between the
                    // earlier dedup read and our create). Strict equality —
                    // .includes('P2002') silently swallowed unrelated codes
                    // whose strings happened to contain that substring.
                    if (err.code !== 'P2002') {
                        logger.error(`[BadgeService] Failed to award badge ${badge.code}:`, err.message);
                    }
                }
            }
        }

        if (newAwards.length > 0) {
            logger.info(`[BadgeService] Awarded ${newAwards.length} badges to ${participantId}`);
        }
        return newAwards;
    }

    /**
     * Gather all stats needed for badge evaluation.
     *
     * Inputs:
     *   participantId — Doctor.id or Therapist.id (set by leaderboard.service).
     *
     * Output keys MUST match every `criteria.metric` referenced in
     * seedDefaults() + seedTodoBadges() — _meetsThreshold returns false on
     * an undefined value, so a missing key means that badge can NEVER fire.
     * Audit fix: todosCompleted / todoStreak / todosCompletedAssigned /
     * todosAssignedToOthers were missing entirely, leaving all six Task
     * badges (TASK_STARTER, TASK_CONSISTENT_*, TASK_MASTER_*, DELEGATION_PRO)
     * unreachable from this main award loop.
     */
    static async _gatherStats(participantId, metrics, score, rank) {
        // Resolve User.id from Doctor.id / Therapist.id — Todo and
        // TreatmentJourney both key on User.id, not the profile id.
        const [doctor, therapist] = await Promise.all([
            prisma.doctor.findUnique({ where: { id: participantId }, select: { userId: true } }).catch(() => null),
            prisma.therapist.findUnique({ where: { id: participantId }, select: { userId: true } }).catch(() => null),
        ]);
        const userId = doctor?.userId || therapist?.userId || null;

        // Total lifetime completed appointments (Appointment.doctorId is
        // Doctor.id, so participantId works directly).
        const totalAppointments = await prisma.appointment.count({
            where: {
                OR: [{ doctorId: participantId }, { therapistId: participantId }],
                status: 'COMPLETED',
            },
        });

        // Completed journeys — switch to TreatmentJourney (canonical IWIS
        // clinical model) for doctors. TreatmentJourney.doctorId is User.id,
        // not Doctor.id, so we use the resolved userId. Therapists are
        // currently not linked into TreatmentJourney; they remain on the
        // legacy Journey table where therapistId = Therapist.id.
        let completedJourneys = 0;
        if (userId && doctor) {
            completedJourneys += await prisma.treatmentJourney.count({
                where: { doctorId: userId, status: 'COMPLETED' },
            });
        }
        if (therapist) {
            completedJourneys += await prisma.journey.count({
                where: { therapistId: participantId, status: 'COMPLETED' },
            });
        }

        // Todo metrics — keyed on User.id, not Doctor.id/Therapist.id.
        // Without userId we can't query, so we report zeros (no false
        // positives on badges that should require todo activity).
        let todosCompleted = 0;
        let todosCompletedAssigned = 0;
        let todosAssignedToOthers = 0;
        let todoStreak = 0;
        if (userId) {
            const COMPLETED = 'COMPLETED';
            [todosCompleted, todosCompletedAssigned, todosAssignedToOthers] = await Promise.all([
                prisma.todo.count({
                    where: { assignedToId: userId, status: COMPLETED },
                }),
                prisma.todo.count({
                    where: { assignedToId: userId, status: COMPLETED, createdById: { not: userId } },
                }),
                prisma.todo.count({
                    where: { createdById: userId, assignedToId: { not: userId } },
                }),
            ]);

            // todoStreak — current consecutive days (ending today or
            // yesterday) on which the user completed ≥ 1 assigned todo.
            // We look back at most 60 days; anything beyond that isn't
            // realistic for the 7/30-day badges we evaluate against. The
            // walk-back allows "today" to be empty (user might not have
            // completed one yet) but breaks on the first missing prior day.
            const sixtyDaysAgo = new Date(Date.now() - 60 * MS_IN_A_DAY);
            const recent = await prisma.todo.findMany({
                where: {
                    assignedToId: userId,
                    status: COMPLETED,
                    completedAt: { not: null, gte: sixtyDaysAgo },
                },
                select: { completedAt: true },
            });
            const completedDays = new Set(
                recent.map((r) => r.completedAt.toISOString().slice(0, 10)),
            );
            const today = new Date(); today.setHours(0, 0, 0, 0);
            for (let i = 0; i < 60; i += 1) {
                const probe = new Date(today.getTime() - i * MS_IN_A_DAY).toISOString().slice(0, 10);
                if (completedDays.has(probe)) todoStreak += 1;
                else if (i === 0) continue; // today's empty is OK — streak still continues from yesterday
                else break;
            }
        }

        // Current overall streak (clinician engagement, not todo-specific).
        const streak = await prisma.clinicianStreak.findUnique({
            where: { participantId },
        }).catch(() => null);

        return {
            appointments: totalAppointments,
            activeDays: streak?.currentStreak || 0,
            longestStreak: streak?.longestStreak || 0,
            adherence: metrics?.adherence?.value || 0,
            responseTime: metrics?.responseTime?.value || 999,
            successRate: metrics?.successRate?.value || 0,
            journeysCompleted: completedJourneys,
            excellenceScore: score || 0,
            leaderboardRank: rank || 999,
            // Todo-completion metrics — referenced by TASK_STARTER,
            // TASK_CONSISTENT_*, TASK_MASTER_*, DELEGATION_PRO badge criteria.
            todosCompleted,
            todosCompletedAssigned,
            todosAssignedToOthers,
            todoStreak,
        };
    }

    /**
     * Evaluate if stats meet a badge's criteria.
     */
    static _meetsThreshold(stats, criteria) {
        const { type, metric, threshold, comparison = 'gte' } = criteria;
        const value = stats[metric];
        if (value === undefined) {
            logger.warn(`[BadgeService] criteria references unknown metric '${metric}'`, { type, threshold });
            return false;
        }

        if (comparison === 'lt') return value < threshold;
        if (comparison === 'lte') return value <= threshold;
        return value >= threshold;
    }

    /**
     * Event-driven re-evaluation of cumulative / streak / milestone badges
     * for one clinician identified by their User.id. Unlike
     * `checkAndAwardBadges` (which requires the full leaderboard metrics +
     * score + rank and is invoked from the leaderboard cron), this entry
     * point covers ONLY the badges whose criteria depend on
     * `_gatherStats`-side counts that we can derive without a live
     * leaderboard tick. Wire it into:
     *
     *   • Todo status → COMPLETED        (TASK_STARTER / TASK_CONSISTENT_* /
     *                                     TASK_MASTER_* / DELEGATION_PRO)
     *   • Appointment status → COMPLETED (APPOINTMENTS_25 / 100 / 500 / 1000)
     *   • TreatmentJourney → COMPLETED   (FIRST_JOURNEY_COMPLETE / JOURNEYS_10)
     *   • ClinicianStreak update         (STREAK_7 / 14 / 30)
     *
     * Rate / score badges (ADHERENCE_95, SCORE_90, TOP_3, etc.) require
     * live leaderboard metrics and stay with the cron-driven
     * `checkAndAwardBadges` path — we intentionally skip them here so a
     * mid-day Todo completion doesn't accidentally award SCORE_90 with
     * stale metrics.
     */
    static async checkCumulativeBadgesForUser(userId) {
        if (!userId) return [];

        // Find Doctor or Therapist profile keyed off this user.
        const [doctor, therapist] = await Promise.all([
            prisma.doctor.findUnique({ where: { userId }, select: { id: true } }).catch(() => null),
            prisma.therapist.findUnique({ where: { userId }, select: { id: true } }).catch(() => null),
        ]);
        const participantId = doctor?.id || therapist?.id || null;
        if (!participantId) return []; // user isn't a clinician

        const stats = await this._gatherStats(participantId, null, null, null);

        const badges = await prisma.badge.findMany({ where: { isActive: true } });
        const existingAwards = await prisma.userBadge.findMany({
            where: { userId },
            select: { badgeId: true },
        });
        const awardedBadgeIds = new Set(existingAwards.map((a) => a.badgeId));

        const newAwards = [];
        for (const badge of badges) {
            if (awardedBadgeIds.has(badge.id)) continue;
            const c = badge.criteria || {};
            // Skip rate/rank/score-type criteria — those need live metrics
            // that we don't have outside the leaderboard tick.
            if (c.type === 'rate' || c.type === 'rank') continue;

            if (this._meetsThreshold(stats, c)) {
                try {
                    const award = await prisma.userBadge.create({
                        data: { userId, badgeId: badge.id },
                    });
                    newAwards.push({ ...badge, awardId: award.id });
                    emitToUser(userId, 'badge_earned', {
                        badge: { code: badge.code, name: badge.name, icon: badge.icon, tier: badge.tier },
                        message: `You earned the "${badge.name}" badge!`,
                    });
                } catch (err) {
                    // Strict equality — substring matches were brittle.
                    if (err.code !== 'P2002') {
                        logger.error(`[BadgeService] Failed to award badge ${badge.code}:`, err.message);
                    }
                }
            }
        }

        if (newAwards.length > 0) {
            logger.info(`[BadgeService] Event-driven award: ${newAwards.length} badges to user ${userId}`);
        }
        return newAwards;
    }

    /**
     * Get all badges for a user.
     */
    static async getUserBadges(userId) {
        const awards = await prisma.userBadge.findMany({
            where: { userId },
            include: { badge: true },
            orderBy: { awardedAt: 'desc' }
        });
        return awards.map(a => ({
            id: a.id,
            code: a.badge.code,
            name: a.badge.name,
            description: a.badge.description,
            icon: a.badge.icon,
            tier: a.badge.tier,
            awardedAt: a.awardedAt
        }));
    }

    /**
     * Get all available badges with user's earned status.
     */
    static async getAllBadgesWithStatus(userId) {
        const [allBadges, userAwards] = await Promise.all([
            prisma.badge.findMany({ where: { isActive: true }, orderBy: { tier: 'asc' } }),
            prisma.userBadge.findMany({ where: { userId }, select: { badgeId: true, awardedAt: true } })
        ]);

        const awardMap = new Map(userAwards.map(a => [a.badgeId, a.awardedAt]));

        return allBadges.map(b => ({
            id: b.id,
            code: b.code,
            name: b.name,
            description: b.description,
            icon: b.icon,
            tier: b.tier,
            criteria: b.criteria,
            earned: awardMap.has(b.id),
            awardedAt: awardMap.get(b.id) || null
        }));
    }
}
