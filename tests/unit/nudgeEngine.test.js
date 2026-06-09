/**
 * F05 · Behavioural Nudge Engine — unit tests.
 *
 * Three concerns:
 *   1. profileClassifier (pure function — direct assertions)
 *   2. messageGenerator (must be wrapped against OpenAI — mock the SDK)
 *   3. wellness submitCheckIn NudgeLog feedback loop (mock prisma)
 *
 * No real OpenAI / Prisma / Redis traffic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNudgeProfile } from '../helpers/mockData.js';

// Silence logger across the file.
vi.mock('../../lib/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── profileClassifier — pure function ─────────────────────────────────────
const { classifyPatient } = await import('../../services/nudge/profileClassifier.js');

describe('profileClassifier · classifyPatient', () => {
    it('returns STREAK_MOTIVATED when streakDays >= 5 AND checkInRate >= 0.7', () => {
        const out = classifyPatient(mockNudgeProfile({ streakDays: 10, checkInRate: 0.85 }));
        expect(out.archetype).toBe('STREAK_MOTIVATED');
        expect(out.confidence).toBeGreaterThan(0);
        expect(out.confidence).toBeLessThanOrEqual(1);
    });

    it('returns PROGRESS_MOTIVATED when painTrend < -0.5', () => {
        const out = classifyPatient(mockNudgeProfile({ painTrend: -1.2 }));
        expect(out.archetype).toBe('PROGRESS_MOTIVATED');
    });

    it('returns PROGRESS_MOTIVATED when sleepTrend > 0.3', () => {
        const out = classifyPatient(mockNudgeProfile({ sleepTrend: 1.0 }));
        expect(out.archetype).toBe('PROGRESS_MOTIVATED');
    });

    it('returns SOCIAL_MOTIVATED when checkInRate < 0.4 AND streakDays < 3', () => {
        const out = classifyPatient(mockNudgeProfile({ checkInRate: 0.2, streakDays: 0 }));
        expect(out.archetype).toBe('SOCIAL_MOTIVATED');
    });

    it('returns LOSS_AVERSE as default fallback', () => {
        // Middling profile that matches none of the three categorical rules.
        const out = classifyPatient(mockNudgeProfile({
            streakDays: 4, checkInRate: 0.5, painTrend: 0, sleepTrend: 0,
        }));
        expect(out.archetype).toBe('LOSS_AVERSE');
    });

    it('returns confidence in [0,1] for every archetype', () => {
        const inputs = [
            mockNudgeProfile({ streakDays: 100, checkInRate: 1.0 }),  // strongest STREAK
            mockNudgeProfile({ painTrend: -5 }),                       // strong PROGRESS
            mockNudgeProfile({ checkInRate: 0, streakDays: 0 }),       // strongest SOCIAL
            mockNudgeProfile(),                                         // LOSS_AVERSE
        ];
        for (const inp of inputs) {
            const out = classifyPatient(inp);
            expect(out.confidence).toBeGreaterThanOrEqual(0);
            expect(out.confidence).toBeLessThanOrEqual(1);
        }
    });

    it('never throws on null input', () => {
        expect(() => classifyPatient(null)).not.toThrow();
        expect(() => classifyPatient(undefined)).not.toThrow();
        expect(() => classifyPatient({})).not.toThrow();
    });

    it('never throws on missing fields', () => {
        // Selectively missing fields — must default to 0/safe and land in LOSS_AVERSE.
        const out = classifyPatient({ prakriti: 'VATA' });
        expect(out).toBeDefined();
        expect(['STREAK_MOTIVATED','PROGRESS_MOTIVATED','SOCIAL_MOTIVATED','LOSS_AVERSE'])
            .toContain(out.archetype);
    });
});

// ── messageGenerator — OpenAI SDK mock + static fallback ──────────────────
// Hoist mocks BEFORE importing the module under test.
const openaiCreate = vi.fn();
// Plain constructor function — `vi.fn().mockImplementation(()=>obj)` does
// not reliably feed its returned object through `new` in Vitest 4. A regular
// function returning an object IS used as the instance when called with new.
vi.mock('openai', () => ({
    default: function OpenAIMock() {
        return { chat: { completions: { create: openaiCreate } } };
    },
}));
vi.mock('../../data/ayurvedicTips.js', () => ({
    AYURVEDIC_TIPS: {
        VATA:     { HEMANTA: ['static vata tip'], SHISHIRA: ['static vata tip'] },
        PITTA:    { HEMANTA: ['static pitta tip'] },
        KAPHA:    { HEMANTA: ['static kapha tip'] },
        GENERAL:  ['general fallback tip'],
    },
    getCurrentSeason: () => 'HEMANTA',
    getDayOfYear: () => 1,
}));

// Ensure OPENAI_API_KEY is set BEFORE the module is first imported AND for
// the entire test run — the messageGenerator caches its client lazily, and
// env-var restoration at file-tail evaluates before any test body runs.
process.env.OPENAI_API_KEY = 'sk-test-key';

const { generateNudgeMessage, getStaticFallback } = await import('../../services/nudge/messageGenerator.js');

describe('messageGenerator · generateNudgeMessage', () => {
    beforeEach(() => {
        openaiCreate.mockReset();
    });

    it('returns the LLM message on success', async () => {
        openaiCreate.mockResolvedValueOnce({
            choices: [{ message: { content: 'Your 7-day streak is fire. Log today to keep it going.' } }],
        });
        const out = await generateNudgeMessage({
            prakriti: 'VATA', archetype: 'STREAK_MOTIVATED',
            streakDays: 7, checkInRate: 0.9, painTrend: 0, lastCheckInDaysAgo: 0,
        });
        expect(typeof out).toBe('string');
        expect(out).toMatch(/streak/i);
    });

    it('returns the static fallback string when OpenAI throws', async () => {
        openaiCreate.mockRejectedValueOnce(new Error('rate limited'));
        const out = await generateNudgeMessage({ prakriti: 'VATA', archetype: 'LOSS_AVERSE' });
        expect(typeof out).toBe('string');
        // Falls back to AYURVEDIC_TIPS[VATA][HEMANTA] which we mocked above.
        expect(out).toBe('static vata tip');
    });

    it('returns the static fallback when OpenAI returns empty content', async () => {
        openaiCreate.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });
        const out = await generateNudgeMessage({ prakriti: 'PITTA', archetype: 'LOSS_AVERSE' });
        expect(out).toBe('static pitta tip');
    });

    it('never throws under any condition', async () => {
        openaiCreate.mockRejectedValueOnce(new Error('boom'));
        await expect(generateNudgeMessage({})).resolves.toBeTypeOf('string');
        openaiCreate.mockRejectedValueOnce(new Error('boom 2'));
        await expect(generateNudgeMessage(null)).resolves.toBeTypeOf('string');
    });

    it('returned LLM message is plain text — no markdown fences', async () => {
        openaiCreate.mockResolvedValueOnce({
            choices: [{ message: { content: 'Plain text reply for the patient.' } }],
        });
        const out = await generateNudgeMessage({ prakriti: 'KAPHA', archetype: 'SOCIAL_MOTIVATED' });
        expect(out).not.toMatch(/^```/);
        expect(out).not.toMatch(/^#+\s/m); // no markdown headings
    });

    it('getStaticFallback returns a string for any prakriti', () => {
        expect(getStaticFallback('VATA')).toBe('static vata tip');
        expect(getStaticFallback('KAPHA')).toBe('static kapha tip');
        expect(getStaticFallback(null)).toBe('general fallback tip');
        expect(getStaticFallback('UNKNOWN_X')).toBe('general fallback tip');
    });
});

// ── wellness submitCheckIn NudgeLog feedback ──────────────────────────────
const prismaMock = {
    patient: { findUnique: vi.fn() },
    dailyCheckIn: { findFirst: vi.fn(), create: vi.fn() },
    patient_update: vi.fn(), // placeholder; real call patched below via $transaction
    nudgeLog: { updateMany: vi.fn() },
    $transaction: vi.fn(),
};
vi.mock('../../lib/prisma.js', () => ({ default: prismaMock }));

const { WellnessService } = await import('../../services/wellness.service.js');

describe('wellness.submitCheckIn · NudgeLog feedback', () => {
    beforeEach(() => {
        for (const v of Object.values(prismaMock)) {
            if (typeof v === 'object' && v) for (const fn of Object.values(v)) fn.mockReset?.();
            else if (typeof v === 'function') v.mockReset?.();
        }
        prismaMock.patient.findUnique.mockResolvedValue({ id: 'pt-1', userId: 'u-1' });
        prismaMock.dailyCheckIn.findFirst.mockResolvedValue(null);
        prismaMock.$transaction.mockImplementation(async (cb) => {
            // Simulate the tx callback succeeding.
            return cb({
                dailyCheckIn: { create: vi.fn().mockResolvedValue({ id: 'ci-1' }) },
                patient: { update: vi.fn().mockResolvedValue({}) },
            });
        });
    });

    it('flips checkInCompleted on NudgeLog rows for this patient within the last 7 days', async () => {
        prismaMock.nudgeLog.updateMany.mockResolvedValue({ count: 1 });
        await WellnessService.submitCheckIn('u-1', { painLevel: 4, sleepHours: 7, mood: 'NEUTRAL' });
        expect(prismaMock.nudgeLog.updateMany).toHaveBeenCalledTimes(1);
        const call = prismaMock.nudgeLog.updateMany.mock.calls[0][0];
        expect(call.where.patientId).toBe('pt-1');
        expect(call.where.checkInCompleted).toBe(false);
        expect(call.data.checkInCompleted).toBe(true);
        expect(call.data.checkInAt).toBeInstanceOf(Date);
        // 7-day window — `sentAt: { gte: <date> }` must be set.
        expect(call.where.sentAt?.gte).toBeInstanceOf(Date);
    });

    it('check-in still succeeds when nudgeLog.updateMany throws', async () => {
        prismaMock.nudgeLog.updateMany.mockRejectedValue(new Error('db down'));
        await expect(
            WellnessService.submitCheckIn('u-1', { painLevel: 4, sleepHours: 7, mood: 'NEUTRAL' }),
        ).resolves.toBeDefined();
    });
});
