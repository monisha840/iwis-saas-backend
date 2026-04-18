import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ClinicianXPService } from './clinicianXP.service.js';
import { emitToUser } from '../websocket/index.js';

/**
 * TeamQuestService — branch-wide collaborative quests.
 * When completed, all clinicians in the branch receive XP.
 */
export class TeamQuestService {
    /**
     * Create a new team quest for a branch (admin).
     */
    static async createQuest(branchId, { title, description, icon, metric, target, startDate, endDate, rewardXP }, createdBy) {
        const quest = await prisma.teamQuest.create({
            data: {
                branchId,
                title,
                description,
                icon: icon || 'Users',
                metric,
                target,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                rewardXP: rewardXP || 200,
                createdBy,
            },
        });

        logger.info(`[TeamQuestService] Created quest "${title}" for branch ${branchId}`);
        return quest;
    }

    /**
     * Get active quests for a branch.
     */
    static async getActiveQuests(branchId) {
        const now = new Date();
        const quests = await prisma.teamQuest.findMany({
            where: {
                branchId,
                completed: false,
                startDate: { lte: now },
                endDate: { gte: now },
            },
            orderBy: { endDate: 'asc' },
            include: {
                branch: { select: { id: true, name: true } },
            },
        });

        return quests.map(q => ({
            ...q,
            progressPercent: Math.min(Math.round((q.currentValue / q.target) * 100), 100),
        }));
    }

    /**
     * Update quest progress.
     */
    static async updateQuestProgress(questId, newValue) {
        const quest = await prisma.teamQuest.update({
            where: { id: questId },
            data: { currentValue: newValue },
        });

        if (!quest.completed && quest.currentValue >= quest.target) {
            return this.completeQuest(questId);
        }

        return quest;
    }

    /**
     * Complete a quest and award XP to ALL branch clinicians.
     */
    static async completeQuest(questId) {
        const quest = await prisma.teamQuest.update({
            where: { id: questId },
            data: { completed: true, completedAt: new Date() },
        });

        // Find all clinicians in the branch
        const [doctors, therapists] = await Promise.all([
            prisma.doctor.findMany({ where: { branchId: quest.branchId }, select: { userId: true } }),
            prisma.therapist.findMany({ where: { branchId: quest.branchId }, select: { userId: true } }),
        ]);

        const userIds = [
            ...doctors.map(d => d.userId),
            ...therapists.map(t => t.userId),
        ];

        // Award XP to each clinician
        const awards = await Promise.allSettled(
            userIds.map(userId =>
                ClinicianXPService.awardXP(userId, 'QUEST_COMPLETE', quest.rewardXP, questId, {
                    questTitle: quest.title,
                    type: 'team_quest',
                })
            )
        );

        // Notify all branch clinicians
        for (const userId of userIds) {
            emitToUser(userId, 'quest_completed', {
                questId: quest.id,
                title: quest.title,
                xpAwarded: quest.rewardXP,
                message: `Team quest "${quest.title}" completed! You earned ${quest.rewardXP} XP!`,
            });
        }

        logger.info(`[TeamQuestService] Quest "${quest.title}" completed, awarded XP to ${userIds.length} clinicians`);
        return quest;
    }

    /**
     * Get past quests for a branch (paginated).
     */
    static async getQuestHistory(branchId, { page = 1, limit = 20 } = {}) {
        const skip = (page - 1) * limit;

        const where = { branchId, completed: true };
        const [quests, total] = await Promise.all([
            prisma.teamQuest.findMany({
                where,
                orderBy: { completedAt: 'desc' },
                skip,
                take: limit,
                include: { branch: { select: { id: true, name: true } } },
            }),
            prisma.teamQuest.count({ where }),
        ]);

        return {
            quests,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        };
    }
}
