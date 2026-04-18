import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';

/**
 * ReferralGamificationService — tier-based rewards for patient referrals.
 *
 * Tiers:
 *   Bronze Referrer:   1 completed referral  →  50 zen points
 *   Silver Referrer:   5 completed referrals  → 200 zen points + badge
 *   Gold Referrer:    10 completed referrals  → 500 zen points + badge
 *   Platinum Referrer: 25 completed referrals → 1000 zen points + badge
 */
export class ReferralGamificationService {
    static TIERS = [
        { name: 'Bronze Referrer', threshold: 1, points: 50, badgeCode: 'REFERRAL_BRONZE', badgeTier: 'BRONZE' },
        { name: 'Silver Referrer', threshold: 5, points: 200, badgeCode: 'REFERRAL_SILVER', badgeTier: 'SILVER' },
        { name: 'Gold Referrer', threshold: 10, points: 500, badgeCode: 'REFERRAL_GOLD', badgeTier: 'GOLD' },
        { name: 'Platinum Referrer', threshold: 25, points: 1000, badgeCode: 'REFERRAL_PLATINUM', badgeTier: 'PLATINUM' }
    ];

    /**
     * Check completed referral count and award appropriate tier points and badges.
     * Only awards each tier once.
     */
    static async checkAndAwardReferralTier(patientId) {
        const completedReferrals = await prisma.referral.count({
            where: { referrerId: patientId, status: 'COMPLETED' }
        });

        const patient = await prisma.patient.findUnique({
            where: { id: patientId },
            select: { userId: true }
        });

        if (!patient) return { awarded: [] };

        const awarded = [];

        for (const tier of this.TIERS) {
            if (completedReferrals < tier.threshold) continue;

            // Find or create the badge definition
            let badge = await prisma.badge.findUnique({
                where: { code: tier.badgeCode }
            });

            if (!badge) {
                badge = await prisma.badge.create({
                    data: {
                        code: tier.badgeCode,
                        name: tier.name,
                        description: `Completed ${tier.threshold} referral${tier.threshold > 1 ? 's' : ''}`,
                        icon: 'Users',
                        tier: tier.badgeTier,
                        criteria: { type: 'referral', metric: 'completedReferrals', threshold: tier.threshold }
                    }
                });
            }

            // Check if already awarded
            const existingAward = await prisma.userBadge.findUnique({
                where: { userId_badgeId: { userId: patient.userId, badgeId: badge.id } }
            });

            if (existingAward) continue;

            // Award badge
            await prisma.userBadge.create({
                data: { userId: patient.userId, badgeId: badge.id }
            });

            // Award zen points
            await Promise.all([
                prisma.patient.update({
                    where: { id: patientId },
                    data: { zenPoints: { increment: tier.points } }
                }),
                prisma.zenPointsLedger.create({
                    data: {
                        patientId,
                        action: 'REFERRAL_TIER',
                        points: tier.points,
                        sourceId: tier.badgeCode
                    }
                })
            ]);

            // Emit achievement
            emitToUser(patient.userId, 'achievement_unlocked', {
                type: 'REFERRAL_TIER',
                title: `You've earned the ${tier.name} title!`,
                points: tier.points,
                badge: tier.name
            });

            await prisma.notification.create({
                data: {
                    userId: patient.userId,
                    type: 'ACHIEVEMENT',
                    title: `${tier.name} Unlocked!`,
                    message: `You reached ${tier.threshold} completed referral${tier.threshold > 1 ? 's' : ''} and earned ${tier.points} zen points!`,
                    priority: 'MEDIUM',
                    data: { tier: tier.name, points: tier.points, badgeCode: tier.badgeCode }
                }
            });

            awarded.push(tier);
            logger.info(`[ReferralGamification] Patient ${patientId} awarded ${tier.name} (${tier.points} points)`);
        }

        return { awarded, completedReferrals };
    }

    /**
     * Get referral stats for a patient.
     */
    static async getReferralStats(patientId) {
        const [totalReferrals, completedReferrals] = await Promise.all([
            prisma.referral.count({ where: { referrerId: patientId } }),
            prisma.referral.count({ where: { referrerId: patientId, status: 'COMPLETED' } })
        ]);

        // Determine current tier
        let currentTier = null;
        let nextTier = null;

        for (let i = this.TIERS.length - 1; i >= 0; i--) {
            if (completedReferrals >= this.TIERS[i].threshold) {
                currentTier = this.TIERS[i];
                nextTier = this.TIERS[i + 1] || null;
                break;
            }
        }

        if (!currentTier) {
            nextTier = this.TIERS[0];
        }

        // Calculate total points earned from referral tiers
        const totalPointsEarned = this.TIERS
            .filter(t => completedReferrals >= t.threshold)
            .reduce((sum, t) => sum + t.points, 0);

        return {
            totalReferrals,
            completedReferrals,
            currentTier: currentTier?.name || 'None',
            nextTier: nextTier?.name || 'Max tier reached',
            referralsToNext: nextTier ? nextTier.threshold - completedReferrals : 0,
            totalPointsEarned
        };
    }
}
