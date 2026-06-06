/**
 * F07 · Multi-Agent Orchestration — in-process event registry.
 *
 * Tiny pub/sub. Agents register handler functions against named events
 * (e.g. 'triage.critical.submitted') at boot. When the event is emitted,
 * every registered handler runs in parallel via Promise.allSettled — one
 * agent's failure is logged but never affects siblings or the caller.
 *
 * No new infrastructure: the six existing BullMQ queues still do the
 * async heavy lifting. This registry is just the *fan-out* mechanism that
 * turns one domain event into N parallel agent invocations.
 *
 * Contract (must be preserved):
 *   - emitEvent never throws. The triage submission response cannot be
 *     delayed or broken by an agent failure.
 *   - Handler execution order within a single event is not defined.
 *   - Handlers must be idempotent — same event can be re-emitted on retry.
 */

import logger from '../lib/logger.js';

/** @type {Map<string, Array<{name: string, fn: (payload: any) => Promise<void>|void}>>} */
const handlers = new Map();

/**
 * Register a handler for an event. Idempotent — re-registering the same
 * named handler is a no-op (prevents double-fire on hot reload in dev).
 *
 * @param {string} eventName
 * @param {(payload: any) => Promise<void>|void} handlerFn
 * @param {{ name?: string }} [opts]  Optional display name. Defaults to
 *   handlerFn.name; required when passing an anonymous function in dev.
 */
export function registerHandler(eventName, handlerFn, opts = {}) {
    if (!eventName || typeof handlerFn !== 'function') {
        logger.warn('[eventRegistry] registerHandler called with invalid args', {
            eventName, type: typeof handlerFn,
        });
        return;
    }
    const name = opts.name || handlerFn.name || 'anonymous';
    const list = handlers.get(eventName) || [];
    // Idempotent: don't double-register the same (eventName, name) pair.
    if (list.some((h) => h.name === name)) {
        logger.debug('[eventRegistry] handler already registered — skipping', { eventName, name });
        return;
    }
    list.push({ name, fn: handlerFn });
    handlers.set(eventName, list);
    logger.info('[eventRegistry] handler registered', { eventName, name, total: list.length });
}

/**
 * Emit an event. Runs every registered handler with the same payload via
 * Promise.allSettled — never throws, never blocks on a single failure.
 *
 * Returns a summary object describing what fired (counts only) so callers
 * can log it without inspecting individual handler results.
 *
 * @param {string} eventName
 * @param {object} payload
 * @returns {Promise<{ fired: number, succeeded: number, failed: number }>}
 */
export async function emitEvent(eventName, payload) {
    const list = handlers.get(eventName) || [];
    if (list.length === 0) {
        logger.debug('[eventRegistry] no handlers registered', { eventName });
        return { fired: 0, succeeded: 0, failed: 0 };
    }
    logger.info('[eventRegistry] emit', { eventName, handlerCount: list.length });

    const results = await Promise.allSettled(
        list.map(async ({ name, fn }) => {
            try {
                return await fn(payload);
            } catch (err) {
                // Inner catch so the agent name is captured in the log line —
                // Promise.allSettled would otherwise only give us the reason.
                logger.warn('[eventRegistry] handler failed', {
                    eventName, handler: name, err: err?.message ?? String(err),
                });
                throw err;
            }
        }),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed    = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
        logger.warn('[eventRegistry] some handlers failed', {
            eventName, fired: list.length, succeeded, failed,
        });
    }
    return { fired: list.length, succeeded, failed };
}

/** Test-only: clear all registered handlers. Not exported in production paths. */
export function _resetHandlersForTest() {
    handlers.clear();
}
