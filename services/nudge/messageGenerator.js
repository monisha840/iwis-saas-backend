/**
 * F05 · Behavioural Nudge Engine — LLM-driven message generator.
 *
 * Generates a single warm 2-3 sentence WhatsApp nudge tailored to a patient's
 * profile + classified motivation archetype. On any failure (no API key, rate
 * limit, timeout, malformed response) we fall back to the existing static
 * AYURVEDIC_TIPS[prakriti × season] template the cron has been using since
 * day one — so a feature-flag-on hospital never *loses* a message even when
 * the LLM is down.
 *
 * Constraint: never throws. The caller (motivation cron) loops over hundreds
 * of patients and a single OpenAI hiccup must not poison the entire run.
 *
 * Cost note: gpt-4o-mini at 150 max tokens per call is ~$0.0001-0.0002 per
 * patient per week. At 500 active patients that's ~$0.10/wk for the feature.
 */

import OpenAI from 'openai';
import logger from '../../lib/logger.js';
import { logUsage } from '../aiMetering.service.js';
import { getCurrentTenant } from '../../lib/tenantContext.js';
import {
    AYURVEDIC_TIPS,
    getCurrentSeason,
    getDayOfYear,
} from '../../data/ayurvedicTips.js';

const MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 150;
const TEMPERATURE = 0.8;

// System prompt — kept verbatim per F05 spec.
const SYSTEM_PROMPT = `You are a compassionate Ayurvedic wellness coach sending a daily WhatsApp message to a patient. Write one short, warm message (2-3 sentences max, no markdown, no bullet points) that motivates the patient to complete their daily check-in today.

Rules:
- Match the motivation frame exactly (streak / progress / social / loss)
- Reference their Prakriti naturally if relevant
- Never mention clinical diagnoses or medications
- End with a gentle call to action
- Plain text only — this goes directly to WhatsApp`;

let _client = null;
function client() {
    if (_client) return _client;
    if (!process.env.OPENAI_API_KEY) return null;
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _client;
}

/**
 * Map the current calendar month (IST) to the four-season label the spec's
 * user-prompt template uses. We keep the LLM prompt independent of the
 * ritu-based AYURVEDIC_TIPS keys (HEMANTA / VASANTA / …) because the spec
 * was written against a Winter/Spring/Monsoon/Autumn framing — clearer to
 * the model and avoids leaking implementation jargon into the system prompt.
 */
function getNudgeSeasonLabel(now = new Date()) {
    // Convert UTC to IST (UTC+5:30) so this remains correct on a non-IST host.
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
    const month = new Date(istMs).getUTCMonth(); // 0..11
    if (month >= 11 || month <= 1) return 'Winter';   // Dec, Jan, Feb
    if (month >= 2 && month <= 4)  return 'Spring';   // Mar, Apr, May
    if (month >= 5 && month <= 7)  return 'Monsoon';  // Jun, Jul, Aug
    return 'Autumn';                                   // Sep, Oct, Nov
}

/**
 * Normalize a prakriti string to one of VATA/PITTA/KAPHA/GENERAL so the
 * static-template lookup never misses on casing or a tri-doshic combo label.
 * (ConstitutionProfile.prakriti can be VATA_PITTA etc.; the AYURVEDIC_TIPS
 * table only keys the three single-dosha buckets + GENERAL.)
 */
function normalizePrakritiForLookup(raw) {
    if (!raw) return 'GENERAL';
    const upper = String(raw).toUpperCase();
    if (upper === 'VATA' || upper === 'PITTA' || upper === 'KAPHA') return upper;
    // Combo prakritis (VATA_PITTA / PITTA_KAPHA / etc.) — pick the first
    // dosha; it's a reasonable bias and matches what the cron already does
    // by way of extractPrakriti() in motivation.service.js.
    if (upper.startsWith('VATA'))  return 'VATA';
    if (upper.startsWith('PITTA')) return 'PITTA';
    if (upper.startsWith('KAPHA')) return 'KAPHA';
    return 'GENERAL';
}

/**
 * Pure fallback — picks the same tip the static cron would have picked.
 * Returns the tip text by itself (no Monday Motivation wrap) so the cron's
 * message-substitution code path can use it as a drop-in for the LLM output.
 */
export function getStaticFallback(prakriti, now = new Date()) {
    const dosha = normalizePrakritiForLookup(prakriti);
    const season = getCurrentSeason(now);
    const dayOfYear = getDayOfYear(now);
    const cell = AYURVEDIC_TIPS[dosha]?.[season] ?? AYURVEDIC_TIPS.GENERAL;
    return cell[dayOfYear % cell.length];
}

/**
 * Generate a personalised nudge for one patient.
 *
 * @param {Object} input — merged patient profile + archetype.
 * @param {string|null} input.prakriti
 * @param {string} input.archetype  one of STREAK_MOTIVATED / PROGRESS_MOTIVATED / SOCIAL_MOTIVATED / LOSS_AVERSE
 * @param {number} input.streakDays
 * @param {number} input.checkInRate          0..1
 * @param {number} input.painTrend
 * @param {number} input.sleepTrend
 * @param {number} input.lastCheckInDaysAgo
 * @returns {Promise<string>} the WhatsApp message body (always a string — never throws)
 */
export async function generateNudgeMessage(input) {
    const {
        prakriti = null,
        archetype = 'LOSS_AVERSE',
        streakDays = 0,
        checkInRate = 0,
        painTrend = 0,
        lastCheckInDaysAgo = 0,
    } = input ?? {};

    const c = client();
    if (!c) {
        logger.warn('[nudge] OPENAI_API_KEY missing — using static fallback');
        return getStaticFallback(prakriti);
    }

    const season = getNudgeSeasonLabel();
    const userPrompt = [
        'Patient profile:',
        `- Prakriti: ${prakriti ?? 'unknown'}`,
        `- Motivation archetype: ${archetype}`,
        `- Streak: ${streakDays} days`,
        `- Check-in rate last 14 days: ${Math.round(checkInRate * 100)}%`,
        `- Pain trend: ${painTrend.toFixed(2)}`,
        `- Season: ${season}`,
        `- Last check-in: ${lastCheckInDaysAgo} days ago`,
        '',
        'Write one motivational WhatsApp message for today.',
    ].join('\n');

    try {
        const response = await c.chat.completions.create({
            model: MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: TEMPERATURE,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user',   content: userPrompt },
            ],
        });
        // Phase 2c — meter this AI call (fire-and-forget; no-op without a tenant)
        logUsage({ hospitalId: getCurrentTenant(), feature: 'nudge', model: MODEL, inputTokens: response?.usage?.prompt_tokens ?? 0, outputTokens: response?.usage?.completion_tokens ?? 0 });
        const text = response?.choices?.[0]?.message?.content?.trim();
        if (!text) {
            logger.warn('[nudge] OpenAI returned empty content — falling back', {
                archetype, prakriti,
            });
            return getStaticFallback(prakriti);
        }
        return text;
    } catch (err) {
        logger.warn('[nudge] OpenAI call failed — falling back to static template', {
            archetype, prakriti, err: err?.message ?? String(err),
        });
        return getStaticFallback(prakriti);
    }
}
