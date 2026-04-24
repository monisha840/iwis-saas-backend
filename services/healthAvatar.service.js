import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';

/**
 * HealthAvatarService — virtual companion that visually reflects patient
 * engagement.
 *
 * Avatar types: PLANT, PET, CHARACTER
 *
 * **Single source of truth**: avatar level/XP is derived from
 * `Patient.zenPoints`. The `HealthAvatar.xp` column is now a cache that
 * mirrors zenPoints — ZenPointsService.awardPoints() calls syncFromZenPoints()
 * after every award so the avatar never drifts. Avatar-specific state
 * (health/happiness/lastFedAt/appearance) remains owned by this service.
 *
 * Level thresholds match ZenPointsService:
 *   Level 1: Seedling/Hatchling/Novice     (0   pts)  — Zen Seedling
 *   Level 2: Sprout/Puppy/Apprentice       (100 pts)  — Wellness Sprout
 *   Level 3: Sapling/Adult/Journeyman      (300 pts)  — Harmony Seeker
 *   Level 4: Tree/Champion/Expert          (600 pts)  — Balance Master
 *   Level 5: Ancient/Legend/Master         (1000 pts) — Zen Sage
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

    // Activity → wellness boost. (XP comes exclusively from ZenPointsService now.)
    // health/happiness deltas only.
    static ACTIVITY_BOOST = {
        VITAL_LOG:      { health: 5,  happiness: 5  },
        CHECKIN:        { health: 5,  happiness: 10 },
        EXERCISE:       { health: 10, happiness: 10 },
        MEDICATION:     { health: 5,  happiness: 5  },
        QUEST_COMPLETE: { health: 10, happiness: 20 },
        STREAK_BONUS:   { health: 5,  happiness: 15 },
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
     * Get or create avatar for a patient. The avatar's xp/level mirror the
     * patient's current zenPoints — see syncFromZenPoints().
     */
    static async getOrCreateAvatar(patientId) {
        let avatar = await prisma.healthAvatar.findUnique({ where: { patientId } });

        if (!avatar) {
            const patient = await prisma.patient.findUnique({
                where: { id: patientId },
                select: { zenPoints: true },
            });
            const zen = patient?.zenPoints || 0;
            const initialLevel = this._calculateLevel(zen);
            avatar = await prisma.healthAvatar.create({
                data: {
                    patientId,
                    avatarType: 'PLANT',
                    name: 'Sprout',
                    level: initialLevel,
                    health: 50,
                    happiness: 50,
                    xp: zen,
                    appearance: JSON.stringify({
                        stage: this._getStageName('PLANT', initialLevel),
                        accessories: [],
                        color: 'green',
                    }),
                }
            });
            logger.info(`[HealthAvatar] Created avatar for patient ${patientId}`);
        } else {
            // Cheap reconciliation in case the cache drifted.
            avatar = await this._reconcileXp(avatar);
        }

        return this._formatAvatar(avatar);
    }

    /**
     * "Feed" the avatar when the patient completes an activity. This now
     * only bumps wellness state (health/happiness) and re-syncs the level
     * from Patient.zenPoints. XP is granted exclusively by ZenPointsService.
     */
    static async feedAvatar(patientId, activityType) {
        let avatar = await prisma.healthAvatar.findUnique({ where: { patientId } });
        if (!avatar) {
            avatar = (await this.getOrCreateAvatar(patientId)) && await prisma.healthAvatar.findUnique({ where: { patientId } });
        }

        const boost = this.ACTIVITY_BOOST[activityType] || { health: 5, happiness: 5 };
        const newHealth = Math.min(100, avatar.health + boost.health);
        const newHappiness = Math.min(100, avatar.happiness + boost.happiness);

        await prisma.healthAvatar.update({
            where: { patientId },
            data: {
                health: newHealth,
                happiness: newHappiness,
                lastFedAt: new Date(),
            },
        });

        // Single-source-of-truth refresh — pulls xp/level from Patient.zenPoints
        // and emits a level-up event/notification when crossing a threshold.
        return this.syncFromZenPoints(patientId);
    }

    /**
     * Mirror Patient.zenPoints into HealthAvatar.{xp,level}. Called by
     * ZenPointsService.awardPoints after every grant so the avatar's
     * progress always equals the patient's overall progress.
     *
     * Emits 'achievement_unlocked' when crossing a level boundary.
     */
    static async syncFromZenPoints(patientId) {
        const [patient, avatar] = await Promise.all([
            prisma.patient.findUnique({
                where: { id: patientId },
                select: { zenPoints: true, userId: true },
            }),
            prisma.healthAvatar.findUnique({ where: { patientId } }),
        ]);
        if (!patient) return null;

        // No avatar yet — create one (which seeds from zenPoints).
        if (!avatar) {
            return this.getOrCreateAvatar(patientId);
        }

        const newXp = patient.zenPoints || 0;
        if (newXp === avatar.xp) {
            // Already in sync — no-op.
            return this._formatAvatar(avatar);
        }

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
                level: newLevel,
                appearance: JSON.stringify(appearance),
            },
        });

        if (newLevel > oldLevel) {
            try {
                emitToUser(patient.userId, 'achievement_unlocked', {
                    type: 'AVATAR_LEVEL_UP',
                    title: `${avatar.name} evolved to ${stageName}!`,
                    level: newLevel,
                });
                await prisma.notification.create({
                    data: {
                        userId: patient.userId,
                        type: 'ACHIEVEMENT',
                        title: 'Avatar Level Up!',
                        message: `Your avatar ${avatar.name} evolved to ${stageName} (Level ${newLevel})!`,
                        priority: 'MEDIUM',
                        data: { avatarName: avatar.name, newLevel, stageName },
                    },
                });
                logger.info(`[HealthAvatar] Patient ${patientId} avatar leveled up to ${newLevel} (${stageName})`);
            } catch (err) {
                logger.warn('[HealthAvatar] level-up notify failed', { err: err.message });
            }
        }

        return this._formatAvatar(updated);
    }

    /**
     * Internal: ensure the cached xp matches Patient.zenPoints without
     * the side-effects of syncFromZenPoints (no level-up notification).
     */
    static async _reconcileXp(avatar) {
        const patient = await prisma.patient.findUnique({
            where: { id: avatar.patientId },
            select: { zenPoints: true },
        });
        const zen = patient?.zenPoints || 0;
        if (zen === avatar.xp) return avatar;
        const newLevel = this._calculateLevel(zen);
        return prisma.healthAvatar.update({
            where: { id: avatar.id },
            data: { xp: zen, level: newLevel },
        });
    }

    /**
     * Get full avatar state with stage name, next level info, and progress.
     * Reconciles cached xp against Patient.zenPoints on read.
     */
    static async getAvatarState(patientId) {
        let avatar = await prisma.healthAvatar.findUnique({ where: { patientId } });
        if (!avatar) return null;
        avatar = await this._reconcileXp(avatar);
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
