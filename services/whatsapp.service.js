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

export class WhatsAppService {
    static get enabled() {
        return Boolean(config.whatsapp.baseUrl && config.whatsapp.apiKey && config.whatsapp.instance);
    }

    /**
     * Send a WhatsApp text message via Evolution API.
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
