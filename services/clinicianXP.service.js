import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';

/**
 * ClinicianXPService — XP & Level system for clinicians.
 *
 * Level tiers:
 *   Level 1: Intern       (0 XP)
 *   Level 2: Practitioner (500 XP)
 *   Level 3: Specialist   (1500 XP)
 *   Level 4: Expert       (3500 XP)
 *   Level 5: Master       (7000 XP)
 *   Level 6: Legend       (15000 XP)
 *
 * XP Actions:
 *   CONSULTATION:     10 XP
 *   ON_TIME_ARRIVAL:   5 XP
 *   POSITIVE_FEEDBACK:15 XP (rating >= 4)
 *   PATIENT_OUTCOME:  25 XP (journey completed)
 *   QUEST_COMPLETE:   varies
 *   BADGE_EARNED:     50 XP
 *   MENTOR_SESSION:   30 XP
 *   STREAK_BONUS:     currentStreak * 2 XP (daily)
 */
export class ClinicianXPService {
    static LEVEL_TIERS = [
        { level: 6, title: 'Legend',       minXP: 15000 },
        { level: 5, title: 'Master',       minXP: 7000  },
        { level: 4, title: 'Expert',       minXP: 3500  },
        { level: 3, title: 'Specialist',   minXP: 1500  },
        { level: 2, title: 'Practitioner', minXP: 500   },
        { level: 1, title: 'Intern',       minXP: 0     },
    ];

    static XP_ACTIONS = {
        CONSULTATION:          10,
        ON_TIME_ARRIVAL:        5,
        POSITIVE_FEEDBACK:     15,
        PATIENT_OUTCOME:       25,
        QUEST_COMPLETE:         0, // varies
        BADGE_EARNED:          50,
        MENTOR_SESSION:        30,
        STREAK_BONUS:           0, // currentStreak * 2
        DIET_PACKAGE_APPROVED: 25, // suggested default; admin can override per-approval
    };

    /**
     * Award XP to a clinician, applying streak multiplier (Feature 20).
     * Creates an XPLedger entry, updates ClinicianXP, recalculates level.
     */
    static async awardXP(userId, action, xpAmount, sourceId = null, metadata = null) {
        // Fetch streak multiplier (Feature 20: Consistency Multiplier)
        let multiplier = 1.0;
        try {
            // Find the clinician's profile ID to look up streak
            const doctor = await prisma.doctor.findUnique({ where: { userId }, select: { id: true } });
            const therapist = !doctor
                ? await prisma.therapist.findUnique({ where: { userId }, select: { id: true } })
                : null;
            const profileId = doctor?.id || therapist?.id;

            if (profileId) {
                const streak = await prisma.clinicianStreak.findUnique({
                    where: { participantId: profileId },
                    select: { streakMultiplier: true }
                });
                if (streak?.streakMultiplier) {
                    multiplier = streak.streakMultiplier;
                }
            }
        } catch (err) {
            logger.warn(`[ClinicianXPService] Could not fetch streak multiplier for ${userId}: ${err.message}`);
        }

        const finalXP = Math.round(xpAmount * multiplier);

        // Create ledger entry
        await prisma.xPLedger.create({
            data: {
                userId,
                action,
                xpAmount: finalXP,
                sourceId,
                metadata: metadata ? { ...metadata, baseXP: xpAmount, multiplier } : { baseXP: xpAmount, multiplier },
            },
        });

        // Upsert ClinicianXP
        const xpProfile = await prisma.clinicianXP.upsert({
            where: { userId },
            create: { userId, totalXP: finalXP, level: 1, title: 'Intern' },
            update: { totalXP: { increment: finalXP } },
        });

        // Recalculate level
        const updated = await this.recalculateLevel(userId);

        // Emit real-time event
        emitToUser(userId, 'xp_earned', {
            action,
            xpAwarded: finalXP,
            baseXP: xpAmount,
            multiplier,
            totalXP: updated.totalXP,
            level: updated.level,
            title: updated.title,
        });

        logger.info(`[ClinicianXPService] Awarded ${finalXP} XP (base ${xpAmount} x${multiplier}) to user ${userId} for ${action}`);
        return { xpAwarded: finalXP, totalXP: updated.totalXP, level: updated.level, title: updated.title };
    }

    /**
     * Get the XP profile for a clinician.
     */
    static async getProfile(userId) {
        let profile = await prisma.clinicianXP.findUnique({ where: { userId } });

        if (!profile) {
            profile = await prisma.clinicianXP.create({
                data: { userId, totalXP: 0, level: 1, title: 'Intern' },
            });
        }

        const currentTier = this._getTier(profile.totalXP);
        const nextTier = this.LEVEL_TIERS.find(t => t.level === currentTier.level + 1) || null;

        const xpToNext = nextTier ? nextTier.minXP - profile.totalXP : 0;
        const progressPercent = nextTier
            ? Math.round(((profile.totalXP - currentTier.minXP) / (nextTier.minXP - currentTier.minXP)) * 100)
            : 100;

        return {
            totalXP: profile.totalXP,
            level: currentTier.level,
            title: currentTier.title,
            nextLevel: nextTier ? { level: nextTier.level, title: nextTier.title, minXP: nextTier.minXP } : null,
            xpToNext,
            progress: Math.min(progressPercent, 100),
        };
    }

    /**
     * Get paginated XP history from the ledger.
     */
    static async getXPHistory(userId, { page = 1, limit = 20 } = {}) {
        const skip = (page - 1) * limit;
        const [entries, total] = await Promise.all([
            prisma.xPLedger.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.xPLedger.count({ where: { userId } }),
        ]);

        return {
            transactions: entries,
            total,
        };
    }

    /**
     * Get the XP leaderboard, optionally filtered by branch.
     */
    static async getLeaderboard({ branchId, limit = 20 } = {}) {
        let whereClause = {};

        if (branchId) {
            // Get user IDs belonging to this branch
            const branchUsers = await prisma.user.findMany({
                where: { branchId, role: { in: ['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR'] }, deletedAt: null },
                select: { id: true },
            });
            whereClause = { userId: { in: branchUsers.map(u => u.id) } };
        }

        const entries = await prisma.clinicianXP.findMany({
            where: whereClause,
            orderBy: { totalXP: 'desc' },
            take: limit,
            include: {
                user: {
                    select: {
                        id: true, email: true, role: true,
                        doctor: { select: { fullName: true } },
                        therapist: { select: { fullName: true } },
                    },
                },
            },
        });

        return entries.map((e, idx) => ({
            rank: idx + 1,
            userId: e.userId,
            fullName: e.user.doctor?.fullName || e.user.therapist?.fullName || e.user.email,
            role: e.user.role,
            totalXP: e.totalXP,
            level: e.level,
            title: e.title,
        }));
    }

    /**
     * Recalculate level and title based on current totalXP.
     */
    static async recalculateLevel(userId) {
        const profile = await prisma.clinicianXP.findUnique({ where: { userId } });
        if (!profile) return null;

        const tier = this._getTier(profile.totalXP);

        if (profile.level !== tier.level || profile.title !== tier.title) {
            const updated = await prisma.clinicianXP.update({
                where: { userId },
                data: { level: tier.level, title: tier.title },
            });

            if (tier.level > profile.level) {
                emitToUser(userId, 'level_up', {
                    newLevel: tier.level,
                    title: tier.title,
                    totalXP: profile.totalXP,
                });
                logger.info(`[ClinicianXPService] User ${userId} leveled up to ${tier.level} (${tier.title})`);
            }

            return updated;
        }

        return profile;
    }

    /**
     * Get the tier for a given XP amount.
     */
    static _getTier(totalXP) {
        for (const tier of this.LEVEL_TIERS) {
            if (totalXP >= tier.minXP) return tier;
        }
        return this.LEVEL_TIERS[this.LEVEL_TIERS.length - 1];
    }
}
