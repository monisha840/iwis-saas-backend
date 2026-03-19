/**
 * LeaderboardController — HTTP layer for gamification leaderboard.
 */

import { LeaderboardService } from '../services/leaderboard.service.js';

export class LeaderboardController {
  static async getLeaderboard(req, res, next) {
    try {
      const data = await LeaderboardService.getLeaderboard(req.query);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }

  static async getMyStats(req, res, next) {
    try {
      const stats = await LeaderboardService.getParticipantStats(req.user);
      if (!stats) return res.status(404).json({ error: 'Stats not available for this role' });
      res.json(stats);
    } catch (err) {
      next(err);
    }
  }

  static async getConfig(req, res, next) {
    try {
      const config = await LeaderboardService.getConfig();
      res.json(config);
    } catch (err) {
      next(err);
    }
  }

  static async updateConfig(req, res, next) {
    try {
      const config = await LeaderboardService.updateConfig(req.body, req.user);
      res.json(config);
    } catch (err) {
      next(err);
    }
  }

  static async triggerRecalculation(req, res, next) {
    try {
      const result = await LeaderboardService.recalculateAll();
      res.json({ message: 'Leaderboard recalculation complete', ...result });
    } catch (err) {
      next(err);
    }
  }
}
