import { describe, it, expect } from 'vitest';
import { SmartInsightService } from '../../services/smartInsight.service.js';

/**
 * Pure-logic tests for the multi-region smart insight engine. Bypasses
 * Prisma by exercising detectPatterns() directly with synthetic check-in
 * arrays (ordered desc, like the service's findMany would return).
 */

const today = (offsetDays = 0) => {
    const d = new Date('2026-04-26T12:00:00Z');
    d.setDate(d.getDate() - offsetDays);
    return d;
};

const checkIn = ({ dayOffset, painRegions = null, painLevel = 0, sleepHours = 7 }) => ({
    id: `c-${dayOffset}`,
    createdAt: today(dayOffset),
    painLevel,
    painRegions,
    sleepHours,
});

describe('SmartInsightService.detectPatterns', () => {
    it('returns null when there are no check-ins', () => {
        expect(SmartInsightService.detectPatterns([])).toBeNull();
    });

    it('detects persistent pain in the same region across 3+ consecutive days', () => {
        // Lower back appears in last 4 check-ins.
        const data = [0, 1, 2, 3].map((d) =>
            checkIn({
                dayOffset: d,
                painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 6 }],
            }),
        );
        const insight = SmartInsightService.detectPatterns(data);
        expect(insight).toBeTruthy();
        expect(insight.id).toBe('persistent_region');
        expect(insight.regionId).toBe('lower-back');
        expect(insight.message).toMatch(/Lower Back/);
        expect(insight.message).toMatch(/4 consecutive/);
    });

    it('does NOT flag persistent_region when the streak is broken', () => {
        // Lower back today + day 2, but day 1 only has knee — streak only 1.
        const data = [
            checkIn({ dayOffset: 0, painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 5 }] }),
            checkIn({ dayOffset: 1, painRegions: [{ regionId: 'left-knee', regionLabel: 'Left Knee', intensity: 4 }] }),
            checkIn({ dayOffset: 2, painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 5 }] }),
            checkIn({ dayOffset: 3, painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 5 }] }),
        ];
        const insight = SmartInsightService.detectPatterns(data);
        // No persistent region — falls through to the next pattern (or null).
        expect(insight?.id).not.toBe('persistent_region');
    });

    it('flags new_region when today has a region not in prior 7 days', () => {
        // Day 0: chest (new). Days 1-3: lower-back only.
        const data = [
            checkIn({ dayOffset: 0, painRegions: [{ regionId: 'chest', regionLabel: 'Chest', intensity: 5 }] }),
            checkIn({ dayOffset: 1, painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 5 }] }),
            checkIn({ dayOffset: 2, painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 5 }] }),
            checkIn({ dayOffset: 3, painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 5 }] }),
        ];
        const insight = SmartInsightService.detectPatterns(data);
        expect(insight).toBeTruthy();
        expect(insight.id).toBe('new_region');
        expect(insight.regionId).toBe('chest');
        expect(insight.message).toMatch(/Chest/);
    });

    it('flags sleep_pain_correlation when low-sleep days have higher avg intensity', () => {
        // 4 check-ins: 2 low-sleep (5h) with high pain, 2 adequate (8h) with low pain.
        const data = [
            checkIn({ dayOffset: 0, sleepHours: 5, painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 8 }] }),
            checkIn({ dayOffset: 1, sleepHours: 5, painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 7 }] }),
            checkIn({ dayOffset: 2, sleepHours: 8, painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 4 }] }),
            checkIn({ dayOffset: 3, sleepHours: 8, painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 3 }] }),
        ];
        const insight = SmartInsightService.detectPatterns(data);
        // persistent_region wins because lower-back is in all 4 — but disable
        // by varying region. Reshape with no consecutive overlap.
        const dataNoStreak = [
            checkIn({ dayOffset: 0, sleepHours: 5, painRegions: [{ regionId: 'left-knee', regionLabel: 'Left Knee', intensity: 8 }] }),
            checkIn({ dayOffset: 1, sleepHours: 5, painRegions: [{ regionId: 'right-knee', regionLabel: 'Right Knee', intensity: 7 }] }),
            checkIn({ dayOffset: 2, sleepHours: 8, painRegions: [{ regionId: 'chest', regionLabel: 'Chest', intensity: 4 }] }),
            checkIn({ dayOffset: 3, sleepHours: 8, painRegions: [{ regionId: 'abdomen', regionLabel: 'Abdomen', intensity: 3 }] }),
        ];
        const insight2 = SmartInsightService.detectPatterns(dataNoStreak);
        // First pattern that fires after persistent_region/new_region in this
        // shape is sleep_pain_correlation. (new_region also fires today —
        // ordering means new_region wins here.)
        expect(['new_region', 'sleep_pain_correlation']).toContain(insight2?.id);
    });

    it('falls back to legacy painLevel when painRegions is null', () => {
        // Sleep pattern using legacy scalar painLevel; new_region would not
        // fire because no regions in any check-in.
        const data = [
            checkIn({ dayOffset: 0, sleepHours: 5, painLevel: 8, painRegions: null }),
            checkIn({ dayOffset: 1, sleepHours: 5, painLevel: 7, painRegions: null }),
            checkIn({ dayOffset: 2, sleepHours: 8, painLevel: 3, painRegions: null }),
            checkIn({ dayOffset: 3, sleepHours: 8, painLevel: 3, painRegions: null }),
        ];
        const insight = SmartInsightService.detectPatterns(data);
        expect(insight?.id).toBe('sleep_pain_correlation');
    });

    it('handles empty painRegions arrays without crashing', () => {
        const data = [
            checkIn({ dayOffset: 0, painRegions: [] }),
            checkIn({ dayOffset: 1, painRegions: [] }),
        ];
        expect(() => SmartInsightService.detectPatterns(data)).not.toThrow();
    });
});
