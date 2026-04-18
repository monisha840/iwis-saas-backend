import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ZenPointsService } from './zenPoints.service.js';

/**
 * WellnessStreaksService — enhanced social proof and streak milestones.
 *
 * Wraps ZenPointsService.getSocialProof() with percentile ranking
 * and motivational messaging. Also provides upcoming streak milestones.
 */
export class WellnessStreaksService {
    static MILESTONES = [
        { days: 7, name: '1 Week Warrior', reward: 50 },
        { days: 14, name: '2 Week Champion', reward: 100 },
        { days: 30, name: 'Monthly Master', reward: 200 },
        { days: 60, name: '60-Day Legend', reward: 350 },
        { days: 90, name: '90-Day Titan', reward: 500 }
    ];

    /**
     * Get enhanced social proof — existing social proof + percentile + motivational message.
     */
    static async getEnhancedSocialProof(patientId) {
        // Get base social proof from ZenPointsService
        const baseSocialProof = await ZenPointsService.getSocialProof(patientId);

        // Get patient's streak
        const myStreak = await prisma.patientStreak.findUnique({
            where: { patientId }
        });

        const currentStreak = myStreak?.currentStreak || 0;

        // Calculate percentile rank
        const [totalWithStreaks, patientsBelow] = await Promise.all([
            prisma.patientStreak.count({ where: { currentStreak: { gt: 0 } } }),
            prisma.patientStreak.count({ where: { currentStreak: { lt: currentStreak }, currentStreak: { gt: 0 } } })
        ]);

        // Use a raw approach since Prisma AND conditions on same field need special handling
        const allStreaks = await prisma.patientStreak.findMany({
            where: { currentStreak: { gt: 0 } },
            select: { currentStreak: true }
        });

        const belowCount = allStreaks.filter(s => s.currentStreak < currentStreak).length;
        const totalCount = allStreaks.length;
        const percentileRank = totalCount > 0
            ? Math.round((belowCount / totalCount) * 100)
            : 0;

        // Generate motivational message
        const motivationalMessage = this._generateMotivationalMessage(
            currentStreak,
            percentileRank,
            totalCount
        );

        return {
            ...baseSocialProof,
            currentStreak,
            longestStreak: myStreak?.longestStreak || 0,
            percentileRank,
            motivationalMessage
        };
    }

    /**
     * Get upcoming streak milestones with rewards.
     */
    static async getStreakMilestones(patientId) {
        const streak = await prisma.patientStreak.findUnique({
            where: { patientId }
        });

        const currentStreak = streak?.currentStreak || 0;

        return this.MILESTONES.map(m => ({
            ...m,
            achieved: currentStreak >= m.days,
            daysRemaining: Math.max(0, m.days - currentStreak),
            progress: Math.min(100, Math.round((currentStreak / m.days) * 100))
        }));
    }

    /**
     * Generate a dynamic motivational message based on streak and percentile.
     */
    static _generateMotivationalMessage(currentStreak, percentileRank, totalWithStreaks) {
        if (currentStreak === 0) {
            return 'Start your wellness streak today! Log an activity to begin.';
        }

        if (percentileRank >= 95) {
            return `Incredible! You're in the top ${100 - percentileRank}% of patients! Your ${currentStreak}-day streak is truly elite.`;
        }

        if (percentileRank >= 80) {
            return `You're in the top ${100 - percentileRank}% of patients! Only ${100 - percentileRank}% maintain a ${currentStreak}+ day streak.`;
        }

        if (percentileRank >= 50) {
            return `Great progress! Your ${currentStreak}-day streak puts you ahead of ${percentileRank}% of patients. Keep going!`;
        }

        if (currentStreak >= 3) {
            return `You're building momentum with a ${currentStreak}-day streak! Keep it up to climb the rankings.`;
        }

        return `You've started your streak at ${currentStreak} day${currentStreak > 1 ? 's' : ''}! Consistency is key — log activities daily to keep growing.`;
    }
}
