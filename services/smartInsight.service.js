/**
 * SmartInsightService — pattern detection over the last 14 daily check-ins.
 *
 * Reads structured DailyCheckIn.painRegions (the body-map data captured in
 * Step 2 of the check-in) plus the legacy painLevel scalar for older rows.
 * Surfaces a single, highest-priority insight per call so the dashboard
 * shows one clear nudge rather than a wall of text.
 *
 * Patterns detected (priority order):
 *   1. persistent_region   — same region intensity > 0 across the last 3+
 *                            consecutive check-ins (localised problem).
 *   2. new_region          — a region appears in today's check-in that was
 *                            not present in any of the prior 7 check-ins.
 *   3. sleep_pain_correlation — overallPainAvg on low-sleep days exceeds
 *                            adequate-sleep days by >= 1.5 points.
 *   4. wellness_improving  — overallPainAvg trending down by >= 1.5 points
 *                            (recent 3 vs prior 3).
 *   5. sleep_improving     — sleep duration up >= 10% recent 7 vs prior 7.
 *
 * Each insight returns { id, title, message, severity, regionId? } so the
 * UI can colour-code and link back to the body map.
 */

import prisma from '../lib/prisma.js';

const MAX_HISTORY = 14;

function avg(xs) {
  if (!xs || xs.length === 0) return 0;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

/** Derive max + average pain intensity for a single check-in. Falls back
 *  to the scalar painLevel when the body-map column is empty. */
function deriveOverall(checkIn) {
  const regions = Array.isArray(checkIn?.painRegions) ? checkIn.painRegions : [];
  if (regions.length === 0) {
    const scalar = Number(checkIn?.painLevel) || 0;
    return { max: scalar, avg: scalar, regions: [] };
  }
  const intensities = regions
    .map((r) => Number(r?.intensity ?? r?.severity ?? 0))
    .filter((n) => Number.isFinite(n));
  if (intensities.length === 0) {
    return { max: 0, avg: 0, regions: [] };
  }
  return {
    max: Math.max(...intensities),
    avg: intensities.reduce((s, n) => s + n, 0) / intensities.length,
    regions,
  };
}

export class SmartInsightService {
  static async computeForPatient(patientId) {
    const checkIns = await prisma.dailyCheckIn.findMany({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
      take: MAX_HISTORY,
    });
    if (checkIns.length < 1) return null;

    return this.detectPatterns(checkIns);
  }

  /**
   * Core pattern detection. Pulled out so it's unit-testable without
   * hitting the database — pass in an array of check-ins ordered desc.
   */
  static detectPatterns(checkInsDesc) {
    const checkIns = Array.isArray(checkInsDesc) ? checkInsDesc : [];
    if (checkIns.length === 0) return null;

    const derived = checkIns.map(deriveOverall);

    // ── 1. persistent_region (same regionId > 0 across last 3+ check-ins)
    if (checkIns.length >= 3) {
      const regionCountsByConsecutiveDays = new Map();
      // Walk recent → older, tally how many CONSECUTIVE check-ins each
      // region appears in with intensity > 0. Break the streak the moment
      // a region drops out of an earlier check-in.
      const seenInLater = new Set();
      let consecutiveCount = 0;
      for (const cd of derived) {
        consecutiveCount += 1;
        const regionsThis = (cd.regions || [])
          .filter((r) => Number(r?.intensity || 0) > 0)
          .map((r) => ({ id: String(r.regionId || r.region || ''), label: String(r.regionLabel || r.label || r.regionId || '') }));
        if (consecutiveCount === 1) {
          for (const r of regionsThis) {
            if (r.id) {
              regionCountsByConsecutiveDays.set(r.id, { count: 1, label: r.label });
              seenInLater.add(r.id);
            }
          }
        } else {
          // For each tracked region, increment if still present, else stop tracking
          const stillPresent = new Set(regionsThis.filter((r) => r.id).map((r) => r.id));
          for (const id of Array.from(regionCountsByConsecutiveDays.keys())) {
            if (stillPresent.has(id)) {
              const entry = regionCountsByConsecutiveDays.get(id);
              regionCountsByConsecutiveDays.set(id, { ...entry, count: entry.count + 1 });
            } else {
              regionCountsByConsecutiveDays.delete(id);
            }
          }
        }
      }
      let topRegion = null;
      for (const [id, entry] of regionCountsByConsecutiveDays.entries()) {
        if (entry.count >= 3 && (!topRegion || entry.count > topRegion.count)) {
          topRegion = { id, ...entry };
        }
      }
      if (topRegion) {
        return {
          id: 'persistent_region',
          title: 'Persistent pain detected',
          message: `Your ${topRegion.label || 'pain'} has been reported for ${topRegion.count} consecutive days — your doctor has been notified.`,
          severity: 'HIGH',
          regionId: topRegion.id,
        };
      }
    }

    // ── 2. new_region (today has a region not present in last 7 prior check-ins)
    if (checkIns.length >= 2) {
      const todayRegions = new Set(
        (derived[0].regions || [])
          .filter((r) => Number(r?.intensity || 0) > 0)
          .map((r) => String(r.regionId || r.region || '')),
      );
      const priorWindow = derived.slice(1, 8);
      const seenBefore = new Set();
      for (const cd of priorWindow) {
        for (const r of cd.regions || []) {
          if (Number(r?.intensity || 0) > 0) {
            seenBefore.add(String(r.regionId || r.region || ''));
          }
        }
      }
      const newOnes = [...todayRegions].filter((id) => id && !seenBefore.has(id));
      if (newOnes.length > 0 && priorWindow.length >= 2) {
        // Match label off today's regions
        const newLabel = (derived[0].regions || [])
          .find((r) => String(r.regionId || r.region || '') === newOnes[0])
          ?.regionLabel || newOnes[0];
        return {
          id: 'new_region',
          title: 'New pain location reported',
          message: `You logged ${newLabel} for the first time in over a week. Your care team will see this on their next review.`,
          severity: 'MEDIUM',
          regionId: newOnes[0],
        };
      }
    }

    // ── 3. sleep_pain_correlation (overallPainAvg on low-sleep days)
    if (checkIns.length >= 4) {
      const lowSleep = checkIns
        .map((c, i) => ({ c, d: derived[i] }))
        .filter(({ c }) => (c.sleepHours || 0) < 6);
      const adequateSleep = checkIns
        .map((c, i) => ({ c, d: derived[i] }))
        .filter(({ c }) => (c.sleepHours || 0) >= 6);
      if (lowSleep.length >= 2 && adequateSleep.length >= 2) {
        const lowAvg = avg(lowSleep.map(({ d }) => d.avg));
        const adqAvg = avg(adequateSleep.map(({ d }) => d.avg));
        if (lowAvg - adqAvg >= 1.5) {
          return {
            id: 'sleep_pain_correlation',
            title: 'Sleep impacts your pain',
            message: `Your average pain is highest on days when you sleep under 6 hours (${lowAvg.toFixed(1)} vs ${adqAvg.toFixed(1)}). Try a consistent bedtime.`,
            severity: 'MEDIUM',
          };
        }
      }
    }

    // ── 4. wellness_improving (overall pain trending down)
    if (checkIns.length >= 6) {
      const recent = derived.slice(0, 3);
      const prior = derived.slice(3, 6);
      const r = avg(recent.map((d) => d.avg));
      const p = avg(prior.map((d) => d.avg));
      if (p - r >= 1.5) {
        return {
          id: 'wellness_improving',
          title: 'Your pain is trending down',
          message: `Average pain dropped from ${p.toFixed(1)} to ${r.toFixed(1)} over the last week. Great progress!`,
          severity: 'INFO',
        };
      }
    }

    // ── 5. sleep_improving
    if (checkIns.length >= 8) {
      const recent = checkIns.slice(0, 7);
      const prior = checkIns.slice(7);
      const recentSleep = avg(recent.map((c) => c.sleepHours || 0));
      const priorSleep = avg(prior.map((c) => c.sleepHours || 0));
      if (priorSleep > 0 && recentSleep > priorSleep * 1.1) {
        const pct = Math.round(((recentSleep - priorSleep) / priorSleep) * 100);
        return {
          id: 'sleep_improving',
          title: 'Your sleep is improving',
          message: `Your sleep quality improved ${pct}% this week. The breathing exercises are working — keep going!`,
          severity: 'INFO',
        };
      }
    }

    return null;
  }
}

export default SmartInsightService;
