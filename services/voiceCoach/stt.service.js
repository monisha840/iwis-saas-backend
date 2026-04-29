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
                // Light context priming. Whisper biases toward terms that
                // appeared in the prompt, so naming the domain reduces
                // drift toward generic YouTube hallucinations on noisy
                // input. We don't restate the patient's question — that
                // would bias the transcription toward something already
                // said.
                prompt:
                    'An Ayurvedic patient is asking their health coach a question. ' +
                    'They may speak Tamil or English about pain, sleep, mood, ' +
                    'medication (Triphala, Ashwagandha, kashayam, etc.), or daily check-ins.',
            });
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
            logger.error('[VoiceCoachSTT] Whisper call failed', err, {
                bytes: audioBuffer.length,
                filename,
                openaiStatus: err?.status,
                openaiMessage: err?.message,
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
 * Catch Whisper's classic token-repetition collapse — patterns like
 * "H-h-h-h-h-h-h" or "ka ka ka ka ka ka". Triggered when more than 60% of
 * the text is the same 1-3 character token repeated. We strip whitespace
 * and punctuation first so spaces don't let real text through.
 */
function isRepetitionCollapse(text) {
    if (text.length < 20) return false;
    const stripped = text.replace(/[\s\-.,!?…]+/g, '').toLowerCase();
    if (stripped.length < 20) return false;
    // Try short n-grams; if any single n-gram makes up >60% of the text we
    // treat the transcript as a collapse.
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
