import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ClinicianXPService } from './clinicianXP.service.js';

/**
 * SeasonalChallengeService — time-limited challenges with XP/point rewards.
 */
export class SeasonalChallengeService {
    /**
     * Create a new seasonal challenge (admin).
     */
    static async createChallenge({ title, description, icon, metric, target, startDate, endDate, scope, targetRoles, rewardXP, rewardPoints }) {
        const challenge = await prisma.seasonalChallenge.create({
            data: {
                title,
                description,
                icon: icon || 'Trophy',
                metric,
                target,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                scope: scope || 'INDIVIDUAL',
                targetRoles: targetRoles || [],
                rewardXP: rewardXP || 100,
                rewardPoints: rewardPoints || 0,
            },
        });

        logger.info(`[SeasonalChallengeService] Created challenge "${title}" (${challenge.id})`);
        return challenge;
    }

    /**
     * Get active challenges with user's progress.
     */
    static async getActiveChallenges(userId, role) {
        const now = new Date();
        const challenges = await prisma.seasonalChallenge.findMany({
            where: {
                isActive: true,
                startDate: { lte: now },
                endDate: { gte: now },
                targetRoles: { hasSome: [role] },
            },
            orderBy: { endDate: 'asc' },
        });

        // Fetch user's progress for each challenge
        const challengeIds = challenges.map(c => c.id);
        const progressRecords = await prisma.seasonalChallengeProgress.findMany({
            where: {
                challengeId: { in: challengeIds },
                participantId: userId,
            },
        });
        const progressMap = new Map(progressRecords.map(p => [p.challengeId, p]));

        return challenges.map(c => {
            const progress = progressMap.get(c.id);
            return {
                ...c,
                currentValue: progress?.currentValue || 0,
                completed: progress?.completed || false,
                completedAt: progress?.completedAt || null,
                progressPercent: Math.min(Math.round(((progress?.currentValue || 0) / c.target) * 100), 100),
            };
        });
    }

    /**
     * Update progress for a participant in a challenge.
     */
    static async updateProgress(challengeId, participantId, newValue) {
        const progress = await prisma.seasonalChallengeProgress.upsert({
            where: {
                challengeId_participantId: { challengeId, participantId },
            },
            create: {
                challengeId,
                participantId,
                currentValue: newValue,
            },
            update: {
                currentValue: newValue,
            },
        });

        // Check for completion
        await this.checkAndCompleteChallenge(challengeId, participantId);

        return progress;
    }

    /**
     * Check if a participant has completed a challenge and award rewards.
     */
    static async checkAndCompleteChallenge(challengeId, participantId) {
        const challenge = await prisma.seasonalChallenge.findUnique({ where: { id: challengeId } });
        if (!challenge) return null;

        const progress = await prisma.seasonalChallengeProgress.findUnique({
            where: { challengeId_participantId: { challengeId, participantId } },
        });

        if (!progress || progress.completed) return progress;

        if (progress.currentValue >= challenge.target) {
            const updated = await prisma.seasonalChallengeProgress.update({
                where: { id: progress.id },
                data: { completed: true, completedAt: new Date() },
            });

            // Award XP
            if (challenge.rewardXP > 0) {
                await ClinicianXPService.awardXP(
                    participantId,
                    'QUEST_COMPLETE',
                    challenge.rewardXP,
                    challengeId,
                    { challengeTitle: challenge.title, type: 'seasonal_challenge' }
                );
            }

            logger.info(`[SeasonalChallengeService] Participant ${participantId} completed challenge "${challenge.title}"`);
            return updated;
        }

        return progress;
    }

    /**
     * Get past challenges (paginated).
     */
    static async getChallengeHistory({ page = 1, limit = 20 } = {}) {
        const now = new Date();
        const skip = (page - 1) * limit;

        const [challenges, total] = await Promise.all([
            prisma.seasonalChallenge.findMany({
                where: { endDate: { lt: now } },
                orderBy: { endDate: 'desc' },
                skip,
                take: limit,
                include: {
                    progress: {
                        where: { completed: true },
                        select: { participantId: true, completedAt: true },
                    },
                },
            }),
            prisma.seasonalChallenge.count({ where: { endDate: { lt: now } } }),
        ]);

        return {
            challenges: challenges.map(c => ({
                ...c,
                completedCount: c.progress.length,
                progress: undefined,
            })),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        };
    }
}
