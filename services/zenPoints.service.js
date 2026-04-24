import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { AntiGamingService } from './antiGaming.service.js';
import { StreakService } from './streak.service.js';
import { emitToUser } from '../websocket/index.js';

/**
 * ZenPointsService — patient-facing gamification with points, levels,
 * streaks, daily challenges, and social proof.
 *
 * Point awards (validated against DB records):
 *   Task completion:       +10 pts
 *   Vital logging:         +5  pts
 *   Appointment attendance:+25 pts
 *   7-day streak bonus:    +50 pts
 *   Milestone achieved:    +100 pts
 *   Daily challenge:       +15 pts
 *
 * Level system:
 *   0–99     Zen Seedling
 *   100–299  Wellness Sprout
 *   300–599  Harmony Seeker
 *   600–999  Balance Master
 *   1000+    Zen Sage
 */
export class ZenPointsService {
    static LEVELS = [
        { minPoints: 1000, name: 'Zen Sage', tier: 5 },
        { minPoints: 600, name: 'Balance Master', tier: 4 },
        { minPoints: 300, name: 'Harmony Seeker', tier: 3 },
        { minPoints: 100, name: 'Wellness Sprout', tier: 2 },
        { minPoints: 0, name: 'Zen Seedling', tier: 1 },
    ];

    /**
     * Get the level for a given point total.
     */
    static getLevel(points) {
        for (const level of this.LEVELS) {
            if (points >= level.minPoints) {
                const nextLevel = this.LEVELS.find(l => l.minPoints > level.minPoints && l.minPoints <= level.minPoints + 500);
                const nextUp = this.LEVELS[this.LEVELS.indexOf(level) - 1];
                return {
                    ...level,
                    nextLevel: nextUp?.name || null,
                    nextAt: nextUp?.minPoints || null,
                    progress: nextUp ? Math.min(((points - level.minPoints) / (nextUp.minPoints - level.minPoints)) * 100, 100) : 100
                };
            }
        }
        return { ...this.LEVELS[this.LEVELS.length - 1], nextLevel: 'Wellness Sprout', nextAt: 100, progress: 0 };
    }

    /**
     * Award points for an action (with rate-limit and DB validation).
     */
    static async awardPoints(patientId, action, sourceId = null) {
        // Rate-limit check
        const { allowed, points } = await AntiGamingService.canEarnPoints(patientId, action);
        if (!allowed) {
            logger.info(`[ZenPoints] Rate limited: ${patientId} for ${action}`);
            return null;
        }

        // Create ledger entry
        const entry = await prisma.zenPointsLedger.create({
            data: { patientId, action, points, sourceId }
        });

        // Update total on the Patient model
        await prisma.patient.update({
            where: { id: patientId },
            data: { zenPoints: { increment: points } }
        });

        // Update patient streak
        await StreakService.updatePatientStreak(patientId);

        // Check for streak bonus (on day 7, 14, 21, 28...)
        const streak = await prisma.patientStreak.findUnique({ where: { patientId } });
        if (streak && streak.currentStreak > 0 && streak.currentStreak % 7 === 0) {
            const bonusAllowed = await AntiGamingService.canEarnPoints(patientId, 'STREAK_BONUS');
            if (bonusAllowed.allowed) {
                const bonusSourceId = `streak_${streak.currentStreak}`;
                try {
                    await prisma.$transaction(async (tx) => {
                        const existing = await tx.zenPointsLedger.findFirst({
                            where: { patientId, action: 'STREAK_BONUS', sourceId: bonusSourceId },
                            select: { id: true },
                        });
                        if (existing) return;
                        await tx.zenPointsLedger.create({
                            data: { patientId, action: 'STREAK_BONUS', points: 50, sourceId: bonusSourceId }
                        });
                        await tx.patient.update({
                            where: { id: patientId },
                            data: { zenPoints: { increment: 50 } }
                        });
                    }, { isolationLevel: 'Serializable' });
                } catch (err) {
                    logger.warn('[ZenPoints] streak bonus race', { err: err.message });
                }
            }
        }

        // Get updated total and emit real-time event
        const patient = await prisma.patient.findUnique({
            where: { id: patientId },
            select: { zenPoints: true, userId: true }
        });

        if (patient) {
            const level = this.getLevel(patient.zenPoints);
            emitToUser(patient.userId, 'zen_points_update', {
                points: patient.zenPoints,
                earned: points,
                action,
                level,
                streak: streak?.currentStreak || 0
            });
        }

        // Mirror the new total into the patient's HealthAvatar so the
        // avatar level always tracks Zen progress. Best-effort — a sync
        // failure must not roll back the points award.
        try {
            const { HealthAvatarService } = await import('./healthAvatar.service.js');
            await HealthAvatarService.syncFromZenPoints(patientId);
        } catch (err) {
            logger.warn('[ZenPoints] Avatar sync failed', { err: err.message });
        }

        return { points, total: patient?.zenPoints || 0 };
    }

    /**
     * Get patient's full gamification profile.
     */
    static async getPatientProfile(patientId) {
        const [patient, streak, recentLedger] = await Promise.all([
            prisma.patient.findUnique({
                where: { id: patientId },
                select: { zenPoints: true, userId: true, fullName: true }
            }),
            prisma.patientStreak.findUnique({ where: { patientId } }),
            prisma.zenPointsLedger.findMany({
                where: { patientId },
                orderBy: { createdAt: 'desc' },
                take: 20
            })
        ]);

        if (!patient) return null;

        const level = this.getLevel(patient.zenPoints);

        return {
            patientId,
            zenPoints: patient.zenPoints,
            level,
            streak: {
                current: streak?.currentStreak || 0,
                longest: streak?.longestStreak || 0,
                lastActive: streak?.lastActiveDate
            },
            recentActivity: recentLedger.map(e => ({
                action: e.action,
                points: e.points,
                date: e.createdAt
            }))
        };
    }

    /**
     * Get or generate today's daily challenges for a patient.
     */
    static async getDailyChallenges(patientId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Check if challenges exist for today
        let challenges = await prisma.dailyChallenge.findMany({
            where: { activeDate: today }
        });

        // Auto-generate if none exist
        if (challenges.length === 0) {
            challenges = await this._generateDailyChallenges(today);
        }

        // Check which ones the patient has completed
        const completions = await prisma.patientChallengeCompletion.findMany({
            where: { patientId, challengeId: { in: challenges.map(c => c.id) } },
            select: { challengeId: true, completedAt: true }
        });
        const completedSet = new Map(completions.map(c => [c.challengeId, c.completedAt]));

        return challenges.map(c => ({
            id: c.id,
            title: c.title,
            description: c.description,
            type: c.type,
            pointReward: c.pointReward,
            completed: completedSet.has(c.id),
            completedAt: completedSet.get(c.id) || null
        }));
    }

    /**
     * Generate rotating daily challenges.
     */
    static async _generateDailyChallenges(date) {
        const dayOfWeek = date.getDay();
        const challengeTemplates = [
            // Rotating pool — 3 challenges per day
            [
                { title: 'Log All Vitals', description: 'Record your pain score, mood, and weight today', type: 'VITAL_LOG', pointReward: 15 },
                { title: 'Complete 2 Tasks', description: 'Finish at least 2 treatment tasks today', type: 'TASK_COMPLETE', pointReward: 20 },
                { title: 'Wellness Check-in', description: 'Submit your daily wellness check-in', type: 'CHECKIN', pointReward: 10 },
            ],
            [
                { title: 'Morning Vitals', description: 'Log your vitals before noon', type: 'VITAL_LOG', pointReward: 10 },
                { title: 'Exercise Session', description: 'Complete your prescribed exercise routine', type: 'EXERCISE', pointReward: 20 },
                { title: 'Medication Logger', description: 'Log all medications for today', type: 'TASK_COMPLETE', pointReward: 15 },
            ],
            [
                { title: 'Pain Tracker', description: 'Log your pain score 3 times today', type: 'VITAL_LOG', pointReward: 15 },
                { title: 'Diet Discipline', description: 'Follow and log your dietary plan', type: 'TASK_COMPLETE', pointReward: 15 },
                { title: 'Mood Journal', description: 'Record your mood and a short reflection', type: 'CHECKIN', pointReward: 10 },
            ],
            [
                { title: 'Stretch & Log', description: 'Complete a stretching session and log it', type: 'EXERCISE', pointReward: 15 },
                { title: 'Vital Trio', description: 'Log 3 different vital types today', type: 'VITAL_LOG', pointReward: 20 },
                { title: 'Task Crusher', description: 'Complete 3 treatment tasks', type: 'TASK_COMPLETE', pointReward: 25 },
            ],
            [
                { title: 'Sleep Check', description: 'Log your sleep hours for last night', type: 'VITAL_LOG', pointReward: 10 },
                { title: 'Mindful Moment', description: 'Complete a therapy or lifestyle task', type: 'TASK_COMPLETE', pointReward: 15 },
                { title: 'Weekly Reflection', description: 'Submit a wellness check-in with notes', type: 'CHECKIN', pointReward: 20 },
            ],
            [
                { title: 'Active Recovery', description: 'Complete your exercise and log vitals', type: 'EXERCISE', pointReward: 20 },
                { title: 'Medication Streak', description: 'Log all medications on time', type: 'TASK_COMPLETE', pointReward: 15 },
                { title: 'Full Check-in', description: 'Log vitals, mood, and complete a task', type: 'CHECKIN', pointReward: 25 },
            ],
            [
                { title: 'Rest Day Vitals', description: 'Even on rest day, log your vitals', type: 'VITAL_LOG', pointReward: 10 },
                { title: 'Week in Review', description: 'Check your weekly wellness progress', type: 'CHECKIN', pointReward: 15 },
                { title: 'Light Activity', description: 'Complete a light lifestyle task', type: 'TASK_COMPLETE', pointReward: 10 },
            ],
        ];

        const todayChallenges = challengeTemplates[dayOfWeek] || challengeTemplates[0];

        const created = await prisma.dailyChallenge.createManyAndReturn({
            data: todayChallenges.map(c => ({ ...c, activeDate: date }))
        });

        return created;
    }

    /**
     * Complete a daily challenge.
     */
    static async completeChallenge(patientId, challengeId) {
        const challenge = await prisma.dailyChallenge.findUnique({ where: { id: challengeId } });
        if (!challenge) throw new Error('Challenge not found');

        // Check if already completed
        const existing = await prisma.patientChallengeCompletion.findUnique({
            where: { patientId_challengeId: { patientId, challengeId } }
        });
        if (existing) return { alreadyCompleted: true };

        await prisma.patientChallengeCompletion.create({
            data: { patientId, challengeId }
        });

        // Award points
        const result = await this.awardPoints(patientId, 'CHALLENGE', challengeId);
        return { completed: true, pointsEarned: result?.points || 0 };
    }

    /**
     * Social proof: anonymized stats about peer activity.
     */
    static async getSocialProof(patientId) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Get patient's branch for peer comparison
        const patient = await prisma.patient.findUnique({
            where: { id: patientId },
            select: { branchId: true }
        });

        const branchFilter = patient?.branchId ? { branchId: patient.branchId } : {};

        const [totalPatients, activeToday, avgStreak, topLevel] = await Promise.all([
            // Total patients in the branch
            prisma.patient.count({ where: branchFilter }),

            // Patients who logged activity today
            prisma.zenPointsLedger.groupBy({
                by: ['patientId'],
                where: { createdAt: { gte: todayStart } },
                _count: true
            }).then(r => r.length),

            // Average streak length
            prisma.patientStreak.aggregate({
                _avg: { currentStreak: true },
                where: { currentStreak: { gt: 0 } }
            }),

            // Highest level distribution
            prisma.patient.aggregate({
                _avg: { zenPoints: true },
                _max: { zenPoints: true },
                where: { zenPoints: { gt: 0 } }
            })
        ]);

        const activePercent = totalPatients > 0
            ? Math.round((activeToday / totalPatients) * 100)
            : 0;

        return {
            peerActivityPercent: activePercent,
            activeToday,
            totalPatients,
            avgStreakDays: Math.round(avgStreak._avg?.currentStreak || 0),
            avgZenPoints: Math.round(topLevel._avg?.zenPoints || 0),
            message: activePercent > 50
                ? `${activePercent}% of patients like you have been active today!`
                : `Join the ${activeToday} patients who have already logged activity today!`
        };
    }
}
