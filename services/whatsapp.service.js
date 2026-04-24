/**
 * WhatsApp Service — Evolution API client.
 *
 * Sends plain-text WhatsApp messages through a self-hosted Evolution API instance.
 * Endpoint: POST {EVOLUTION_API_URL}/message/sendText/{EVOLUTION_INSTANCE}
 * Auth:     apikey: {EVOLUTION_API_KEY} header
 * Body:     { number: "91XXXXXXXXXX", text: "..." }
 *
 * When Evolution credentials are absent, `sendText` resolves to a no-op so the
 * rest of the app keeps working in development without a live WhatsApp gateway.
 */

import config from '../config/index.js';
import logger from '../lib/logger.js';

// ── Retry policy ────────────────────────────────────────────────────────────
// 3 attempts total, exponential backoff (500ms, 2000ms). Max total wait ~2.5s.
// Retries cover transient Evolution API failures: 429 rate-limit, 5xx,
// and network errors. Non-retryable (4xx other than 429) fail fast.
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 2000];

/** HTTP statuses that indicate a transient failure worth retrying. */
function isRetryableStatus(status) {
    return status === 429 || (status >= 500 && status < 600);
}

/** Parse an HTTP status out of our thrown error messages. */
export function _parseStatusFromError(error) {
    if (!error || !error.message) return null;
    const m = /\((\d{3})\)/.exec(error.message);
    return m ? parseInt(m[1], 10) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WhatsAppService {
    static get enabled() {
        return Boolean(config.whatsapp.baseUrl && config.whatsapp.apiKey && config.whatsapp.instance);
    }

    /**
     * Send a WhatsApp text message via Evolution API.
     *
     * Retries transient failures (429, 5xx, network) up to MAX_ATTEMPTS with
     * exponential backoff. Non-retryable 4xx errors (bad number, auth) fail
     * fast so the caller can fall through to the next channel immediately.
     *
     * @param {string} number  - E.164-ish digits (country code prefixed, no plus/dashes).
     * @param {string} text    - Message body.
     * @returns {Promise<{status: 'SENT'|'SKIPPED'|'FAILED', externalId?: string, error?: string}>}
     */
    static async sendText(number, text) {
        if (!this.enabled) {
            logger.warn('[WhatsAppService] Evolution API not configured — skipping send');
            return { status: 'SKIPPED' };
        }

        if (!number || !text) {
            return { status: 'FAILED', error: 'number and text are required' };
        }

        let lastError = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                return await this._sendOnce(number, text);
            } catch (err) {
                lastError = err;
                const status = _parseStatusFromError(err);
                const retryable = status == null /* network error */ || isRetryableStatus(status);

                if (!retryable || attempt === MAX_ATTEMPTS) {
                    logger.warn('[WhatsAppService] send failed (no more retries)', {
                        attempt, status, error: err.message,
                    });
                    throw err;
                }

                const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
                logger.info('[WhatsAppService] transient failure — retrying', {
                    attempt, status, waitMs: wait,
                });
                await sleep(wait);
            }
        }
        // Unreachable — loop either returns or throws.
        throw lastError || new Error('WhatsAppService.sendText exhausted retries');
    }

    /** Single-shot Evolution API call. Throws on non-2xx; returns {status:'SENT'} on success. */
    static async _sendOnce(number, text) {
        const url = `${config.whatsapp.baseUrl.replace(/\/$/, '')}/message/sendText/${encodeURIComponent(config.whatsapp.instance)}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: config.whatsapp.apiKey,
            },
            body: JSON.stringify({ number, text }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Evolution sendText failed (${response.status}): ${body}`);
        }

        const json = await response.json().catch(() => ({}));
        const externalId = json?.key?.id || json?.messageId || json?.id || null;
        return { status: 'SENT', externalId };
    }
}

export const whatsappService = WhatsAppService;
