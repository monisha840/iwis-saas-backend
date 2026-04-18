import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import logger from '../lib/logger.js';
import { AuthService } from '../services/auth.service.js';

export function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });

  jwt.verify(token, config.jwt.secret, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });

    // JTI blacklist check (best-effort — if Redis is down, allow through)
    if (user.jti) {
      try {
        const blacklisted = await AuthService.isJtiBlacklisted(user.jti);
        if (blacklisted) {
          return res.status(401).json({ error: 'Token has been revoked' });
        }
      } catch {
        // Redis unavailable — allow through
      }
    }

    // IP binding: warn if token IP differs from request IP (do not block)
    const requestIp = req.ip || req.connection?.remoteAddress;
    if (user.ip && user.ip !== requestIp) {
      logger.warn('Token IP mismatch', {
        userId: user.id,
        tokenIp: user.ip,
        requestIp,
        requestId: req.id
      });
    }

    req.user = user;
    next();
  });
}

export function roleMiddleware(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

export const authenticateToken = authMiddleware;
export const authorizeRoles = roleMiddleware;
