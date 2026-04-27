import { describe, it, expect } from 'vitest';
import {
    gradeJourneyResponses,
    buildXpDistribution,
} from '../../services/journeyFeedback.service.js';

describe('gradeJourneyResponses — per-question XP', () => {
    it('awards 0 XP when every response is null/skipped', () => {
        const g = gradeJourneyResponses({
            mcqAppointments:         null,
            mcqReminders:            null,
            mcqMedications:          null,
            mcqFamilyRecommendation: null,
            gardenScore:             null,
            faceScaleExperience:     null,
            thankYouCardText:        null,
        });
        expect(g.total).toBe(0);
    });

    it('awards full 7 XP for all-positive responses + thank-you card', () => {
        const g = gradeJourneyResponses({
            mcqAppointments:         'A',
            mcqReminders:            'B',
            mcqMedications:          'A',
            mcqFamilyRecommendation: 'A',
            gardenScore:             10,
            faceScaleExperience:     5,
            thankYouCardText:        'Thank you very much for your dedicated care over these months.',
        });
        expect(g).toEqual({
            mcqAppointments: 1,
            mcqReminders: 1,
            mcqMedications: 1,
            mcqFamilyRecommendation: 1,
            gardenScore: 1,
            faceScaleExperience: 1,
            thankYouCard: 1,
            total: 7,
        });
    });

    it('treats MCQ option C/D as no XP', () => {
        const g = gradeJourneyResponses({
            mcqAppointments:         'C',
            mcqReminders:            'D',
            mcqMedications:          'C',
            mcqFamilyRecommendation: 'D',
            gardenScore:             null,
            faceScaleExperience:     null,
            thankYouCardText:        null,
        });
        expect(g.total).toBe(0);
    });

    it('garden positive threshold is 5 (Small plant)', () => {
        // 1 (Seed) and 3 (Sprout) → no XP
        expect(gradeJourneyResponses({ gardenScore: 1 }).gardenScore).toBe(0);
        expect(gradeJourneyResponses({ gardenScore: 3 }).gardenScore).toBe(0);
        // 5, 7, 10 → XP
        expect(gradeJourneyResponses({ gardenScore: 5 }).gardenScore).toBe(1);
        expect(gradeJourneyResponses({ gardenScore: 7 }).gardenScore).toBe(1);
        expect(gradeJourneyResponses({ gardenScore: 10 }).gardenScore).toBe(1);
    });

    it('face scale positive threshold is 4', () => {
        expect(gradeJourneyResponses({ faceScaleExperience: 1 }).faceScaleExperience).toBe(0);
        expect(gradeJourneyResponses({ faceScaleExperience: 3 }).faceScaleExperience).toBe(0);
        expect(gradeJourneyResponses({ faceScaleExperience: 4 }).faceScaleExperience).toBe(1);
        expect(gradeJourneyResponses({ faceScaleExperience: 5 }).faceScaleExperience).toBe(1);
    });

    it('thank-you card requires more than 10 chars (i.e. >= 11) after trim', () => {
        // exactly 10 chars → no XP
        expect(gradeJourneyResponses({ thankYouCardText: '1234567890' }).thankYouCard).toBe(0);
        // 11 chars → XP
        expect(gradeJourneyResponses({ thankYouCardText: '12345678901' }).thankYouCard).toBe(1);
        // whitespace-padded short string → trimmed below threshold
        expect(gradeJourneyResponses({ thankYouCardText: '   short   ' }).thankYouCard).toBe(0);
        // empty / null → no XP
        expect(gradeJourneyResponses({ thankYouCardText: '' }).thankYouCard).toBe(0);
        expect(gradeJourneyResponses({ thankYouCardText: null }).thankYouCard).toBe(0);
    });
});

describe('buildXpDistribution — lead doctor + co-treater split', () => {
    const lead = 'doctor-lead-id';

    it('100% to lead doctor when no co-treaters exist', () => {
        const d = buildXpDistribution({
            leadDoctorId: lead,
            nonCardXp:    6,
            cardXp:       1,
            coTreaterTallies: [],
        });
        expect(d.leadDoctorXp).toBe(7);
        expect(d.leadDoctorBaseXp).toBe(6);
        expect(d.leadDoctorCardXp).toBe(1);
        expect(d.coTreaters).toEqual([]);
        expect(d.totalDistributed).toBe(7);
    });

    it('100% to lead doctor when co-treaters exist but none qualify', () => {
        const d = buildXpDistribution({
            leadDoctorId: lead,
            nonCardXp:    5,
            cardXp:       1,
            coTreaterTallies: [
                // Both below thresholds: < 3 appointments AND < 5 therapy sessions
                { userId: 'co1', role: 'DOCTOR',    appointmentCount: 2, therapyCount: 0 },
                { userId: 'co2', role: 'THERAPIST', appointmentCount: 1, therapyCount: 4 },
            ],
        });
        expect(d.leadDoctorXp).toBe(6);
        expect(d.coTreaters).toEqual([]);
    });

    it('70/30 split when one co-treater qualifies via 3+ appointments', () => {
        const d = buildXpDistribution({
            leadDoctorId: lead,
            nonCardXp:    6,
            cardXp:       1,
            coTreaterTallies: [
                { userId: 'co1', role: 'DOCTOR', appointmentCount: 3, therapyCount: 0 },
            ],
        });
        // Lead = floor(6 * 0.7) = 4 + cardXp 1 = 5
        // Co-treater = 6 - 4 = 2
        expect(d.leadDoctorBaseXp).toBe(4);
        expect(d.leadDoctorCardXp).toBe(1);
        expect(d.leadDoctorXp).toBe(5);
        expect(d.coTreaters).toEqual([
            { userId: 'co1', role: 'DOCTOR', xp: 2, share: 1.0 },
        ]);
        expect(d.totalDistributed).toBe(7);
    });

    it('therapy session threshold is 5+ (independent of appointment count)', () => {
        const d = buildXpDistribution({
            leadDoctorId: lead,
            nonCardXp:    6,
            cardXp:       0,
            coTreaterTallies: [
                // therapyCount 5 qualifies even though appointmentCount is below 3
                { userId: 'co1', role: 'THERAPIST', appointmentCount: 1, therapyCount: 5 },
            ],
        });
        expect(d.leadDoctorBaseXp).toBe(4);
        expect(d.coTreaters[0].userId).toBe('co1');
        expect(d.coTreaters[0].xp).toBe(2);
    });

    it('splits 30% across multiple qualifying co-treaters by appointment count', () => {
        const d = buildXpDistribution({
            leadDoctorId: lead,
            nonCardXp:    6,
            cardXp:       1,
            coTreaterTallies: [
                { userId: 'coA', role: 'DOCTOR',    appointmentCount: 4, therapyCount: 0 },
                { userId: 'coB', role: 'THERAPIST', appointmentCount: 6, therapyCount: 6 },
            ],
        });
        // Total appointments among qualifying co-treaters = 10
        // Lead = floor(6 * 0.7) = 4; co-treater pool = 2
        // coA share = 4/10 = 0.4 → floor(2 * 0.4) = 0 (loses to rounding)
        // coB absorbs remainder = 2 - 0 = 2
        // Total = 4 + 1 + 0 + 2 = 7 (perfect)
        expect(d.leadDoctorXp).toBe(5);
        expect(d.coTreaters).toHaveLength(2);
        expect(d.coTreaters.map((c) => c.userId)).toEqual(['coA', 'coB']);
        const totalCoTreaterXp = d.coTreaters.reduce((s, c) => s + c.xp, 0);
        expect(totalCoTreaterXp).toBe(2);
        expect(d.totalDistributed).toBe(7);
    });

    it('thank-you card XP is always 100% to lead doctor regardless of co-treaters', () => {
        const d = buildXpDistribution({
            leadDoctorId: lead,
            nonCardXp:    6,
            cardXp:       1,
            coTreaterTallies: [
                { userId: 'coA', role: 'DOCTOR', appointmentCount: 5, therapyCount: 0 },
            ],
        });
        // leadDoctorBaseXp = floor(6*0.7) = 4
        // leadDoctorCardXp = 1 (always 100% to lead)
        // leadDoctorXp = 4 + 1 = 5
        // coA xp = 6 - 4 = 2
        expect(d.leadDoctorBaseXp).toBe(4);
        expect(d.leadDoctorCardXp).toBe(1);
        expect(d.leadDoctorXp).toBe(5);
        expect(d.coTreaters[0].xp).toBe(2);
        expect(d.totalDistributed).toBe(7);
    });

    it('lead doctor takes 100% when nonCardXp is 0 (only the card scored XP)', () => {
        const d = buildXpDistribution({
            leadDoctorId: lead,
            nonCardXp:    0,
            cardXp:       1,
            coTreaterTallies: [
                { userId: 'coA', role: 'DOCTOR', appointmentCount: 10, therapyCount: 8 },
            ],
        });
        expect(d.leadDoctorXp).toBe(1);
        expect(d.coTreaters).toEqual([]);
        expect(d.totalDistributed).toBe(1);
    });

    it('skips would-be co-treater if userId equals leadDoctorId', () => {
        const d = buildXpDistribution({
            leadDoctorId: lead,
            nonCardXp:    6,
            cardXp:       0,
            coTreaterTallies: [
                // Same user appearing as both lead and co-treater (shouldn't happen,
                // but safeguard). Should be filtered out → 100% to lead.
                { userId: lead, role: 'DOCTOR', appointmentCount: 10, therapyCount: 0 },
            ],
        });
        expect(d.leadDoctorXp).toBe(6);
        expect(d.coTreaters).toEqual([]);
    });

    it('always sums to nonCardXp + cardXp regardless of co-treater count or rounding', () => {
        // Property test on a few odd-XP values to make sure rounding never loses
        // or duplicates points.
        for (const nonCardXp of [1, 2, 3, 4, 5, 6]) {
            const d = buildXpDistribution({
                leadDoctorId: lead,
                nonCardXp,
                cardXp: 1,
                coTreaterTallies: [
                    { userId: 'a', role: 'DOCTOR',    appointmentCount: 3, therapyCount: 0 },
                    { userId: 'b', role: 'THERAPIST', appointmentCount: 4, therapyCount: 5 },
                    { userId: 'c', role: 'DOCTOR',    appointmentCount: 5, therapyCount: 0 },
                ],
            });
            expect(d.totalDistributed).toBe(nonCardXp + 1);
        }
    });
});
