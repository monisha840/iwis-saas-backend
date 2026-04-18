import { describe, it, expect, vi } from 'vitest';

// Mock config to avoid env dependency
vi.mock('../../config/index.js', () => ({
    default: {
        rateLimit: {
            windowMs: 15 * 60 * 1000,
            max: 2000,
        }
    }
}));

describe('Rate Limiter Configuration', () => {
    it('should export all required limiters', async () => {
        const limiters = await import('../../middleware/rateLimiter.js');

        expect(limiters.globalLimiter).toBeDefined();
        expect(limiters.loginLimiter).toBeDefined();
        expect(limiters.refreshLimiter).toBeDefined();
        expect(limiters.passwordResetLimiter).toBeDefined();
        expect(limiters.verificationLimiter).toBeDefined();
        expect(limiters.mfaLimiter).toBeDefined();
    });

    it('all limiters should be functions (Express middleware)', async () => {
        const limiters = await import('../../middleware/rateLimiter.js');

        expect(typeof limiters.globalLimiter).toBe('function');
        expect(typeof limiters.loginLimiter).toBe('function');
        expect(typeof limiters.refreshLimiter).toBe('function');
        expect(typeof limiters.passwordResetLimiter).toBe('function');
        expect(typeof limiters.verificationLimiter).toBe('function');
        expect(typeof limiters.mfaLimiter).toBe('function');
    });
});
