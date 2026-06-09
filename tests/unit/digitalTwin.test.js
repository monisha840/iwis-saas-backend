/**
 * F01 · Patient Digital Twin — twinAggregator.buildDigitalTwin unit tests.
 *
 * Covers the contract surface of the aggregator: shape, doshaBalance
 * invariants, graceful null on missing optional data, and the PatientVital
 * + TreatmentJourney `userId` FK gotcha.
 *
 * No real Prisma — every read is mocked. No HTTP — route layer is thin and
 * its only logic (hospital scope) is mirrored in the aggregator + a single
 * `if` in the route file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    mockPatient, mockDailyCheckIn, mockDoshaForecast, mockTongueObservation,
} from '../helpers/mockData.js';

vi.mock('../../lib/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const prismaMock = {
    patient: { findUnique: vi.fn(), count: vi.fn() },
    constitutionProfile: { findUnique: vi.fn() },
    dailyCheckIn: { findMany: vi.fn() },
    patientVital: { findMany: vi.fn() },
    prescription: { findMany: vi.fn() },
    doshaForecast: { findFirst: vi.fn() },
    tongueObservation: { findMany: vi.fn() },
    treatmentJourney: { findFirst: vi.fn() },
    patientAssignment: { findFirst: vi.fn() },
};
vi.mock('../../lib/prisma.js', () => ({ default: prismaMock }));

const { buildDigitalTwin } = await import('../../services/digitalTwin/twinAggregator.js');

function setHappyDefaults() {
    prismaMock.patient.findUnique.mockResolvedValue({
        id: 'pt-1',
        userId: 'u-1',
        user: { hospitalId: 'h-1' },
    });
    prismaMock.constitutionProfile.findUnique.mockResolvedValue({
        prakriti: 'VATA_PITTA', agniType: 'MANDAGNI', satvaRating: 7,
    });
    prismaMock.dailyCheckIn.findMany.mockResolvedValue([
        mockDailyCheckIn({ patientId: 'pt-1', createdAt: new Date('2026-06-01') }),
        mockDailyCheckIn({ patientId: 'pt-1', createdAt: new Date('2026-06-02') }),
    ]);
    prismaMock.patientVital.findMany.mockResolvedValue([]);
    prismaMock.prescription.findMany.mockResolvedValue([
        { id: 'rx-1', medicationName: 'Adathodai', dosage: '1 tsp', frequency: 'BD' },
        { id: 'rx-2', medicationName: 'Triphala',   dosage: '500mg', frequency: 'OD' },
    ]);
    prismaMock.doshaForecast.findFirst.mockResolvedValue(null);
    prismaMock.tongueObservation.findMany.mockResolvedValue([]);
    prismaMock.treatmentJourney.findFirst.mockResolvedValue({
        condition: 'Sandhigata Vata', status: 'ACTIVE', wellnessScore: 65,
    });
    prismaMock.patientAssignment.findFirst.mockResolvedValue(null);
    prismaMock.patient.count.mockResolvedValue(7);
}

function resetAll() {
    for (const tbl of Object.values(prismaMock)) for (const fn of Object.values(tbl)) fn.mockReset?.();
}

describe('twinAggregator · buildDigitalTwin', () => {
    beforeEach(() => { resetAll(); setHappyDefaults(); });

    it('returns null when patient does not exist', async () => {
        prismaMock.patient.findUnique.mockResolvedValue(null);
        const out = await buildDigitalTwin('pt-missing');
        expect(out).toBeNull();
    });

    it('returns null when patientId is missing', async () => {
        expect(await buildDigitalTwin(null)).toBeNull();
        expect(await buildDigitalTwin('')).toBeNull();
        expect(await buildDigitalTwin(undefined)).toBeNull();
    });

    it('returns every expected top-level field', async () => {
        const out = await buildDigitalTwin('pt-1');
        const required = [
            'patientId', 'prakriti', 'agniType', 'satvaRating',
            'painTrend', 'sleepTrend', 'moodTrend', 'mobilityTrend',
            'doshaBalance', 'forecast', 'tongueSummary',
            'activeMedCount', 'activeMeds',
            'wellnessScore', 'journeyCondition', 'journeyStatus',
            'similarPatientsCount', 'privacyFloor',
        ];
        for (const k of required) {
            expect(out).toHaveProperty(k);
        }
    });

    it('doshaBalance values sum to exactly 100', async () => {
        const out = await buildDigitalTwin('pt-1');
        const { vata, pitta, kapha } = out.doshaBalance;
        expect(vata + pitta + kapha).toBe(100);
        expect(vata).toBeGreaterThanOrEqual(0);
        expect(pitta).toBeGreaterThanOrEqual(0);
        expect(kapha).toBeGreaterThanOrEqual(0);
    });

    it('queries PatientVital using patient.userId, not patient.id (FK gotcha)', async () => {
        await buildDigitalTwin('pt-1');
        const vitalCall = prismaMock.patientVital.findMany.mock.calls[0][0];
        expect(vitalCall.where.patientId).toBe('u-1');
        expect(vitalCall.where.patientId).not.toBe('pt-1');
    });

    it('queries TreatmentJourney using patient.userId (same FK gotcha)', async () => {
        await buildDigitalTwin('pt-1');
        const journeyCall = prismaMock.treatmentJourney.findFirst.mock.calls[0][0];
        expect(journeyCall.where.patientId).toBe('u-1');
    });

    it('returns forecast: null when no active DoshaForecast', async () => {
        prismaMock.doshaForecast.findFirst.mockResolvedValue(null);
        const out = await buildDigitalTwin('pt-1');
        expect(out.forecast).toBeNull();
    });

    it('returns a populated forecast object when one exists', async () => {
        prismaMock.doshaForecast.findFirst.mockResolvedValue(mockDoshaForecast({
            dominantDosha: 'VATA', daysUntilSymp: 12, confidence: 0.74,
            triggerFactors: ['Pain rising'],
        }));
        const out = await buildDigitalTwin('pt-1');
        expect(out.forecast).toEqual({
            dominantDosha: 'VATA',
            daysUntilSymp: 12,
            confidence: 0.74,
            triggerFactors: ['Pain rising'],
        });
    });

    it('returns tongueSummary: null when no TongueObservation', async () => {
        prismaMock.tongueObservation.findMany.mockResolvedValue([]);
        const out = await buildDigitalTwin('pt-1');
        expect(out.tongueSummary).toBeNull();
    });

    it('returns a populated tongueSummary when observations exist', async () => {
        prismaMock.tongueObservation.findMany.mockResolvedValue([
            mockTongueObservation({ doshaIndication: 'PITTA', aiCoatingColour: 'YELLOW' }),
        ]);
        const out = await buildDigitalTwin('pt-1');
        expect(out.tongueSummary).not.toBeNull();
        expect(out.tongueSummary.latestDosha).toBe('PITTA');
        expect(out.tongueSummary.latestColour).toBe('YELLOW');
        expect(['STABLE', 'IMPROVING', 'WORSENING']).toContain(out.tongueSummary.trend);
    });

    it('similarPatientsCount is a number', async () => {
        prismaMock.patient.count.mockResolvedValue(12);
        const out = await buildDigitalTwin('pt-1');
        expect(typeof out.similarPatientsCount).toBe('number');
        expect(out.similarPatientsCount).toBe(12);
    });

    it('similarPatientsCount defaults to 0 when count query fails', async () => {
        prismaMock.patient.count.mockRejectedValue(new Error('db error'));
        const out = await buildDigitalTwin('pt-1');
        expect(out.similarPatientsCount).toBe(0);
    });

    it('similarPatientsCount is 0 when journeyCondition is null', async () => {
        prismaMock.treatmentJourney.findFirst.mockResolvedValue(null);
        const out = await buildDigitalTwin('pt-1');
        // With no journey condition we can't compute a cohort match.
        expect(out.similarPatientsCount).toBe(0);
        // Count query short-circuited — never reached.
        expect(prismaMock.patient.count).not.toHaveBeenCalled();
    });

    it('runs the 8 data queries in parallel via Promise.all', async () => {
        // Make each query a slow promise (40 ms each). If they ran
        // sequentially the aggregator would take ~320 ms; in parallel ~50 ms.
        const slow = (value) => new Promise((r) => setTimeout(() => r(value), 40));
        prismaMock.constitutionProfile.findUnique.mockReturnValue(slow({ prakriti: 'VATA' }));
        prismaMock.dailyCheckIn.findMany.mockReturnValue(slow([]));
        prismaMock.patientVital.findMany.mockReturnValue(slow([]));
        prismaMock.prescription.findMany.mockReturnValue(slow([]));
        prismaMock.doshaForecast.findFirst.mockReturnValue(slow(null));
        prismaMock.tongueObservation.findMany.mockReturnValue(slow([]));
        prismaMock.treatmentJourney.findFirst.mockReturnValue(slow(null));
        prismaMock.patientAssignment.findFirst.mockReturnValue(slow(null));

        const t0 = Date.now();
        await buildDigitalTwin('pt-1');
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(200); // generous ceiling for CI; sequential would be 320+
    });

    it('does not throw when optional data is missing', async () => {
        prismaMock.constitutionProfile.findUnique.mockResolvedValue(null);
        prismaMock.dailyCheckIn.findMany.mockResolvedValue([]);
        prismaMock.patientVital.findMany.mockResolvedValue([]);
        prismaMock.prescription.findMany.mockResolvedValue([]);
        prismaMock.doshaForecast.findFirst.mockResolvedValue(null);
        prismaMock.tongueObservation.findMany.mockResolvedValue([]);
        prismaMock.treatmentJourney.findFirst.mockResolvedValue(null);
        prismaMock.patientAssignment.findFirst.mockResolvedValue(null);

        const out = await buildDigitalTwin('pt-1');
        expect(out).toBeDefined();
        expect(out.painTrend).toEqual([]);
        expect(out.activeMedCount).toBe(0);
        expect(out.forecast).toBeNull();
        expect(out.tongueSummary).toBeNull();
        // doshaBalance always renders something (baseline from Prakriti).
        expect(out.doshaBalance.vata + out.doshaBalance.pitta + out.doshaBalance.kapha).toBe(100);
    });
});
