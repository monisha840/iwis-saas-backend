/**
 * GamificationController — HTTP layer for badges, streaks, competitions,
 * zen points, challenges, analytics, and anti-gaming admin actions.
 */

import { BadgeService } from '../services/badge.service.js';
import { StreakService } from '../services/streak.service.js';
import { BranchCompetitionService } from '../services/branchCompetition.service.js';
import { ZenPointsService } from '../services/zenPoints.service.js';
import { AntiGamingService } from '../services/antiGaming.service.js';
import { GamificationAnalyticsService } from '../services/gamificationAnalytics.service.js';
import { AdaptiveTargetsService } from '../services/adaptiveTargets.service.js';

export class GamificationController {
    // ── Badges ────────────────────────────────────────────────────────────────

    static async getMyBadges(req, res, next) {
        try {
            const badges = await BadgeService.getUserBadges(req.user.id);
            res.json(badges);
        } catch (err) { next(err); }
    }

    static async getAllBadges(req, res, next) {
        try {
            const badges = await BadgeService.getAllBadgesWithStatus(req.user.id);
            res.json(badges);
        } catch (err) { next(err); }
    }

    // ── Streaks ───────────────────────────────────────────────────────────────

    static async getMyStreak(req, res, next) {
        try {
            const profileId = req.user.profileId; // Set by middleware
            if (!profileId) return res.status(400).json({ error: 'No clinician profile found' });

            const streak = await StreakService.updateClinicianStreak(profileId, req.user.role);
            res.json(streak);
        } catch (err) { next(err); }
    }

    // ── Branch Competitions ──────────────────────────────────────────────────

    static async getBranchLeaderboard(req, res, next) {
        try {
            const data = await BranchCompetitionService.getBranchLeaderboard();
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getActiveCompetitions(req, res, next) {
        try {
            const data = await BranchCompetitionService.getActiveCompetitions();
            res.json(data);
        } catch (err) { next(err); }
    }

    static async createCompetition(req, res, next) {
        try {
            const { title, description, metric, startDate, endDate } = req.body;
            const competition = await BranchCompetitionService.createCompetition({
                title, description, metric, startDate, endDate,
                createdById: req.user.id
            });
            res.status(201).json(competition);
        } catch (err) { next(err); }
    }

    static async getCompetitionHistory(req, res, next) {
        try {
            const data = await BranchCompetitionService.getCompetitionHistory();
            res.json(data);
        } catch (err) { next(err); }
    }

    // ── Zen Points (Patient) ─────────────────────────────────────────────────

    static async getZenProfile(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const profile = await ZenPointsService.getPatientProfile(patientId);
            if (!profile) return res.status(404).json({ error: 'Patient not found' });
            res.json(profile);
        } catch (err) { next(err); }
    }

    static async getDailyChallenges(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const challenges = await ZenPointsService.getDailyChallenges(patientId);
            res.json(challenges);
        } catch (err) { next(err); }
    }

    static async completeChallenge(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const result = await ZenPointsService.completeChallenge(patientId, req.params.challengeId);
            res.json(result);
        } catch (err) { next(err); }
    }

    static async getSocialProof(req, res, next) {
        try {
            const patientId = req.user.patientId;
            if (!patientId) return res.status(400).json({ error: 'No patient profile found' });

            const data = await ZenPointsService.getSocialProof(patientId);
            res.json(data);
        } catch (err) { next(err); }
    }

    // ── Anti-Gaming (Admin) ──────────────────────────────────────────────────

    static async getAnomalies(req, res, next) {
        try {
            const { limit = 50, offset = 0 } = req.query;
            const data = await AntiGamingService.getUnresolvedAnomalies({
                limit: parseInt(limit), offset: parseInt(offset)
            });
            res.json(data);
        } catch (err) { next(err); }
    }

    static async resolveAnomaly(req, res, next) {
        try {
            const anomaly = await AntiGamingService.resolveAnomaly(req.params.id, req.user.id);
            res.json(anomaly);
        } catch (err) { next(err); }
    }

    // ── Analytics (Admin) ────────────────────────────────────────────────────

    static async getAnalyticsOverview(req, res, next) {
        try {
            const [engagement, scoreTrend, badgeDistribution, patientStats] = await Promise.all([
                GamificationAnalyticsService.getEngagementOverview(),
                GamificationAnalyticsService.getScoreTrend(),
                GamificationAnalyticsService.getBadgeDistribution(),
                GamificationAnalyticsService.getPatientGamificationStats()
            ]);
            res.json({ engagement, scoreTrend, badgeDistribution, patientStats });
        } catch (err) { next(err); }
    }

    static async getOutcomeCorrelation(req, res, next) {
        try {
            const data = await GamificationAnalyticsService.getOutcomeCorrelation();
            res.json(data);
        } catch (err) { next(err); }
    }

    static async getConfigImpact(req, res, next) {
        try {
            const data = await GamificationAnalyticsService.getConfigImpact();
            res.json(data);
        } catch (err) { next(err); }
    }

    // ── Adaptive Targets ─────────────────────────────────────────────────────

    static async getMyTargets(req, res, next) {
        try {
            const profileId = req.user.profileId;
            if (!profileId) return res.status(400).json({ error: 'No clinician profile found' });

            const targets = await AdaptiveTargetsService.getTargets(profileId, req.user.role);
            res.json(targets);
        } catch (err) { next(err); }
    }
}
