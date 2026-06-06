/**
 * F05 · Behavioural Nudge Engine — patient archetype classifier.
 *
 * Pure function. Takes a small profile snapshot built by the nudge worker
 * (see services/motivation.service.js) and decides which motivation frame
 * the next nudge should use. Rules are deliberately simple — no ML — so a
 * clinician can read them straight off the page and reason about why a
 * given patient got the message they did.
 *
 * Archetypes (first-match-wins, evaluated in priority order):
 *
 *   STREAK_MOTIVATED   — the patient is on a roll. Streak nudges work.
 *                        streakDays >= 5 AND checkInRate >= 0.7
 *   PROGRESS_MOTIVATED — measurable improvement is the hook.
 *                        painTrend < -0.5 OR sleepTrend > 0.3
 *   SOCIAL_MOTIVATED   — disengaging. Social proof / cohort comparison.
 *                        checkInRate < 0.4 AND streakDays < 3
 *   LOSS_AVERSE        — default fallback. "Don't lose your progress."
 *
 * Confidence is a 0..1 heuristic of how strongly the signals match the
 * winning rule. The cron itself doesn't gate on confidence today; it's
 * stored on the NudgeLog row so we can later A/B test thresholds.
 */

/**
 * @typedef PatientProfile
 * @property {string|null} prakriti           PrakritiType or null
 * @property {number}      streakDays         currentStreak from PatientStreak
 * @property {number}      checkInRate        0..1 — checkIns/14 over last 14 d
 * @property {number}      painTrend          avg painLevel last 7d − prior 7d
 * @property {number}      sleepTrend         avg sleepHours last 7d − prior 7d
 * @property {number}      lastCheckInDaysAgo days since last DailyCheckIn (Infinity if never)
 */

/**
 * @param {PatientProfile} profile
 * @returns {{ archetype: 'STREAK_MOTIVATED'|'PROGRESS_MOTIVATED'|'SOCIAL_MOTIVATED'|'LOSS_AVERSE', confidence: number }}
 */
export function classifyPatient(profile) {
    const {
        streakDays = 0,
        checkInRate = 0,
        painTrend = 0,
        sleepTrend = 0,
    } = profile ?? {};

    // 1) Streak — strongest signal when both legs of the AND clear comfortably.
    if (streakDays >= 5 && checkInRate >= 0.7) {
        // Scale: how far past both thresholds is the patient?
        //   streak component: linear from 0 (at 5d) → 1 (at 15d+)
        //   rate   component: linear from 0 (at 0.7) → 1 (at 1.0)
        const streakComp = Math.min(1, (streakDays - 5) / 10);
        const rateComp   = Math.min(1, (checkInRate - 0.7) / 0.3);
        // Floor at 0.6 so the categorical match is never dismissed as low-confidence.
        const confidence = clamp01(0.6 + 0.4 * (streakComp + rateComp) / 2);
        return { archetype: 'STREAK_MOTIVATED', confidence };
    }

    // 2) Progress — either pain dropped or sleep grew enough to be worth celebrating.
    if (painTrend < -0.5 || sleepTrend > 0.3) {
        // Strength = how dramatic the swing was. Bigger swings → higher confidence.
        const painStrength  = painTrend  < -0.5 ? Math.min(1, (-painTrend  - 0.5) / 2)  : 0;
        const sleepStrength = sleepTrend >  0.3 ? Math.min(1, (sleepTrend - 0.3) / 1.5) : 0;
        const confidence = clamp01(0.55 + 0.45 * Math.max(painStrength, sleepStrength));
        return { archetype: 'PROGRESS_MOTIVATED', confidence };
    }

    // 3) Social — light engagement + no streak. Cohort comparison nudges work here.
    if (checkInRate < 0.4 && streakDays < 3) {
        // The lower the rate, the more clearly social-motivated. Same for absent streak.
        const rateComp   = clamp01((0.4 - checkInRate) / 0.4);
        const streakComp = clamp01((3 - streakDays) / 3);
        const confidence = clamp01(0.5 + 0.4 * (rateComp + streakComp) / 2);
        return { archetype: 'SOCIAL_MOTIVATED', confidence };
    }

    // 4) Default — middling engagement, no extreme signals. Loss-frame is the
    //    safest universal nudge ("don't lose what you've built"), but confidence
    //    is intentionally low because this is the catch-all bucket.
    return { archetype: 'LOSS_AVERSE', confidence: 0.4 };
}

function clamp01(x) {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(1, x));
}
