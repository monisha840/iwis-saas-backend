/**
 * AI metering service (Phase 2c).
 *
 * One central place to record every external AI call so usage can be billed and
 * monitored per hospital. logUsage() writes an AiUsageLog row and increments the
 * AiUsageMonthly (hospital + month + feature) rollup.
 *
 * Uses the BASE Prisma client with an explicit hospitalId so it behaves the same
 * in request handlers and background jobs (no dependence on tenant context).
 * Call sites should treat logUsage() as fire-and-forget — it never throws.
 */
import { prismaBase } from '../lib/prisma.js';
import logger from '../lib/logger.js';

// Approximate per-unit prices (USD). The point is to have *a* number, not
// perfection — adjust as provider prices change.
const PRICES = {
  'gpt-4o-mini':            { inPerTok: 0.15 / 1e6, outPerTok: 0.60 / 1e6 },
  'text-embedding-3-small': { inPerTok: 0.02 / 1e6, outPerTok: 0 },
  'whisper-1':              { perMinute: 0.006 },
  'google-tts':             { perChar: 4 / 1e6 },   // standard voices
  'google-tts-wavenet':     { perChar: 16 / 1e6 },  // WaveNet voices
};

/**
 * Estimate the USD cost of an AI call.
 * @param {string} model
 * @param {object} u  { inputTokens, outputTokens, minutes, characters }
 * @returns {number} estimated cost (>= 0)
 */
export function estimateCost(model, u = {}) {
  const p = PRICES[model];
  if (!p) return 0;
  let cost = 0;
  if (p.perMinute) cost = (u.minutes || 0) * p.perMinute;
  else if (p.perChar) cost = (u.characters || 0) * p.perChar;
  else cost = (u.inputTokens || 0) * (p.inPerTok || 0) + (u.outputTokens || 0) * (p.outPerTok || 0);
  return Math.round(cost * 1e6) / 1e6; // round to 6 dp ($)
}

/** Current month key, e.g. '2026-06'. */
function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

/**
 * Record one AI usage event. Never throws (metering must not break a feature).
 *
 * @param {object} args
 * @param {string}  args.hospitalId
 * @param {string=} args.userId
 * @param {string}  args.feature        e.g. 'voice_coach' | 'tongue' | 'tts'
 * @param {string}  args.model          e.g. 'gpt-4o-mini' | 'whisper-1' | 'google-tts'
 * @param {number=} args.inputTokens
 * @param {number=} args.outputTokens
 * @param {number=} args.estimatedCost  pass to override the auto-estimate
 * @param {object=} args.metadata       extra context; may carry { minutes, characters } for estimation
 */
export async function logUsage(args) {
  try {
    const {
      hospitalId, userId = null, feature, model,
      inputTokens = 0, outputTokens = 0, estimatedCost, metadata = null,
    } = args || {};

    if (!hospitalId || !feature || !model) {
      logger.warn('[aiMetering] missing hospitalId/feature/model — skipping', { hospitalId, feature, model });
      return;
    }

    const cost = estimatedCost != null
      ? estimatedCost
      : estimateCost(model, { inputTokens, outputTokens, ...(metadata || {}) });

    const month = monthKey();

    await prismaBase.aiUsageLog.create({
      data: { hospitalId, userId, feature, model, inputTokens, outputTokens, estimatedCost: cost, metadata: metadata || undefined },
    });

    await prismaBase.aiUsageMonthly.upsert({
      where: { hospitalId_month_feature: { hospitalId, month, feature } },
      create: { hospitalId, month, feature, totalCalls: 1, totalCost: cost },
      update: { totalCalls: { increment: 1 }, totalCost: { increment: cost } },
    });
  } catch (err) {
    logger.error('[aiMetering] logUsage failed', err);
  }
}

export const AiMeteringService = { logUsage, estimateCost };
export default AiMeteringService;
