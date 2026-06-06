/**
 * F04 · Predictive Dosha Imbalance Engine — pure scoring function.
 *
 * Rule-based v1 — no ML. Reads from the same DailyCheckIn + PatientVital
 * stream the dashboards already use, applies Ayurvedic correlation weights,
 * and decides whether a forecast alert should fire. Bootstrapping with rules
 * rather than ML is deliberate: we don't have labelled outcome data yet, so
 * a transparent rule set is what gets us shipped + builds the labelled
 * dataset for a future ML upgrade.
 *
 * Schema gotchas:
 *   - VitalType enum does NOT include HEART_RATE → the Pitta heart-rate rule
 *     is unsatisfiable today and is omitted. Documented inline.
 *   - DailyCheckIn has no `activity` column → the Kapha activity rule is
 *     also unsatisfiable. Mobility decline carries the Kapha signal alone.
 *   - mood is a free-text string (no enum) → we case-insensitively match
 *     the documented "STRESSED" / "ANXIOUS" values plus common variants.
 */

/**
 * @typedef ScoringInput
 * @property {string|null} prakriti              one of PrakritiType (VATA, PITTA, KAPHA, VATA_PITTA, ...)
 * @property {Array<{painLevel: number, sleepHours: number, mood: string, mobilityScore: number|null, createdAt: Date|string}>} checkIns
 *                                               newest first, up to 30 entries (last 30 days)
 * @property {Array<{type: string, value: number, recordedAt: Date|string}>} vitals
 *                                               newest first, up to 30 entries
 * @property {number} activePrescriptions         count of `discontinuedAt: null` rows
 * @property {string} season                     'WINTER' | 'SPRING' | 'SUMMER' | 'MONSOON' | 'AUTUMN'
 */

/**
 * @typedef ScoringOutput
 * @property {string} dominantDosha               VATA | PITTA | KAPHA — even when shouldAlert is false
 * @property {string} imbalanceType               'AGGRAVATION' (v1 only emits aggravation)
 * @property {number} daysUntilSymp               3..21 — clamp range per spec
 * @property {number} confidence                  0..0.95
 * @property {string[]} triggerFactors            human-readable lines for the popover
 * @property {boolean} shouldAlert                true when any dosha score > 1.5
 * @property {{ vata: number, pitta: number, kapha: number }} _scores  raw per-dosha scores (for tests / debugging)
 */

const ALERT_THRESHOLD = 1.5;
const STRESS_MOODS = new Set([
    'STRESSED', 'ANXIOUS', 'STRESSED_OUT', 'ANXIETY', 'STRESS',
    'WORRIED', 'TENSE', 'AGITATED',
]);

/**
 * Score a patient. Pure — never reads from DB, never throws.
 * @param {ScoringInput} data
 * @returns {ScoringOutput}
 */
export function scorePatient(data) {
    const {
        prakriti = null,
        checkIns = [],
        vitals = [],
        season = '',
    } = data ?? {};

    // Bootstrap: no data, no alert.
    if (!Array.isArray(checkIns) || checkIns.length === 0) {
        return {
            dominantDosha: 'VATA',
            imbalanceType: 'AGGRAVATION',
            daysUntilSymp: 21,
            confidence: 0,
            triggerFactors: ['Insufficient data'],
            shouldAlert: false,
            _scores: { vata: 0, pitta: 0, kapha: 0 },
        };
    }

    const triggerFactors = [];
    let vataScore = 0, pittaScore = 0, kappaScore = 0;
    // The misspelling is intentional locally — kept "kapha" everywhere else.
    let kaphaScore = 0;

    // Normalize check-ins into newest-first arrays of comparable shape so
    // every rule can split into last-7d vs prior-7d windows cleanly.
    const sorted = [...checkIns]
        .map((c) => ({ ...c, _t: new Date(c.createdAt).getTime() }))
        .sort((a, b) => b._t - a._t);

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const last7  = sorted.filter((c) => now - c._t <= 7 * day);
    const prior7 = sorted.filter((c) => now - c._t >  7 * day && now - c._t <= 14 * day);
    const last14 = sorted.filter((c) => now - c._t <= 14 * day);
    const prior14 = sorted.filter((c) => now - c._t > 14 * day && now - c._t <= 28 * day);

    const mean = (arr, key) =>
        arr.length === 0 ? 0 : arr.reduce((s, x) => s + (Number(x[key]) || 0), 0) / arr.length;

    // ── Vata aggravation signals ─────────────────────────────────────────
    // 1. Pain trend rising. The spec says "+0.5 per day avg over last 7d vs
    //    prior 7d". Interpreted as: delta-of-means / 7 — the per-day rate
    //    of climb. Any positive rate ≥ 0.5/day fires the rule.
    const painDelta = mean(last7, 'painLevel') - mean(prior7, 'painLevel');
    if (last7.length > 0 && prior7.length > 0 && painDelta >= 0.5 * 7) {
        // delta-of-means >= 3.5 ⇒ ~0.5/day rise. Threshold preserved.
        vataScore += 0.6;
        triggerFactors.push(`Pain rising +${(painDelta / 7).toFixed(2)}/day over 7 days`);
    } else if (last7.length > 0 && prior7.length > 0 && painDelta >= 1) {
        // Softer pain rise (≈0.14/day or more) still contributes a small
        // amount; this keeps borderline patients from being missed.
        vataScore += 0.25;
        triggerFactors.push(`Pain trending up by ${painDelta.toFixed(1)} over 7 days`);
    }

    // 2. Sleep declining (avg drop > 0.5h between windows).
    const sleepDeltaVP = mean(last7, 'sleepHours') - mean(prior7, 'sleepHours');
    if (last7.length > 0 && prior7.length > 0 && sleepDeltaVP < -0.5) {
        vataScore += 0.4;
        triggerFactors.push(
            `Sleep declined ${mean(prior7, 'sleepHours').toFixed(1)} → ${mean(last7, 'sleepHours').toFixed(1)} hrs`,
        );
    }

    // 3. Mood worsening. Mood is a free-text string; we score by counting
    //    stress-coded moods per window and comparing rates.
    const stressRate = (arr) =>
        arr.length === 0 ? 0 : arr.filter((c) => STRESS_MOODS.has(String(c.mood || '').toUpperCase())).length / arr.length;
    const moodDelta = stressRate(last7) - stressRate(prior7);
    if (last7.length > 0 && prior7.length > 0 && moodDelta > 0.1) {
        vataScore += 0.3;
        triggerFactors.push(`Mood worsening — stress markers rose ${Math.round(moodDelta * 100)}% over 7 days`);
    }

    // 4. Mobility declining.
    const mobLast = mean(last7, 'mobilityScore');
    const mobPrior = mean(prior7, 'mobilityScore');
    if (last7.length > 0 && prior7.length > 0 && mobLast < mobPrior) {
        const drop = mobPrior - mobLast;
        if (drop >= 0.5) {
            vataScore += 0.3;
            triggerFactors.push(`Mobility declining ${mobPrior.toFixed(1)} → ${mobLast.toFixed(1)} over 7 days`);
        }
    }

    // 5. Vata seasonal baseline.
    if (containsDosha(prakriti, 'VATA') && (season === 'WINTER' || season === 'AUTUMN')) {
        vataScore += 0.3;
        triggerFactors.push(`Vata-aggravating season (${season.toLowerCase()})`);
    }

    // 6. Missed check-ins > 3 in last 14 days. We approximate "expected" as
    //    14 days and treat unique-day count as compliance.
    const uniqueDaysLast14 = new Set(
        last14.map((c) => new Date(c.createdAt).toISOString().slice(0, 10)),
    ).size;
    const missed14 = 14 - Math.min(14, uniqueDaysLast14);
    if (missed14 > 3) {
        vataScore += 0.2;
        triggerFactors.push(`${missed14} missed check-ins in the last 14 days`);
    }

    // ── Pitta aggravation signals ────────────────────────────────────────
    // 7. Pain sustained high — avg painLevel > 6 over 7+ consecutive days.
    //    Approximate "7+ consecutive" as "7+ entries each with painLevel > 6".
    const sustainedHighPain = last7.length >= 7 && last7.every((c) => Number(c.painLevel) > 6);
    if (sustainedHighPain) {
        pittaScore += 0.6;
        triggerFactors.push('Pain sustained above 6/10 for 7+ days');
    }

    // 8. Stress / anxious mood for 5+ of last 7 days.
    const stressDays = last7.filter((c) => STRESS_MOODS.has(String(c.mood || '').toUpperCase())).length;
    if (stressDays >= 5) {
        pittaScore += 0.5;
        triggerFactors.push(`Stress/anxiety markers on ${stressDays} of last 7 days`);
    }

    // 9. Pitta seasonal baseline.
    if (containsDosha(prakriti, 'PITTA') && (season === 'SUMMER' || season === 'SPRING')) {
        pittaScore += 0.3;
        triggerFactors.push(`Pitta-aggravating season (${season.toLowerCase()})`);
    }

    // 10. Heart-rate trend — UNSATISFIABLE: VitalType enum has no HEART_RATE
    //     in this schema. Documented so the rule's absence is intentional
    //     not forgotten. Add when the enum gains HEART_RATE.
    void vitals;  // referenced so lint doesn't flag the unused arg

    // ── Kapha aggravation signals ────────────────────────────────────────
    // 11. Sleep > 9 hours avg over last 7 days.
    const sleepLastAvg = mean(last7, 'sleepHours');
    if (last7.length > 0 && sleepLastAvg > 9) {
        kaphaScore += 0.6;
        triggerFactors.push(`Excessive sleep — averaging ${sleepLastAvg.toFixed(1)} hrs/night`);
    }

    // 12. Mobility declining over 14 days (broader window than Vata's 7d rule).
    const mob14  = mean(last14, 'mobilityScore');
    const mobPrior14 = mean(prior14, 'mobilityScore');
    if (last14.length > 0 && prior14.length > 0 && mob14 < mobPrior14) {
        const drop14 = mobPrior14 - mob14;
        if (drop14 >= 0.5) {
            kaphaScore += 0.4;
            triggerFactors.push(`Mobility declining over 14 days (${mobPrior14.toFixed(1)} → ${mob14.toFixed(1)})`);
        }
    }

    // 13. Activity score low — UNSATISFIABLE: DailyCheckIn has no activity
    //     column today (only mobilityScore + sleepHours + mood + painLevel).
    //     Add when daily-tracking activity rolls up into DailyCheckIn.

    // 14. Kapha seasonal baseline.
    if (containsDosha(prakriti, 'KAPHA') && (season === 'WINTER' || season === 'SPRING')) {
        kaphaScore += 0.3;
        triggerFactors.push(`Kapha-aggravating season (${season.toLowerCase()})`);
    }

    // ── Prakriti baselines (+0.2 to the matching dosha) ─────────────────
    if (containsDosha(prakriti, 'VATA'))  vataScore  += 0.2;
    if (containsDosha(prakriti, 'PITTA')) pittaScore += 0.2;
    if (containsDosha(prakriti, 'KAPHA')) kaphaScore += 0.2;

    // ── Pick the dominant ───────────────────────────────────────────────
    const scores = { VATA: vataScore, PITTA: pittaScore, KAPHA: kaphaScore };
    const dominantDosha = Object.entries(scores).sort(([, a], [, b]) => b - a)[0][0];
    const dominantScore = scores[dominantDosha];

    const shouldAlert = dominantScore > ALERT_THRESHOLD;

    // daysUntilSymp = round(14 - (dominantScore - 1.5) * 4), clamped 3..21.
    const rawDays = Math.round(14 - (dominantScore - ALERT_THRESHOLD) * 4);
    const daysUntilSymp = Math.max(3, Math.min(21, Number.isFinite(rawDays) ? rawDays : 21));

    // confidence = min(dominantScore / 3, 0.95)
    const confidence = Math.max(0, Math.min(0.95, dominantScore / 3));

    // When nothing fired, give an "Insufficient signal" trigger for the
    // record so the doctor can still see why the patient was scored.
    if (triggerFactors.length === 0) {
        triggerFactors.push('No drift detected — baseline state');
    }

    return {
        dominantDosha,
        imbalanceType: 'AGGRAVATION',
        daysUntilSymp,
        confidence: round2(confidence),
        triggerFactors,
        shouldAlert,
        _scores: {
            vata:  round2(vataScore),
            pitta: round2(pittaScore),
            kapha: round2(kaphaScore),
        },
    };
}

function containsDosha(prakritiRaw, dosha) {
    if (!prakritiRaw) return false;
    return String(prakritiRaw).toUpperCase().includes(dosha) ||
        String(prakritiRaw).toUpperCase() === 'TRIDOSHA';
}

function round2(x) {
    return Math.round(x * 100) / 100;
}
