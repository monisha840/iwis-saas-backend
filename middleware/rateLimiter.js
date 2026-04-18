import rateLimit from 'express-rate-limit';
import config from '../config/index.js';

const isProd = process.env.NODE_ENV === 'production';

// Global API rate limiter
export const globalLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
});

// Auth login - strict per-IP
export const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isProd ? 5 : 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
    keyGenerator: (req) => req.ip,
});

// Token refresh - generous (called automatically every 15min per tab)
export const refreshLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: isProd ? 60 : 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many refresh attempts' },
});

// Password reset / forgot password - strict per-IP
export const passwordResetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: isProd ? 3 : 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many password reset attempts. Please try again later.' },
    keyGenerator: (req) => req.ip,
});

// Email verification resend - per-IP
export const verificationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: isProd ? 3 : 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Verification email limit reached. Please try again later.' },
});

// MFA validation - strict (brute force protection)
export const mfaLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isProd ? 5 : 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many MFA attempts. Please try again in 15 minutes.' },
});
