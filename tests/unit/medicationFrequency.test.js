import { describe, it, expect } from 'vitest';
import { parseFrequencySlots, parseDailyDoseCount } from '../../services/medicationFrequency.js';

describe('parseFrequencySlots', () => {
    it('returns morning+afternoon+evening for TID', () => {
        expect(parseFrequencySlots('TID')).toEqual(['morning', 'afternoon', 'evening']);
        expect(parseFrequencySlots('three times daily')).toEqual(['morning', 'afternoon', 'evening']);
        expect(parseFrequencySlots('3 times a day')).toEqual(['morning', 'afternoon', 'evening']);
    });

    it('returns morning+evening for BID', () => {
        expect(parseFrequencySlots('BID')).toEqual(['morning', 'evening']);
        expect(parseFrequencySlots('twice daily')).toEqual(['morning', 'evening']);
        expect(parseFrequencySlots('2 times a day')).toEqual(['morning', 'evening']);
    });

    it('handles bedtime/HS as evening only', () => {
        expect(parseFrequencySlots('1 at bedtime')).toEqual(['evening']);
        expect(parseFrequencySlots('HS')).toEqual(['evening']);
    });

    it('falls back to morning for unrecognized frequencies', () => {
        expect(parseFrequencySlots('once daily')).toEqual(['morning']);
        expect(parseFrequencySlots('')).toEqual(['morning']);
        expect(parseFrequencySlots(null)).toEqual(['morning']);
    });
});

describe('parseDailyDoseCount', () => {
    describe('PRN / as-needed', () => {
        it('returns 0 for PRN', () => {
            expect(parseDailyDoseCount('PRN')).toBe(0);
            expect(parseDailyDoseCount('as needed')).toBe(0);
            expect(parseDailyDoseCount('SOS')).toBe(0);
            expect(parseDailyDoseCount('1 tab as-needed')).toBe(0);
        });
    });

    describe('Indian-Rx dash notation', () => {
        it('sums 3-part 1-0-1 → 2', () => {
            expect(parseDailyDoseCount('1-0-1')).toBe(2);
        });

        it('sums 3-part 1-1-1 → 3', () => {
            expect(parseDailyDoseCount('1-1-1')).toBe(3);
        });

        it('sums 3-part 2-0-2 → 4', () => {
            expect(parseDailyDoseCount('2-0-2')).toBe(4);
        });

        it('sums 4-part 1-1-1-1 → 4', () => {
            expect(parseDailyDoseCount('1-1-1-1')).toBe(4);
        });

        it('tolerates whitespace', () => {
            expect(parseDailyDoseCount('  1 - 0 - 1  ')).toBe(2);
        });
    });

    describe('every N hours', () => {
        it('every 6 hours → 4', () => {
            expect(parseDailyDoseCount('every 6 hours')).toBe(4);
            expect(parseDailyDoseCount('every 6 hr')).toBe(4);
            expect(parseDailyDoseCount('1 tab every 6 h')).toBe(4);
        });

        it('every 8 hours → 3', () => {
            expect(parseDailyDoseCount('every 8 hours')).toBe(3);
        });

        it('every 12 hours → 2', () => {
            expect(parseDailyDoseCount('every 12 hours')).toBe(2);
        });
    });

    describe('per-slot multiplicity', () => {
        it('1 morning + 2 evening → 3', () => {
            expect(parseDailyDoseCount('1 morning + 2 evening')).toBe(3);
        });

        it('1 morning, 1 night → 2', () => {
            expect(parseDailyDoseCount('1 morning, 1 night')).toBe(2);
        });

        it('2 tabs afternoon → 2', () => {
            expect(parseDailyDoseCount('2 tabs afternoon')).toBe(2);
        });
    });

    describe('global multiplicity + slot hints', () => {
        it('2 tabs TID → 6', () => {
            expect(parseDailyDoseCount('2 tabs TID')).toBe(6);
        });

        it('2 caps BID → 4', () => {
            expect(parseDailyDoseCount('2 caps BID')).toBe(4);
        });
    });

    describe('slot-count fallback', () => {
        it('TID with no multiplicity → 3', () => {
            expect(parseDailyDoseCount('TID')).toBe(3);
        });

        it('BID → 2', () => {
            expect(parseDailyDoseCount('BID')).toBe(2);
        });

        it('once daily → 1', () => {
            expect(parseDailyDoseCount('once daily')).toBe(1);
            expect(parseDailyDoseCount('daily')).toBe(1);
        });

        it('blank → 1 (safe default)', () => {
            expect(parseDailyDoseCount('')).toBe(1);
            expect(parseDailyDoseCount(null)).toBe(1);
        });
    });
});
