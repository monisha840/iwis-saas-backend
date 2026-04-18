import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';

/**
 * HealthAvatarService — virtual companion that grows as patients engage.
 *
 * Avatar types: PLANT, PET, CHARACTER
 *
 * Levels (by XP):
 *   Level 1: Seedling/Hatchling/Novice     (0 XP)
 *   Level 2: Sprout/Puppy/Apprentice       (100 XP)
 *   Level 3: Sapling/Adult/Journeyman      (300 XP)
 *   Level 4: Tree/Champion/Expert           (600 XP)
 *   Level 5: Ancient/Legend/Master          (1000 XP)
 */
export class HealthAvatarService {
    static LEVEL_THRESHOLDS = [
        { level: 1, xp: 0 },
        { level: 2, xp: 100 },
        { level: 3, xp: 300 },
        { level: 4, xp: 600 },
        { level: 5, xp: 1000 }
    ];

    static STAGE_NAMES = {
        PLANT: ['Seedling', 'Sprout', 'Sapling', 'Tree', 'Ancient'],
        PET: ['Hatchling', 'Puppy', 'Adult', 'Champion', 'Legend'],
        CHARACTER: ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master']
    };

    static ACTIVITY_XP = {
        VITAL_LOG: 5,
        CHECKIN: 5,
        EXERCISE: 10,
        MEDICATION: 5,
        QUEST_COMPLETE: 20,
        STREAK_BONUS: 15
    };

    /**
     * Calculate level from XP.
     */
    static _calculateLevel(xp) {
        let level = 1;
        for (const t of this.LEVEL_THRESHOLDS) {
            if (xp >= t.xp) level = t.level;
        }
        return level;
    }

    /**
     * Get stage name based on avatar type and level.
     */
    static _getStageName(avatarType, level) {
        const stages = this.STAGE_NAMES[avatarType] || this.STAGE_NAMES.PLANT;
        return stages[level - 1] || stages[0];
    }

    /**
     * Get or create avatar for a patient.
     */
    static async getOrCreateAvatar(patientId) {
        let avatar = await prisma.healthAvatar.findUnique({ where: { patientId } });

        if (!avatar) {
            avatar = await prisma.healthAvatar.create({
                data: {
                    patientId,
                    avatarType: 'PLANT',
                    name: 'Sprout',
                    level: 1,
                    health: 50,
                    happiness: 50,
                    xp: 0,
                    appearance: JSON.stringify({ stage: 'Seedling', accessories: [], color: 'green' })
                }
            });
            logger.info(`[HealthAvatar] Created avatar for patient ${patientId}`);
        }

        return this._formatAvatar(avatar);
    }

    /**
     * Feed avatar when patient completes an activity.
     * Awards XP, increases health and happiness, recalculates level.
     */
    static async feedAvatar(patientId, activityType) {
        let avatar = await prisma.healthAvatar.findUnique({ where: { patientId } });
        if (!avatar) {
            avatar = await prisma.healthAvatar.create({
                data: { patientId }
            });
        }

        const xpGain = this.ACTIVITY_XP[activityType] || 5;
        const newXp = avatar.xp + xpGain;
        const newHealth = Math.min(100, avatar.health + 5);
        const newHappiness = Math.min(100, avatar.happiness + 10);
        const oldLevel = avatar.level;
        const newLevel = this._calculateLevel(newXp);
        const stageName = this._getStageName(avatar.avatarType, newLevel);

        const appearance = typeof avatar.appearance === 'string'
            ? JSON.parse(avatar.appearance)
            : (avatar.appearance || {});
        appearance.stage = stageName;

        const updated = await prisma.healthAvatar.update({
            where: { patientId },
            data: {
                xp: newXp,
                health: newHealth,
                happiness: newHappiness,
                level: newLevel,
                lastFedAt: new Date(),
                appearance: JSON.stringify(appearance)
            }
        });

        // Level up notification
        if (newLevel > oldLevel) {
            const patient = await prisma.patient.findUnique({
                where: { id: patientId },
                select: { userId: true }
            });

            if (patient) {
                emitToUser(patient.userId, 'achievement_unlocked', {
                    type: 'AVATAR_LEVEL_UP',
                    title: `${avatar.name} evolved to ${stageName}!`,
                    level: newLevel
                });

                await prisma.notification.create({
                    data: {
                        userId: patient.userId,
                        type: 'ACHIEVEMENT',
                        title: 'Avatar Level Up!',
                        message: `Your avatar ${avatar.name} evolved to ${stageName} (Level ${newLevel})!`,
                        priority: 'MEDIUM',
                        data: { avatarName: avatar.name, newLevel, stageName }
                    }
                });
            }

            logger.info(`[HealthAvatar] Patient ${patientId} avatar leveled up to ${newLevel} (${stageName})`);
        }

        return this._formatAvatar(updated);
    }

    /**
     * Get full avatar state with stage name, next level info, and progress.
     */
    static async getAvatarState(patientId) {
        const avatar = await prisma.healthAvatar.findUnique({ where: { patientId } });
        if (!avatar) return null;
        return this._formatAvatar(avatar);
    }

    /**
     * Scheduled job: decay avatar stats if not fed in 24+ hours.
     * Reduces health by 5 and happiness by 10 (min 0).
     */
    static async decayAvatar() {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const staleAvatars = await prisma.healthAvatar.findMany({
            where: { lastFedAt: { lt: cutoff } }
        });

        let decayedCount = 0;
        for (const avatar of staleAvatars) {
            await prisma.healthAvatar.update({
                where: { id: avatar.id },
                data: {
                    health: Math.max(0, avatar.health - 5),
                    happiness: Math.max(0, avatar.happiness - 10)
                }
            });
            decayedCount++;
        }

        logger.info(`[HealthAvatar] Decayed ${decayedCount} avatars`);
        return { decayedCount };
    }

    /**
     * Format avatar for API response.
     */
    static _formatAvatar(avatar) {
        const appearance = typeof avatar.appearance === 'string'
            ? JSON.parse(avatar.appearance)
            : (avatar.appearance || {});

        const currentLevel = avatar.level;
        const nextThreshold = this.LEVEL_THRESHOLDS.find(t => t.level === currentLevel + 1);
        const currentThreshold = this.LEVEL_THRESHOLDS.find(t => t.level === currentLevel);

        let progressToNext = 100;
        if (nextThreshold && currentThreshold) {
            const range = nextThreshold.xp - currentThreshold.xp;
            const current = avatar.xp - currentThreshold.xp;
            progressToNext = Math.min(Math.round((current / range) * 100), 100);
        }

        const stageName = this._getStageName(avatar.avatarType, currentLevel);
        const nextStageName = currentLevel < 5
            ? this._getStageName(avatar.avatarType, currentLevel + 1)
            : null;

        return {
            id: avatar.id,
            patientId: avatar.patientId,
            avatarType: avatar.avatarType,
            name: avatar.name,
            level: currentLevel,
            stageName,
            xp: avatar.xp,
            health: avatar.health,
            happiness: avatar.happiness,
            lastFedAt: avatar.lastFedAt,
            appearance,
            nextLevel: nextThreshold ? nextThreshold.level : null,
            nextLevelXp: nextThreshold ? nextThreshold.xp : null,
            nextStageName,
            progressToNext,
            updatedAt: avatar.updatedAt
        };
    }
}
