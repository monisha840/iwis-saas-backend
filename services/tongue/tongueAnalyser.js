/**
 * F03 · Jihva Pariksha (tongue examination) — GPT-4o vision analyser.
 *
 * Single export: `analyseTongue(imageUrl, prakriti)` → analysis object OR null.
 * NEVER throws. Caller logs a fallback path (record saved with photoUrl only).
 *
 * Why gpt-4o (not gpt-4o-mini): the mini model's vision support is unreliable
 * for nuanced colour/texture classification — gpt-4o is the documented choice
 * for image-in tasks. Per-call cost is ~$0.01–0.02 at this token budget.
 *
 * Cost note: 300 max tokens output + one image input ≈ $0.01 per analysis.
 * One photo per patient per day at 500 patients ≈ $5/day = ~$150/month.
 */

import OpenAI from 'openai';
import logger from '../../lib/logger.js';
import { logUsage } from '../aiMetering.service.js';
import { getCurrentTenant } from '../../lib/tenantContext.js';

const MODEL = 'gpt-4o';
const MAX_OUTPUT_TOKENS = 300;
const TEMPERATURE = 0.2;

// System prompt — kept verbatim per F03 spec.
const SYSTEM_PROMPT = `You are an expert Ayurvedic physician performing Jihva Pariksha (tongue examination). Analyse the tongue image provided and return a JSON object only — no markdown, no explanation outside the JSON.

Return exactly this structure:
{
  "coatingColour": "WHITE|YELLOW|GREY|BROWN|NONE",
  "coatingThickness": "THIN|MODERATE|THICK",
  "moisture": "DRY|NORMAL|WET",
  "cracks": true|false,
  "doshaIndication": "VATA|PITTA|KAPHA|TRIDOSHA|BALANCED",
  "confidence": 0.0-1.0,
  "analysisNotes": "brief clinical observation in one sentence"
}

Ayurvedic interpretation guide:
- White coating, wet → Kapha imbalance
- Yellow/green coating, dry → Pitta imbalance
- Brown/black coating, very dry, cracks → Vata imbalance
- No coating, pink, moist → Balanced
- Mixed signals → TRIDOSHA`;

let _client = null;
function client() {
    if (_client) return _client;
    if (!process.env.OPENAI_API_KEY) return null;
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _client;
}

/**
 * Heuristic JSON extraction. The system prompt says "JSON only" but models
 * sometimes wrap with ```json fences or add a leading explanation. Strip
 * anything before the first `{` and after the last `}` before JSON.parse.
 */
function tryParseAnalysis(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    const start = trimmed.indexOf('{');
    const end   = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    const slice = trimmed.slice(start, end + 1);
    try {
        return JSON.parse(slice);
    } catch {
        return null;
    }
}

/**
 * @param {object} input
 * @param {string} [input.imageUrl]    publicly-readable URL the LLM can fetch
 * @param {Buffer} [input.imageBuffer] in-memory image bytes — preferred when
 *   the file isn't (or isn't yet) hosted at a public URL. Sent inline as a
 *   base64 data URL so the LLM never has to make an outbound fetch. Works
 *   regardless of Supabase Storage configuration.
 * @param {string} [input.mimeType='image/jpeg'] MIME of the buffer
 * @param {string|null} input.prakriti  the patient's known prakriti, or null
 * @returns {Promise<null | object>}    null on any failure
 */
export async function analyseTongue(input, prakritiArg) {
    // Back-compat: allow the old (url, prakriti) signature too.
    let imageUrl, imageBuffer, mimeType, prakriti;
    if (typeof input === 'string' || input == null) {
        imageUrl = input;
        prakriti = prakritiArg ?? null;
    } else {
        imageUrl    = input.imageUrl ?? null;
        imageBuffer = input.imageBuffer ?? null;
        mimeType    = input.mimeType ?? 'image/jpeg';
        prakriti    = input.prakriti ?? null;
    }

    // Prefer the inline base64 path — works without public storage.
    let llmImageUrl = null;
    if (imageBuffer) {
        const b64 = Buffer.isBuffer(imageBuffer)
            ? imageBuffer.toString('base64')
            : Buffer.from(imageBuffer).toString('base64');
        llmImageUrl = `data:${mimeType};base64,${b64}`;
    } else if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
        // Only public http(s) URLs are fetchable by OpenAI vision. A local
        // `/uploads/...` path would fail server-side, so skip in that case.
        llmImageUrl = imageUrl;
    }

    if (!llmImageUrl) {
        logger.warn('[tongueAnalyser] no fetchable image source — skipping', {
            hasBuffer: !!imageBuffer, hasUrl: !!imageUrl,
        });
        return null;
    }

    const c = client();
    if (!c) {
        logger.warn('[tongueAnalyser] OPENAI_API_KEY missing — skipping');
        return null;
    }

    const userText = `Patient Prakriti: ${prakriti ?? 'unknown'}\nAnalyse this tongue image for Ayurvedic diagnostic indicators.`;

    try {
        const response = await c.chat.completions.create({
            model: MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: TEMPERATURE,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: userText },
                        { type: 'image_url', image_url: { url: llmImageUrl } },
                    ],
                },
            ],
        });
        // Phase 2c — meter this AI call (fire-and-forget; no-op without a tenant)
        logUsage({ hospitalId: getCurrentTenant(), feature: 'tongue', model: MODEL, inputTokens: response?.usage?.prompt_tokens ?? 0, outputTokens: response?.usage?.completion_tokens ?? 0 });
        const rawAnalysis = response?.choices?.[0]?.message?.content ?? '';
        const parsed = tryParseAnalysis(rawAnalysis);
        if (!parsed) {
            logger.warn('[tongueAnalyser] could not parse JSON from model output', {
                rawHead: rawAnalysis.slice(0, 200),
            });
            return null;
        }
        return {
            coatingColour:    coerceString(parsed.coatingColour),
            coatingThickness: coerceString(parsed.coatingThickness),
            moisture:         coerceString(parsed.moisture),
            cracks:           parsed.cracks === true,
            doshaIndication:  coerceString(parsed.doshaIndication),
            confidence:       coerceFloat(parsed.confidence),
            analysisNotes:    coerceString(parsed.analysisNotes),
            rawAnalysis,
        };
    } catch (err) {
        logger.warn('[tongueAnalyser] OpenAI call failed', {
            err: err?.message ?? String(err),
        });
        return null;
    }
}

function coerceString(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
}
function coerceFloat(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n)) return null;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}
