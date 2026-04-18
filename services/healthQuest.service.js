import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';

/**
 * HealthQuestService — multi-step health quests that patients complete over days.
 *
 * Quests contain tasks like "Log vitals x7" or "Complete daily check-in x7".
 * Completing all tasks awards zen points and triggers achievement notifications.
 */
export class HealthQuestService {
    /**
     * Get available quests (active, not yet started by patient) plus in-progress quests.
     */
    static async getAvailableQuests(patientId) {
        const [allQuests, myProgress] = await Promise.all([
            prisma.healthQuest.findMany({ where: { isActive: true } }),
            prisma.patientQuestProgress.findMany({
                where: { patientId },
                select: { questId: true, status: true }
            })
        ]);

        const progressMap = new Map(myProgress.map(p => [p.questId, p.status]));

        const available = allQuests.filter(q => {
            const status = progressMap.get(q.id);
            // Show if not started or currently active
            return !status || status === 'ACTIVE';
        });

        return available.map(q => ({
            ...q,
            tasks: typeof q.tasks === 'string' ? JSON.parse(q.tasks) : q.tasks,
            status: progressMap.get(q.id) || 'NOT_STARTED'
        }));
    }

    /**
     * Start a quest — creates PatientQuestProgress with status ACTIVE.
     */
    static async startQuest(patientId, questId) {
        const quest = await prisma.healthQuest.findUnique({ where: { id: questId } });
        if (!quest) throw new Error('Quest not found');
        if (!quest.isActive) throw new Error('Quest is no longer active');

        // Check if already started
        const existing = await prisma.patientQuestProgress.findUnique({
            where: { patientId_questId: { patientId, questId } }
        });
        if (existing) {
            if (existing.status === 'ACTIVE') throw new Error('Quest already in progress');
            if (existing.status === 'COMPLETED') throw new Error('Quest already completed');
        }

        const progress = await prisma.patientQuestProgress.upsert({
            where: { patientId_questId: { patientId, questId } },
            update: { status: 'ACTIVE', tasksCompleted: '[]', startedAt: new Date(), pointsAwarded: false, completedAt: null },
            create: { patientId, questId, status: 'ACTIVE', tasksCompleted: '[]' },
            include: { quest: true }
        });

        logger.info(`[HealthQuest] Patient ${patientId} started quest ${quest.title}`);
        return progress;
    }

    /**
     * Record task progress for a quest.
     * If all tasks are complete, marks quest as COMPLETED and awards zen points.
     */
    static async recordTaskProgress(patientId, questId, taskIndex) {
        const progress = await prisma.patientQuestProgress.findUnique({
            where: { patientId_questId: { patientId, questId } },
            include: { quest: true }
        });

        if (!progress) throw new Error('Quest not started');
        if (progress.status !== 'ACTIVE') throw new Error(`Quest is ${progress.status.toLowerCase()}`);

        const tasks = typeof progress.quest.tasks === 'string'
            ? JSON.parse(progress.quest.tasks)
            : progress.quest.tasks;

        if (taskIndex < 0 || taskIndex >= tasks.length) {
            throw new Error('Invalid task index');
        }

        let completed = typeof progress.tasksCompleted === 'string'
            ? JSON.parse(progress.tasksCompleted)
            : progress.tasksCompleted;

        // Check if this specific progress entry already exists
        const alreadyCompleted = completed.find(c => c.taskIndex === taskIndex);
        if (alreadyCompleted) {
            // Increment progress count if target > 1
            const task = tasks[taskIndex];
            if (task.target && alreadyCompleted.count < task.target) {
                alreadyCompleted.count += 1;
                alreadyCompleted.completedAt = new Date().toISOString();
            } else {
                return { alreadyCompleted: true, progress: completed };
            }
        } else {
            completed.push({
                taskIndex,
                count: 1,
                completedAt: new Date().toISOString()
            });
        }

        // Check if all tasks are fully complete
        const allComplete = tasks.every((task, idx) => {
            const entry = completed.find(c => c.taskIndex === idx);
            return entry && entry.count >= (task.target || 1);
        });

        const updateData = {
            tasksCompleted: JSON.stringify(completed)
        };

        if (allComplete) {
            updateData.status = 'COMPLETED';
            updateData.completedAt = new Date();
        }

        const updated = await prisma.patientQuestProgress.update({
            where: { patientId_questId: { patientId, questId } },
            data: updateData,
            include: { quest: true }
        });

        // Award points if quest just completed
        if (allComplete && !progress.pointsAwarded) {
            const pointReward = progress.quest.pointReward;

            await Promise.all([
                prisma.patient.update({
                    where: { id: patientId },
                    data: { zenPoints: { increment: pointReward } }
                }),
                prisma.zenPointsLedger.create({
                    data: {
                        patientId,
                        action: 'QUEST_COMPLETE',
                        points: pointReward,
                        sourceId: questId
                    }
                }),
                prisma.patientQuestProgress.update({
                    where: { patientId_questId: { patientId, questId } },
                    data: { pointsAwarded: true }
                })
            ]);

            // Get userId for notifications
            const patient = await prisma.patient.findUnique({
                where: { id: patientId },
                select: { userId: true }
            });

            if (patient) {
                // Emit achievement event
                emitToUser(patient.userId, 'achievement_unlocked', {
                    type: 'QUEST_COMPLETE',
                    title: progress.quest.title,
                    points: pointReward
                });

                // Create notification
                await prisma.notification.create({
                    data: {
                        userId: patient.userId,
                        type: 'ACHIEVEMENT',
                        title: 'Quest Completed!',
                        message: `You completed "${progress.quest.title}" and earned ${pointReward} zen points!`,
                        priority: 'MEDIUM',
                        data: { questId, questTitle: progress.quest.title, pointsAwarded: pointReward }
                    }
                });
            }

            logger.info(`[HealthQuest] Patient ${patientId} completed quest ${progress.quest.title}, awarded ${pointReward} points`);
        }

        return {
            ...updated,
            tasksCompleted: completed,
            allComplete
        };
    }

    /**
     * Get patient's quests, optionally filtered by status.
     */
    static async getMyQuests(patientId, { status } = {}) {
        const where = { patientId };
        if (status) where.status = status;

        const quests = await prisma.patientQuestProgress.findMany({
            where,
            include: { quest: true },
            orderBy: { startedAt: 'desc' }
        });

        return quests.map(q => ({
            ...q,
            tasksCompleted: typeof q.tasksCompleted === 'string'
                ? JSON.parse(q.tasksCompleted)
                : q.tasksCompleted,
            quest: {
                ...q.quest,
                tasks: typeof q.quest.tasks === 'string'
                    ? JSON.parse(q.quest.tasks)
                    : q.quest.tasks
            }
        }));
    }

    /**
     * Mark quests past their durationDays as EXPIRED. For scheduled job.
     */
    static async checkExpiredQuests() {
        const activeQuests = await prisma.patientQuestProgress.findMany({
            where: { status: 'ACTIVE' },
            include: { quest: true }
        });

        let expiredCount = 0;
        const now = new Date();

        for (const progress of activeQuests) {
            const expiresAt = new Date(progress.startedAt);
            expiresAt.setDate(expiresAt.getDate() + progress.quest.durationDays);

            if (now > expiresAt) {
                await prisma.patientQuestProgress.update({
                    where: { id: progress.id },
                    data: { status: 'EXPIRED' }
                });
                expiredCount++;
            }
        }

        logger.info(`[HealthQuest] Expired ${expiredCount} quests`);
        return { expiredCount };
    }

    /**
     * Seed initial quest definitions if none exist.
     */
    static async seedDefaultQuests() {
        const existing = await prisma.healthQuest.count();
        if (existing > 0) return;

        const defaults = [
            {
                title: '7-Day Wellness Warrior',
                description: 'Build healthy habits over 7 days by logging vitals and completing daily check-ins.',
                icon: 'Shield',
                durationDays: 7,
                difficulty: 'EASY',
                pointReward: 50,
                tasks: JSON.stringify([
                    { title: 'Log vitals', type: 'VITAL_LOG', target: 7 },
                    { title: 'Complete daily check-in', type: 'CHECKIN', target: 7 }
                ])
            },
            {
                title: 'Medication Master',
                description: 'Stay on top of your medication for 14 days straight.',
                icon: 'Pill',
                durationDays: 14,
                difficulty: 'MEDIUM',
                pointReward: 100,
                tasks: JSON.stringify([
                    { title: 'Log medication', type: 'MEDICATION', target: 14 },
                    { title: 'Zero missed doses', type: 'MEDICATION_ADHERENCE', target: 14 }
                ])
            },
            {
                title: 'Active Recovery',
                description: 'Stay active during your recovery with exercises and pain tracking.',
                icon: 'Activity',
                durationDays: 7,
                difficulty: 'EASY',
                pointReward: 75,
                tasks: JSON.stringify([
                    { title: 'Complete exercises', type: 'EXERCISE', target: 5 },
                    { title: 'Log pain score', type: 'VITAL_LOG', target: 7 }
                ])
            },
            {
                title: 'Mindful Month',
                description: 'A 30-day holistic wellness challenge for mind and body.',
                icon: 'Brain',
                durationDays: 30,
                difficulty: 'HARD',
                pointReward: 200,
                tasks: JSON.stringify([
                    { title: 'Mood log', type: 'CHECKIN', target: 30 },
                    { title: 'Sleep 7h+', type: 'VITAL_LOG', target: 20 },
                    { title: 'Exercise', type: 'EXERCISE', target: 15 }
                ])
            }
        ];

        await prisma.healthQuest.createMany({ data: defaults });
        logger.info(`[HealthQuest] Seeded ${defaults.length} default quests`);
    }
}
