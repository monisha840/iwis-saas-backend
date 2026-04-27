import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ClinicianXPService } from './clinicianXP.service.js';
import { notificationService } from './notification.service.js';

// ADMIN_DOCTOR is oversight, not a participant — never targeted by challenges
// (notification fan-out + getActiveChallenges role match both rely on this).
const DEFAULT_TARGET_ROLES = ['DOCTOR', 'THERAPIST'];

/**
 * SeasonalChallengeService — time-limited challenges with XP/point rewards.
 */
export class SeasonalChallengeService {
    /**
     * Create a new seasonal challenge (admin).
     *
     * `creator` carries the originating admin's hospital + branch so the
     * post-create notification fan-out is scoped correctly.
     */
    static async createChallenge(
        { title, description, icon, metric, target, startDate, endDate, scope, targetRoles, rewardXP, rewardPoints },
        creator = {},
    ) {
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

        // Fan out in-app notifications to eligible participants. Best-effort:
        // a failure here must not roll back the challenge itself.
        this.notifyEligibleUsers(challenge, creator).catch((err) =>
            logger.error('[SeasonalChallengeService] Notification fan-out failed', err, { challengeId: challenge.id }),
        );

        return challenge;
    }

    /**
     * Notify every clinician matching the challenge's targetRoles that a new
     * challenge has been posted. Scoped to the creator's hospital — and, when
     * scope = BRANCH, further pinned to the creator's branch.
     */
    static async notifyEligibleUsers(challenge, creator = {}) {
        const roles = (challenge.targetRoles && challenge.targetRoles.length > 0)
            ? challenge.targetRoles
            : DEFAULT_TARGET_ROLES;

        const where = {
            role: { in: roles },
            deletedAt: null,
        };
        if (creator.hospitalId) where.hospitalId = creator.hospitalId;
        if (challenge.scope === 'BRANCH' && creator.branchId) where.branchId = creator.branchId;

        const recipients = await prisma.user.findMany({ where, select: { id: true } });
        if (recipients.length === 0) return 0;

        const endsOn = new Date(challenge.endDate).toLocaleDateString('en-GB');
        const rewardSummary = [
            challenge.rewardXP > 0 ? `${challenge.rewardXP} XP` : null,
            challenge.rewardPoints > 0 ? `${challenge.rewardPoints} pts` : null,
        ].filter(Boolean).join(' + ');

        const message = rewardSummary
            ? `${challenge.title} — ends ${endsOn}. Reward: ${rewardSummary}.`
            : `${challenge.title} — ends ${endsOn}.`;

        await Promise.allSettled(recipients.map((u) =>
            notificationService.createNotification({
                userId: u.id,
                type: 'SEASONAL_CHALLENGE_CREATED',
                title: 'New seasonal challenge',
                message,
                priority: 'LOW',
                data: {
                    challengeId: challenge.id,
                    title: challenge.title,
                    metric: challenge.metric,
                    target: challenge.target,
                    endDate: challenge.endDate,
                    rewardXP: challenge.rewardXP,
                    rewardPoints: challenge.rewardPoints,
                    scope: challenge.scope,
                },
            }),
        ));

        logger.info(`[SeasonalChallengeService] Notified ${recipients.length} user(s) about challenge ${challenge.id}`);
        return recipients.length;
    }

    /**
     * Get active challenges with user's progress.
     */
    static async getActiveChallenges(userId, role) {
        const now = new Date();
        const isAdminViewer = role === 'ADMIN' || role === 'ADMIN_DOCTOR';

        // Admins curate the catalog — they see every active challenge across
        // both target roles, with no progress attached (they don't participate).
        // Clinicians (DOCTOR / THERAPIST) only see challenges that target their
        // role, with their own progress hydrated.
        const challenges = await prisma.seasonalChallenge.findMany({
            where: {
                isActive: true,
                startDate: { lte: now },
                endDate: { gte: now },
                ...(isAdminViewer ? {} : { targetRoles: { hasSome: [role] } }),
            },
            orderBy: { endDate: 'asc' },
        });

        if (isAdminViewer) {
            return challenges.map(c => ({
                ...c,
                currentValue: 0,
                completed: false,
                completedAt: null,
                progressPercent: 0,
            }));
        }

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
