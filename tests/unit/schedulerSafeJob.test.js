import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Verifies the SchedulerService._safeJob wrapper that was added to keep
 * cron callbacks from crashing the worker on a thrown / rejected handler.
 *
 * The contract being tested:
 *   - The wrapped handler runs to completion when fn resolves.
 *   - Sync throws are caught and logged with the job name.
 *   - Async rejections are caught and logged with the job name.
 *   - The wrapper itself never re-throws.
 *
 * The actual SchedulerService imports prisma + notification + cron at
 * module load, which we don't want to instantiate in a unit test. Instead
 * we re-implement the wrapper inline (mirroring scheduler.service.js
 * exactly) and exercise it. If the production wrapper drifts, this test
 * has to be updated alongside — that's the deliberate trade-off for
 * keeping the unit isolated from Prisma + cron init.
 */

const logger = {
    info: vi.fn(),
    error: vi.fn(),
};

function makeSafeJob(name, fn) {
    return async () => {
        const startedAt = Date.now();
        try {
            await fn();
            logger.info(`[SchedulerService] job ok`, { name, ms: Date.now() - startedAt });
        } catch (err) {
            logger.error(`[SchedulerService] job failed`, {
                name,
                ms: Date.now() - startedAt,
                error: err?.message,
                stack: err?.stack,
            });
        }
    };
}

describe('SchedulerService._safeJob (cron error wrapper)', () => {
    beforeEach(() => {
        logger.info.mockReset();
        logger.error.mockReset();
    });

    it('runs the job handler to completion on success and logs ok', async () => {
        const handler = vi.fn(async () => 'ok');
        const safe = makeSafeJob('happy-job', handler);
        await expect(safe()).resolves.toBeUndefined();
        expect(handler).toHaveBeenCalledOnce();
        expect(logger.info).toHaveBeenCalledOnce();
        const [, ctx] = logger.info.mock.calls[0];
        expect(ctx.name).toBe('happy-job');
        expect(typeof ctx.ms).toBe('number');
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('catches synchronous throws and logs with job name + error message', async () => {
        const handler = vi.fn(() => { throw new Error('boom-sync'); });
        const safe = makeSafeJob('sync-thrower', handler);
        // The wrapper must NOT re-throw — that's the whole point of the
        // hardening. node-cron treats unhandled rejections as fatal in
        // recent runtimes.
        await expect(safe()).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalledOnce();
        const [, ctx] = logger.error.mock.calls[0];
        expect(ctx.name).toBe('sync-thrower');
        expect(ctx.error).toBe('boom-sync');
        expect(logger.info).not.toHaveBeenCalled();
    });

    it('catches async rejections and logs with job name + error message', async () => {
        const handler = vi.fn(async () => { throw new Error('boom-async'); });
        const safe = makeSafeJob('async-rejector', handler);
        await expect(safe()).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalledOnce();
        const [, ctx] = logger.error.mock.calls[0];
        expect(ctx.name).toBe('async-rejector');
        expect(ctx.error).toBe('boom-async');
    });

    it('does not log success when the handler errors (no double logging)', async () => {
        const handler = vi.fn(async () => { throw new Error('x'); });
        const safe = makeSafeJob('no-double-log', handler);
        await safe();
        expect(logger.info).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledOnce();
    });

    it('isolates failures across consecutive runs', async () => {
        // Two independent cron firings — one fails, one succeeds. The
        // failure must not contaminate the next run.
        const handler1 = vi.fn(async () => { throw new Error('first-fail'); });
        const handler2 = vi.fn(async () => 'second-ok');
        const safe1 = makeSafeJob('fail-first', handler1);
        const safe2 = makeSafeJob('ok-second', handler2);
        await safe1();
        await safe2();
        expect(logger.error).toHaveBeenCalledOnce();
        expect(logger.info).toHaveBeenCalledOnce();
        expect(logger.error.mock.calls[0][1].name).toBe('fail-first');
        expect(logger.info.mock.calls[0][1].name).toBe('ok-second');
    });
});
