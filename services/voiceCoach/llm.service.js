/**
 * Voice Coach — OpenAI gpt-4o-mini wrapper.
 *
 * Phase B is text-in / text-out: we call OpenAI once per turn and return the
 * full response. Phase C will swap to streaming so tokens flow into the TTS
 * service as they arrive.
 *
 * Prompt caching: OpenAI auto-caches any prompt prefix ≥ 1024 tokens for
 * 5–10 minutes. Our system prompt + rendered patient context easily clears
 * that threshold, so cache hits are essentially free on subsequent turns.
 * No `cache_control` directive is required (that's the Anthropic shape).
 *
 * Conversation memory: prior turns are passed as the `messages` array. We
 * pull from the database (via ContextService) so the memory survives
 * reconnects and the page being closed mid-session.
 */

import OpenAI from 'openai';
import logger from '../../lib/logger.js';
import { logUsage } from '../aiMetering.service.js';
import { getCurrentTenant } from '../../lib/tenantContext.js';
import { VoiceCoachContextService } from './context.service.js';
import { renderSystemPrompt } from './prompts.js';
import { retrievePassages } from './ragRetriever.js';

const MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 400; // ~4 sentences of voice-friendly Tamil/English

let _client = null;
function client() {
    if (_client) return _client;
    if (!process.env.OPENAI_API_KEY) {
        const err = new Error('OPENAI_API_KEY is not set');
        err.status = 503;
        err.code = 'LLM_NOT_CONFIGURED';
        throw err;
    }
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _client;
}

export class VoiceCoachLLMService {
    /**
     * Generate a coach reply for a single turn.
     *
     * @param {Object}  params
     * @param {string}  params.patientId        — Patient.id of the speaker
     * @param {string}  params.userTranscript   — what the patient just said (text)
     * @param {('ta'|'en')=} params.languageOverride — when set (typically by
     *   the audio-message route after Whisper detects the spoken language),
     *   overrides the patient's stored preferredCoachLang for this turn so
     *   the bot replies in the language the patient just used.
     * @returns {Promise<{ transcript: string, model: string, usage: object, contextSnapshot: object, languageUsed: string }>}
     */
    static async generateReply({ patientId, userTranscript, languageOverride }) {
        if (!userTranscript || !userTranscript.trim()) {
            const err = new Error('userTranscript is required');
            err.status = 400;
            throw err;
        }

        const ctx = await VoiceCoachContextService.buildContext(patientId);
        if (!ctx) {
            const err = new Error('Patient not found');
            err.status = 404;
            throw err;
        }

        // Per-turn language override (audio path uses this so the reply
        // matches what the patient just spoke). We deliberately mutate the
        // local copy, not the cached context — the next LLM call sees the
        // patient's stored preference again.
        if (languageOverride === 'ta' || languageOverride === 'en') {
            ctx.patient = { ...ctx.patient, preferredCoachLang: languageOverride };
        }
        const languageUsed = ctx.patient.preferredCoachLang;

        // Retrieve grounding passages from the Ayurvedic corpus. Never throws —
        // returns [] if RAG is disabled, the corpus is missing, or the OpenAI
        // embedding call fails. The prompt simply omits the references section
        // in those cases and the voice coach behaves as before.
        const retrieved = await retrievePassages(userTranscript).catch(() => []);

        const systemPrompt = renderSystemPrompt(ctx, retrieved);
        const messages = this._buildMessageHistory(systemPrompt, ctx.recentMessages, userTranscript);

        const t0 = Date.now();
        let response;
        try {
            response = await client().chat.completions.create({
                model: MODEL,
                max_tokens: MAX_OUTPUT_TOKENS,
                // 0.4 keeps replies factually grounded in the system prompt
                // (so the bot doesn't invent doctors, prescriptions, or
                // phase names) while still sounding natural for voice.
                // 0 makes replies repetitive on similar inputs; 1 lets the
                // model paraphrase the patient's data.
                temperature: 0.4,
                messages,
            });
        } catch (err) {
            logger.error('[VoiceCoachLLM] OpenAI call failed', err, {
                patientId,
                model: MODEL,
                latencyMs: Date.now() - t0,
            });
            const wrapped = new Error('Voice coach is temporarily unavailable');
            wrapped.status = 502;
            wrapped.code = 'LLM_UPSTREAM_ERROR';
            wrapped.cause = err;
            throw wrapped;
        }

        const text = (response.choices?.[0]?.message?.content ?? '').trim();

        const usage = {
            inputTokens: response.usage?.prompt_tokens ?? 0,
            outputTokens: response.usage?.completion_tokens ?? 0,
            cachedInputTokens:
                response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
            latencyMs: Date.now() - t0,
        };

        // Phase 2c — meter this AI call (fire-and-forget; no-op without a tenant)
        logUsage({ hospitalId: getCurrentTenant(), feature: 'voice_coach', model: MODEL, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, metadata: { patientId } });

        logger.info('[VoiceCoachLLM] reply generated', {
            patientId,
            model: MODEL,
            ...usage,
            length: text.length,
            retrievedPassageIds: retrieved.map(r => r.id),
        });

        return {
            transcript: text,
            model: MODEL,
            usage,
            languageUsed,
            retrievedPassages: retrieved.map(r => ({ id: r.id, score: r.score })),
            contextSnapshot: {
                hasPrescriptions: ctx.prescriptions.length > 0,
                hasActiveJourney: !!ctx.activePhase,
                memoryTurns: ctx.recentMessages.length,
                retrievedCount: retrieved.length,
            },
        };
    }

    /**
     * Build the OpenAI-format messages array. Unlike the Anthropic API,
     * OpenAI takes the system prompt as the first entry of `messages`
     * (with role 'system'), not as a separate top-level parameter.
     *
     * Doctor-injected SYSTEM-role rows from VoiceMessage are folded into
     * the user side as a third-person attribution so the model treats them
     * as additional context, not as something the assistant said.
     */
    static _buildMessageHistory(systemPrompt, priorTurns, newUserTranscript) {
        const out = [{ role: 'system', content: systemPrompt }];
        for (const turn of priorTurns) {
            if (turn.role === 'USER') {
                out.push({ role: 'user', content: turn.transcript });
            } else if (turn.role === 'ASSISTANT') {
                out.push({ role: 'assistant', content: turn.transcript });
            } else if (turn.role === 'SYSTEM') {
                // Doctor-injected note. Attribute it explicitly inside a user
                // turn so the model treats it as additional context.
                out.push({
                    role: 'user',
                    content: `[Doctor's note relayed to patient: ${turn.transcript}]`,
                });
            }
        }
        out.push({ role: 'user', content: newUserTranscript });
        return out;
    }
}

export default VoiceCoachLLMService;
