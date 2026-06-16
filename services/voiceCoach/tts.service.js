/**
 * Voice Coach — text-to-speech via Google Cloud Text-to-Speech REST API.
 *
 * Why REST + API key (not the @google-cloud/text-to-speech SDK + service
 * account JSON): the SDK requires either a downloaded service-account JSON or
 * Application Default Credentials, both of which add ops surface. The REST
 * endpoint accepts a plain API key as a query param, which is materially
 * simpler for a key that's restricted to the TTS API only (per our setup
 * step in the plan). Cost and audio quality are identical between the two
 * authentication modes.
 *
 * Voice selection: Google has higher-quality "Neural2" / "Wavenet" voices
 * for both Tamil (ta-IN) and English-Indian (en-IN). We pick female voices
 * by default; the patient can override per-session in a future setting.
 *
 * Returned audio is base64-encoded MP3 at 24kHz, ready to be embedded as a
 * data URL or returned to the frontend as a Blob.
 */

import logger from '../../lib/logger.js';
import { logUsage } from '../aiMetering.service.js';
import { getCurrentTenant } from '../../lib/tenantContext.js';

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

const VOICE_BY_LANG = {
    ta: { languageCode: 'ta-IN', name: 'ta-IN-Wavenet-A', ssmlGender: 'FEMALE' },
    en: { languageCode: 'en-IN', name: 'en-IN-Wavenet-D', ssmlGender: 'MALE' },
};

export class VoiceCoachTTSService {
    /**
     * Synthesize a short utterance to MP3 audio.
     *
     * @param {Object} params
     * @param {string} params.text             — the words to speak (≤ ~5000 chars per Google limit)
     * @param {('ta'|'en')=} params.language   — defaults to 'ta'
     * @returns {Promise<{ audioBase64: string, mimeType: 'audio/mpeg', voice: object, durationMs: number }>}
     */
    static async synthesize({ text, language = 'ta' }) {
        if (!text || !text.trim()) {
            const err = new Error('text is required');
            err.status = 400;
            throw err;
        }
        if (!process.env.GCP_TTS_API_KEY) {
            const err = new Error('GCP_TTS_API_KEY is not set');
            err.status = 503;
            err.code = 'TTS_NOT_CONFIGURED';
            throw err;
        }

        const voice = VOICE_BY_LANG[language] ?? VOICE_BY_LANG.ta;
        const body = {
            input: { text: text.trim().slice(0, 4900) },
            voice,
            audioConfig: {
                audioEncoding: 'MP3',
                speakingRate: 1.0,
                pitch: 0,
                sampleRateHertz: 24000,
            },
        };

        const t0 = Date.now();
        let response;
        try {
            response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(process.env.GCP_TTS_API_KEY)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch (err) {
            logger.error('[VoiceCoachTTS] Google TTS network error', err, { language });
            const wrapped = new Error('Voice synthesis is temporarily unavailable');
            wrapped.status = 502;
            wrapped.code = 'TTS_UPSTREAM_ERROR';
            throw wrapped;
        }

        if (!response.ok) {
            const txt = await response.text();
            logger.error('[VoiceCoachTTS] Google TTS rejected request', null, {
                status: response.status,
                body: txt.slice(0, 400),
                language,
            });
            const err = new Error(
                response.status === 403
                    ? 'TTS API key invalid or Cloud Text-to-Speech API not enabled for this project'
                    : `Google TTS error (${response.status})`,
            );
            err.status = 502;
            err.code = response.status === 403 ? 'TTS_NOT_AUTHORIZED' : 'TTS_UPSTREAM_ERROR';
            throw err;
        }

        const json = await response.json();
        const audioBase64 = json?.audioContent;
        if (!audioBase64) {
            logger.error('[VoiceCoachTTS] Google TTS returned no audioContent', null, json);
            const err = new Error('TTS response missing audio');
            err.status = 502;
            throw err;
        }

        const durationMs = Date.now() - t0;
        // Phase 2c — meter this AI call (fire-and-forget; cost from character count)
        logUsage({ hospitalId: getCurrentTenant(), feature: 'tts', model: voice?.name?.includes('Wavenet') ? 'google-tts-wavenet' : 'google-tts', metadata: { characters: text.length } });
        logger.info('[VoiceCoachTTS] synthesized', {
            language,
            voice: voice.name,
            chars: text.length,
            audioBytes: Math.ceil((audioBase64.length * 3) / 4),
            durationMs,
        });

        return {
            audioBase64,
            mimeType: 'audio/mpeg',
            voice,
            durationMs,
        };
    }
}

export default VoiceCoachTTSService;
