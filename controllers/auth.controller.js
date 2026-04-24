/**
 * AuthController — HTTP layer for authentication endpoints.
 */

import { AuthService } from '../services/auth.service.js';

export class AuthController {
  static async login(req, res, next) {
    try {
      const result = await AuthService.login(req.body, {
        ip: req.ip,
        userAgent: req.headers['user-agent']
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async register(req, res, next) {
    try {
      const result = await AuthService.register(req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async refresh(req, res, next) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
      const result = await AuthService.refresh(refreshToken, {
        ip: req.ip,
        userAgent: req.headers['user-agent']
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async logout(req, res, next) {
    try {
      const authHeader = req.headers['authorization'];
      const accessToken = authHeader && authHeader.split(' ')[1];
      await AuthService.logout(req.body.refreshToken, accessToken);
      res.json({ message: 'Logged out successfully' });
    } catch (err) {
      next(err);
    }
  }

}
