/**
 * Voice Coach — speech-to-text via OpenAI Whisper.
 *
 * Phase C is push-to-talk: the patient holds a mic button, releases, and the
 * full utterance lands here as a single audio buffer (webm/opus on Chrome,
 * mp4 on Safari — both natively accepted by Whisper). Streaming transcription
 * is deferred to a later phase along with WebSocket audio streaming.
 *
 * The model id `whisper-1` is OpenAI's general Whisper endpoint; it auto-
 * detects language but we pass `language: 'ta'` (or 'en') as a hint when we
 * know the patient's preference, which improves accuracy on short utterances
 * with code-switching between Tamil and English.
 */

import OpenAI, { toFile } from 'openai';
import logger from '../../lib/logger.js';
import { logUsage } from '../aiMetering.service.js';
import { getCurrentTenant } from '../../lib/tenantContext.js';

const MODEL = 'whisper-1';

let _client = null;
function client() {
    if (_client) return _client;
    if (!process.env.OPENAI_API_KEY) {
        const err = new Error('OPENAI_API_KEY is not set');
        err.status = 503;
        err.code = 'STT_NOT_CONFIGURED';
        throw err;
    }
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _client;
}

export class VoiceCoachSTTService {
    /**
     * Transcribe a single audio buffer to text.
     *
     * @param {Object} params
     * @param {Buffer} params.audioBuffer  — raw audio bytes (webm/opus, mp4, mp3, wav)
     * @param {string} params.filename     — used by Whisper to infer format. Default: 'audio.webm'
     * @param {string} params.mimeType     — audio MIME (audio/webm, audio/mp4, etc.)
     * @param {('ta'|'en')=} params.language — hint to improve short-utterance accuracy
     * @returns {Promise<{ transcript: string, language: string, durationMs: number }>}
     */
    static async transcribe({ audioBuffer, filename = 'audio.webm', mimeType = 'audio/webm' }) {
        if (!audioBuffer || audioBuffer.length === 0) {
            const err = new Error('audioBuffer is required');
            err.status = 400;
            throw err;
        }

        const t0 = Date.now();
        try {
            const file = await toFile(audioBuffer, filename, { type: mimeType });
            // verbose_json gives us Whisper's auto-detected language so we
            // can echo it back to the LLM and TTS. We deliberately don't
            // pass a `language` hint — forcing Whisper into one language
            // when the speaker uses another causes hallucinations.
            const result = await client().audio.transcriptions.create({
                model: MODEL,
                file,
                response_format: 'verbose_json',
                temperature: 0,
                prompt:
                    'An Ayurvedic patient is asking their health coach a question. ' +
                    'They may speak Tamil or English about pain, sleep, mood, ' +
                    'medication (Triphala, Ashwagandha, kashayam, etc.), or daily check-ins.',
            });
            // Phase 2c — meter this AI call (fire-and-forget; cost from audio minutes)
            logUsage({ hospitalId: getCurrentTenant(), feature: 'voice_coach', model: MODEL, metadata: { minutes: (result?.duration ?? 0) / 60 } });
            const rawTranscript = (result?.text ?? '').trim();
            const detectedFull = (result?.language ?? '').toLowerCase();
            const language = mapLanguageToIso(detectedFull);
            const durationMs = Date.now() - t0;

            // Filter known Whisper hallucinations on near-silent input. The
            // model has been trained on YouTube subtitles so silence often
            // resolves to phrases like "Thank you for watching", "Subscribe",
            // or empty Tamil filler tokens. We treat these as no-speech.
            const transcript = isLikelyHallucination(rawTranscript) ? '' : rawTranscript;

            logger.info('[VoiceCoachSTT] transcribed', {
                durationMs,
                bytes: audioBuffer.length,
                rawLength: rawTranscript.length,
                returnedLength: transcript.length,
                detected: detectedFull,
                language,
                whisperDuration: result?.duration,
            });
            return { transcript, language, durationMs };
        } catch (err) {
            // Enhanced logging — surface the OpenAI body so we can see WHY the
            // call failed (quota, bad audio, region, etc.) instead of just
            // "Whisper failed".
            let bodySnippet = null;
            try {
                if (err?.response?.text) {
                    bodySnippet = (await err.response.text()).slice(0, 500);
                } else if (err?.error) {
                    bodySnippet = JSON.stringify(err.error).slice(0, 500);
                }
            } catch (_) { /* ignore body read errors */ }
            logger.error('[VoiceCoachSTT] Whisper call failed', err, {
                bytes: audioBuffer.length,
                filename,
                mimeType,
                openaiStatus: err?.status,
                openaiCode: err?.code,
                openaiType: err?.type,
                openaiMessage: err?.message,
                openaiBody: bodySnippet,
            });
            const wrapped = new Error(
                err?.status === 429
                    ? 'Speech recognition is busy — try again in a moment'
                    : 'Speech recognition is temporarily unavailable',
            );
            wrapped.status = 502;
            wrapped.code = 'STT_UPSTREAM_ERROR';
            wrapped.cause = err;
            throw wrapped;
        }
    }
}

export default VoiceCoachSTTService;

/**
 * Whisper returns full language names ("tamil", "english", "hindi"). Map
 * the languages we actually support to ISO codes; anything else returns
 * null so the caller can fall back to the patient's stored preference.
 */
function mapLanguageToIso(name) {
    if (!name) return null;
    if (name === 'tamil' || name === 'ta') return 'ta';
    if (name === 'english' || name === 'en') return 'en';
    return null;
}

/**
 * Common Whisper hallucinations on silence / pure background noise.
 * Detected when the entire transcript matches one of these phrases or is
 * suspiciously short (< 2 chars after trimming punctuation).
 */
const HALLUCINATION_PATTERNS = [
    /^thank you( for watching)?\.?$/i,
    /^thanks for watching\.?$/i,
    /^subscribe!?$/i,
    /^please subscribe\.?$/i,
    /^you$/i,
    /^bye!?$/i,
    /^\.$/,
    /^…$/,
];
function isLikelyHallucination(text) {
    const stripped = text.replace(/[.!?…\s]+/g, '').trim();
    if (stripped.length === 0) return true;
    if (stripped.length < 2) return true;
    if (HALLUCINATION_PATTERNS.some((re) => re.test(text.trim()))) return true;
    if (isRepetitionCollapse(text)) return true;
    return false;
}

/**
 * Catch Whisper's repetition-collapse failure modes. Two layers:
 *
 *   Layer 1 — char-level: covers ASCII-tokenized collapses like
 *     "H-h-h-h-h" or "ka ka ka ka". Checks 1-3 char n-grams.
 *
 *   Layer 2 — phrase-level: covers Tamil and English phrase repeats like
 *     "தூக்கமும் வர மாட்டாது, தூக்கமும் வர மாட்டாது, தூக்கமும் வர மாட்டாது"
 *     where the unit being repeated is many characters long. The char-
 *     level check misses these because n=3 isn't long enough to catch
 *     the unit. We detect them with a regex on comma-separated chunks
 *     and a "consecutive identical token" sweep.
 */
function isRepetitionCollapse(text) {
    if (text.length < 20) return false;

    // Layer 2a — comma-separated chunk repeated 3+ times in a row.
    // Catches "X, X, X, X," directly.
    if (/([^,]{3,}),\s*\1,\s*\1/u.test(text)) return true;

    // Layer 2b — same word/phrase repeated 4+ times consecutively (no
    // comma separator). Catches "X X X X" style collapses.
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length >= 6) {
        // Try unit sizes 1..4 words. For each, scan for >= 4 consecutive
        // identical units. Strip trailing punctuation when comparing.
        const normalize = (s) => s.replace(/[.,!?…]+$/u, '').toLowerCase();
        for (const unit of [1, 2, 3, 4]) {
            let run = 1;
            for (let i = unit; i + unit <= tokens.length; i += unit) {
                const prev = tokens.slice(i - unit, i).map(normalize).join(' ');
                const here = tokens.slice(i, i + unit).map(normalize).join(' ');
                if (prev && prev === here) {
                    run++;
                    if (run >= 4) return true;
                } else {
                    run = 1;
                }
            }
        }
    }

    // Layer 1 — original char-level n-gram check.
    const stripped = text.replace(/[\s\-.,!?…]+/g, '').toLowerCase();
    if (stripped.length < 20) return false;
    for (const n of [1, 2, 3]) {
        const counts = new Map();
        for (let i = 0; i + n <= stripped.length; i += n) {
            const tok = stripped.slice(i, i + n);
            counts.set(tok, (counts.get(tok) ?? 0) + 1);
        }
        const total = Math.floor(stripped.length / n);
        if (total === 0) continue;
        let max = 0;
        for (const c of counts.values()) if (c > max) max = c;
        if (max / total > 0.6) return true;
    }
    return false;
}
