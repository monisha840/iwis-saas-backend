/**
 * Medication frequency parsing.
 *
 * Two functions:
 *   - parseFrequencySlots(frequency)   → ordered slot list (morning/afternoon/evening)
 *   - parseDailyDoseCount(frequency)   → total doses per day (with multiplicity)
 *
 * `parseFrequencySlots` is re-exported for back-compat with
 * enhancedDashboard.service.js; it was the only parser before.
 *
 * `parseDailyDoseCount` understands compound frequencies like:
 *   "1 morning + 2 evening"   → 3
 *   "2 tabs TID"              → 6  (2 tablets × 3 slots)
 *   "1-0-1"                   → 2  (classic Indian-Rx notation)
 *   "BID"                     → 2  (falls back to slot count)
 *   "every 6 hours"           → 4
 *
 * Returns 0 for PRN / as-needed / SOS / blank — callers treat 0 as "no
 * forecasting, no reminders".
 */

const SLOT_KEYWORDS = {
    morning: ['morning', 'breakfast', 'am ', 'sunrise'],
    afternoon: ['afternoon', 'lunch', 'noon', 'midday'],
    evening: ['evening', 'night', 'bedtime', 'dinner', 'pm ', 'hs '],
};

const SLOT_ORDER = { morning: 0, afternoon: 1, evening: 2 };

export function parseFrequencySlots(frequency = '') {
    const f = String(frequency || '').toLowerCase();
    if (f.includes('three') || f.includes('3 times') || f.includes('tid')) {
        return ['morning', 'afternoon', 'evening'];
    }
    if (f.includes('twice') || f.includes('2 times') || f.includes('bid')) {
        return ['morning', 'evening'];
    }
    if (f.includes('four') || f.includes('4 times') || f.includes('qid')) {
        return ['morning', 'afternoon', 'evening', 'evening'];
    }
    if (f.includes('night') || f.includes('bedtime') || f.includes('hs')) {
        return ['evening'];
    }
    if (f.includes('afternoon') || f.includes('lunch')) {
        return ['afternoon'];
    }
    return ['morning'];
}

/**
 * Parse a frequency string into total daily dose count (integer).
 *
 * Strategy:
 *   1. PRN / SOS / as-needed → 0 (no schedule, no reminders).
 *   2. Indian-Rx "1-0-1" / "1-1-1" / "2-0-2" notation: sum of digits.
 *   3. "every N hours" → floor(24/N).
 *   4. Explicit multiplicity like "2 tabs TID" or "1 morning + 2 evening":
 *      sum per-slot quantities when present; otherwise slot-count × global count.
 *   5. Fallback: slot-count from parseFrequencySlots.
 */
export function parseDailyDoseCount(frequency = '') {
    const raw = String(frequency || '').trim();
    if (!raw) return 1;

    const lower = raw.toLowerCase();

    // PRN / SOS / as-needed — schedule-less dosing
    if (/\b(prn|sos|as[\s-]?needed|as required)\b/.test(lower)) return 0;

    // Indian-Rx pattern: digits separated by dashes. Accepts 2-part
    // (morning-evening) or 3-part (morning-noon-evening) or 4-part.
    // e.g. "1-0-1", "1-1-1", "2-0-2-1"
    const dashMatch = raw.match(/^\s*(\d+)\s*-\s*(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?\s*$/);
    if (dashMatch) {
        return dashMatch.slice(1).reduce((sum, d) => sum + (d ? parseInt(d, 10) : 0), 0);
    }

    // "every N hours"
    const everyMatch = lower.match(/every\s+(\d+)\s*(?:hour|hr|h\b)/);
    if (everyMatch) {
        const hours = parseInt(everyMatch[1], 10);
        if (hours > 0 && hours <= 24) return Math.floor(24 / hours);
    }

    // Per-slot multiplicity: "1 morning + 2 evening", "2 tabs afternoon",
    // "1 morning, 1 night". We scan for (digit, slot) pairs.
    let perSlotTotal = 0;
    const perSlotRegex = /(\d+)\s*(?:tabs?|tab|caps?|cap|pills?|pill|x)?\s*(?:at|in|-)?\s*(morning|afternoon|lunch|noon|evening|night|bedtime)\b/g;
    let match;
    while ((match = perSlotRegex.exec(lower)) !== null) {
        perSlotTotal += parseInt(match[1], 10);
    }
    if (perSlotTotal > 0) return perSlotTotal;

    // Global multiplicity + slot hints: "2 tabs TID" → 2 × 3
    const globalQtyMatch = lower.match(/(\d+)\s*(?:tabs?|tab|caps?|cap|pills?|pill)\b/);
    const globalQty = globalQtyMatch ? parseInt(globalQtyMatch[1], 10) : 1;

    // Slot-count fallback
    const slotCount = parseFrequencySlots(raw).length;
    return globalQty * slotCount;
}

export const _internals = { SLOT_KEYWORDS, SLOT_ORDER };
