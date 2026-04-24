/**
 * ClinicianGamificationController — HTTP layer for clinician XP, seasonal
 * challenges, reward store, mentor sessions, and achievement showcase.
 */

import { ClinicianXPService } from '../services/clinicianXP.service.js';
import { SeasonalChallengeService } from '../services/seasonalChallenge.service.js';
import { RewardStoreService } from '../services/rewardStore.service.js';
import { MentorSessionService } from '../services/mentorSession.service.js';
import { BadgeService } from '../services/badge.service.js';
import prisma from '../lib/prisma.js';

export class ClinicianGamificationController {
    // ── XP & Level ───────────────────────────────────────────────────────────

    static async getXPProfile(req, res, next) {
        try {
            const profile = await ClinicianXPService.getProfile(req.user.id);
            res.json(profile);
        } catch (err) { next(err); }
    }

    static async getXPHistory(req, res, next) {
        try {
            const { page = 1, limit = 20 } = req.query;
            const history = await ClinicianXPService.getXPHistory(req.user.id, {
                page: parseInt(page),
                limit: parseInt(limit),
            });
            res.json(history);
        } catch (err) { next(err); }
    }

    static async getXPLeaderboard(req, res, next) {
        try {
            const { branchId, limit = 20 } = req.query;
            const leaderboard = await ClinicianXPService.getLeaderboard({
                branchId: branchId || req.user.branchId,
                limit: parseInt(limit),
            });
            res.json(leaderboard);
        } catch (err) { next(err); }
    }

    // ── Seasonal Challenges ──────────────────────────────────────────────────

    static async createSeasonalChallenge(req, res, next) {
        try {
            const challenge = await SeasonalChallengeService.createChallenge(req.body);
            res.status(201).json(challenge);
        } catch (err) { next(err); }
    }

    static async getActiveChallenges(req, res, next) {
        try {
            const challenges = await SeasonalChallengeService.getActiveChallenges(
                req.user.id,
                req.user.role
            );
            res.json(challenges);
        } catch (err) { next(err); }
    }

    static async getChallengeHistory(req, res, next) {
        try {
            const { page = 1, limit = 20 } = req.query;
            const history = await SeasonalChallengeService.getChallengeHistory({
                page: parseInt(page),
                limit: parseInt(limit),
            });
            res.json(history);
        } catch (err) { next(err); }
    }

    // ── Reward Store ─────────────────────────────────────────────────────────

    static async getAvailableRewards(req, res, next) {
        try {
            const rewards = await RewardStoreService.getAvailableRewards();
            res.json(rewards);
        } catch (err) { next(err); }
    }

    static async redeemReward(req, res, next) {
        try {
            const redemption = await RewardStoreService.redeemReward(req.user.id, req.params.rewardId);
            res.status(201).json(redemption);
        } catch (err) { next(err); }
    }

    static async getMyRedemptions(req, res, next) {
        try {
            const { page = 1, limit = 20 } = req.query;
            const result = await RewardStoreService.getUserRedemptions(req.user.id, {
                page: parseInt(page),
                limit: parseInt(limit),
            });
            res.json(result);
        } catch (err) { next(err); }
    }

    static async createReward(req, res, next) {
        try {
            const reward = await RewardStoreService.createReward(req.body);
            res.status(201).json(reward);
        } catch (err) { next(err); }
    }

    static async processRedemption(req, res, next) {
        try {
            const { status } = req.body;
            if (!['APPROVED', 'FULFILLED', 'REJECTED'].includes(status)) {
                return res.status(400).json({ error: 'Invalid status. Must be APPROVED, FULFILLED, or REJECTED' });
            }
            const result = await RewardStoreService.processRedemption(req.params.id, status, req.user.id);
            res.json(result);
        } catch (err) { next(err); }
    }

    // ── Mentor Sessions ──────────────────────────────────────────────────────

    static async createMentorSession(req, res, next) {
        try {
            const { menteeId, topic, date, durationMins } = req.body;
            const session = await MentorSessionService.createSession(
                req.user.id,
                menteeId,
                topic,
                date,
                durationMins
            );
            res.status(201).json(session);
        } catch (err) { next(err); }
    }

    static async getMySessions(req, res, next) {
        try {
            const { role } = req.query; // 'mentor', 'mentee', or omit for both
            const sessions = await MentorSessionService.getMySessions(req.user.id, role);
            res.json(sessions);
        } catch (err) { next(err); }
    }

    static async completeSession(req, res, next) {
        try {
            const session = await MentorSessionService.completeSession(req.params.id);
            res.json(session);
        } catch (err) { next(err); }
    }

    static async cancelSession(req, res, next) {
        try {
            const session = await MentorSessionService.cancelSession(req.params.id);
            res.json(session);
        } catch (err) { next(err); }
    }

    static async getMentorStats(req, res, next) {
        try {
            const stats = await MentorSessionService.getMentorStats(req.user.id);
            res.json(stats);
        } catch (err) { next(err); }
    }

    // ── Achievement Showcase (Feature 17) ────────────────────────────────────

    static async getShowcase(req, res, next) {
        try {
            const { userId } = req.params;

            const [xpProfile, badges, streak] = await Promise.all([
                ClinicianXPService.getProfile(userId),
                BadgeService.getUserBadges(userId),
                (async () => {
                    // Find clinician profile to get streak
                    const doctor = await prisma.doctor.findUnique({ where: { userId }, select: { id: true } });
                    const therapist = !doctor
                        ? await prisma.therapist.findUnique({ where: { userId }, select: { id: true } })
                        : null;
                    const profileId = doctor?.id || therapist?.id;
                    if (!profileId) return null;
                    return prisma.clinicianStreak.findUnique({ where: { participantId: profileId } });
                })(),
            ]);

            // Top achievements: highest tier badges
            const tierOrder = { PLATINUM: 4, GOLD: 3, SILVER: 2, BRONZE: 1 };
            const topAchievements = [...badges]
                .sort((a, b) => (tierOrder[b.tier] || 0) - (tierOrder[a.tier] || 0))
                .slice(0, 5);

            res.json({
                badges,
                level: xpProfile.level,
                title: xpProfile.title,
                totalXP: xpProfile.totalXP,
                streaks: streak
                    ? {
                        currentStreak: streak.currentStreak,
                        longestStreak: streak.longestStreak,
                        multiplier: streak.streakMultiplier,
                    }
                    : null,
                topAchievements,
            });
        } catch (err) { next(err); }
    }
}
