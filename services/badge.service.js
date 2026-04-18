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
                    // Unique constraint — already awarded (race condition guard)
                    if (!err.code?.includes('P2002')) {
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
     */
    static async _gatherStats(participantId, metrics, score, rank) {
        // Total lifetime appointments
        const totalAppointments = await prisma.appointment.count({
            where: {
                OR: [{ doctorId: participantId }, { therapistId: participantId }],
                status: 'COMPLETED'
            }
        });

        // Completed journeys
        const completedJourneys = await prisma.journey.count({
            where: {
                OR: [{ doctorId: participantId }, { therapistId: participantId }],
                status: 'COMPLETED'
            }
        });

        // Current streak
        const streak = await prisma.clinicianStreak.findUnique({
            where: { participantId }
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
        };
    }

    /**
     * Evaluate if stats meet a badge's criteria.
     */
    static _meetsThreshold(stats, criteria) {
        const { type, metric, threshold, comparison = 'gte' } = criteria;
        const value = stats[metric];
        if (value === undefined) return false;

        if (comparison === 'lt') return value < threshold;
        if (comparison === 'lte') return value <= threshold;
        return value >= threshold;
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
