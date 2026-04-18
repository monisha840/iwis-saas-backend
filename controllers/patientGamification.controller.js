/**
 * PatientGamificationController — HTTP layer for patient gamification features:
 * health quests, avatar, family leaderboard, referral tiers, wellness streaks,
 * and unlockable health content.
 */

import { HealthQuestService } from '../services/healthQuest.service.js';
import { HealthAvatarService } from '../services/healthAvatar.service.js';
import { FamilyLeaderboardService } from '../services/familyLeaderboard.service.js';
import { ReferralGamificationService } from '../services/referralGamification.service.js';
import { WellnessStreaksService } from '../services/wellnessStreaks.service.js';
import { HealthContentService } from '../services/healthContent.service.js';

export class PatientGamificationController {
    // ── Health Quests ────────────────────────────────────────────────────────

    static async getAvailableQuests(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const quests = await HealthQuestService.getAvailableQuests(patientId);
            res.json(quests);
        } catch (err) { next(err); }
    }

    static async startQuest(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const progress = await HealthQuestService.startQuest(patientId, req.params.questId);
            res.status(201).json(progress);
        } catch (err) { next(err); }
    }

    static async recordTaskProgress(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const taskIndex = parseInt(req.params.taskIndex, 10);
            if (isNaN(taskIndex)) return res.status(400).json({ error: 'Invalid task index' });

            const result = await HealthQuestService.recordTaskProgress(patientId, req.params.questId, taskIndex);
            res.json(result);
        } catch (err) { next(err); }
    }

    static async getMyQuests(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const { status } = req.query;
            const quests = await HealthQuestService.getMyQuests(patientId, { status });
            res.json(quests);
        } catch (err) { next(err); }
    }

    // ── Health Avatar ───────────────────────────────────────────────────────

    static async getAvatar(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const avatar = await HealthAvatarService.getOrCreateAvatar(patientId);
            res.json(avatar);
        } catch (err) { next(err); }
    }

    static async feedAvatar(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const { activityType } = req.body;
            if (!activityType) return res.status(400).json({ error: 'activityType is required' });

            const avatar = await HealthAvatarService.feedAvatar(patientId, activityType);
            res.json(avatar);
        } catch (err) { next(err); }
    }

    // ── Family Leaderboard ──────────────────────────────────────────────────

    static async createFamily(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const { name } = req.body;
            if (!name) return res.status(400).json({ error: 'Family name is required' });

            const family = await FamilyLeaderboardService.createFamily(patientId, name);
            res.status(201).json(family);
        } catch (err) { next(err); }
    }

    static async joinFamily(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const { inviteCode } = req.body;
            if (!inviteCode) return res.status(400).json({ error: 'Invite code is required' });

            const family = await FamilyLeaderboardService.joinFamily(patientId, inviteCode);
            res.json(family);
        } catch (err) { next(err); }
    }

    static async getMyFamilies(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const families = await FamilyLeaderboardService.getMyFamilies(patientId);
            res.json(families);
        } catch (err) { next(err); }
    }

    static async getFamilyLeaderboard(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const leaderboard = await FamilyLeaderboardService.getFamilyLeaderboard(req.params.familyId);
            res.json(leaderboard);
        } catch (err) { next(err); }
    }

    static async leaveFamily(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const result = await FamilyLeaderboardService.leaveFamily(patientId, req.params.familyId);
            res.json(result);
        } catch (err) { next(err); }
    }

    static async getGlobalFamilyRankings(req, res, next) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const limit = parseInt(req.query.limit, 10) || 20;

            const rankings = await FamilyLeaderboardService.getGlobalFamilyRankings({ page, limit });
            res.json(rankings);
        } catch (err) { next(err); }
    }

    // ── Referral Gamification ───────────────────────────────────────────────

    static async getReferralStats(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            // Check and award any new tiers first
            await ReferralGamificationService.checkAndAwardReferralTier(patientId);

            const stats = await ReferralGamificationService.getReferralStats(patientId);
            res.json(stats);
        } catch (err) { next(err); }
    }

    // ── Social Proof & Streaks ──────────────────────────────────────────────

    static async getEnhancedSocialProof(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const data = await WellnessStreaksService.getEnhancedSocialProof(patientId);
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getStreakMilestones(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const milestones = await WellnessStreaksService.getStreakMilestones(patientId);
            res.json(milestones);
        } catch (err) { next(err); }
    }

    // ── Health Content ──────────────────────────────────────────────────────

    static async getContentLibrary(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const content = await HealthContentService.getContentLibrary(patientId);
            res.json(content);
        } catch (err) { next(err); }
    }

    static async unlockContent(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const result = await HealthContentService.unlockContent(patientId, req.params.contentId);
            res.json(result);
        } catch (err) { next(err); }
    }

    static async getUnlockedContent(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const content = await HealthContentService.getUnlockedContent(patientId);
            res.json(content);
        } catch (err) { next(err); }
    }
}
