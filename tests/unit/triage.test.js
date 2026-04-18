import { describe, it, expect } from 'vitest';
import { computeTriageScore } from '../../services/triage.service.js';

describe('Triage Scoring Engine', () => {
    it('should return ROUTINE for low pain with no risk factors', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'left-knee', regionLabel: 'Left Knee', intensity: 2, duration: 'Days' }],
            painSeverity: 2,
            duration: 'Days',
            symptoms: [],
            medicalHistory: '',
            existingConditions: [],
            lifestyleData: {},
        });

        expect(result.urgencyLevel).toBe('ROUTINE');
        expect(result.compositeScore).toBeLessThan(4);
        expect(result.classification).toBe('Routine');
        expect(result.reasoning).toBeTruthy();
        expect(result.reasoning.length).toBeGreaterThan(20);
    });

    it('should return URGENT or CRITICAL for high pain with multiple risk factors', () => {
        const result = computeTriageScore({
            painRegions: [
                { regionId: 'chest', regionLabel: 'Chest', intensity: 9, duration: 'Hours', characters: ['Stabbing'], radiatesTo: 'left-arm' },
                { regionId: 'left-arm', regionLabel: 'Left Arm', intensity: 7, duration: 'Hours' },
            ],
            painSeverity: 9,
            duration: 'Hours',
            symptoms: ['chest', 'breathing'],
            medicalHistory: 'heart disease, diabetes',
            existingConditions: ['Diabetes', 'Heart disease'],
            lifestyleData: { stressLevel: 9, sleepQuality: 1 },
        });

        expect(['URGENT', 'CRITICAL']).toContain(result.urgencyLevel);
        expect(result.compositeScore).toBeGreaterThanOrEqual(6);
        expect(result.classification).toBe('Escalation Required');
        expect(result.flags).toContain('high_risk_pain_character');
        expect(result.flags).toContain('radiation_present');
        expect(result.flags).toContain('comorbidities');
    });

    it('should suggest correct specialty for joint pain', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'left-knee', regionLabel: 'Left Knee', intensity: 5, duration: 'Weeks' }],
            symptoms: ['joint', 'knee'],
        });

        expect(result.suggestedSpecialty).toContain('Orthopaedic');
    });

    it('should suggest correct specialty for digestive issues', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'abdomen', regionLabel: 'Abdomen', intensity: 5, duration: 'Days' }],
            symptoms: ['digestive', 'bloating'],
        });

        expect(result.suggestedSpecialty).toContain('Gastroenterology');
    });

    it('should calculate confidence score based on input completeness', () => {
        const minimal = computeTriageScore({
            painRegions: [],
            painSeverity: 3,
        });
        const complete = computeTriageScore({
            painRegions: [{ regionId: 'back', regionLabel: 'Back', intensity: 5, duration: 'Weeks', characters: ['Aching'] }],
            painSeverity: 5,
            duration: 'Weeks',
            medicalHistory: 'diabetes',
            existingConditions: ['Diabetes'],
            lifestyleData: { stressLevel: 5, sleepQuality: 4 },
        });

        expect(complete.confidenceScore).toBeGreaterThan(minimal.confidenceScore);
    });

    it('should flag chronic pain pattern', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 7, duration: 'Over a year' }],
        });

        expect(result.flags).toContain('chronic_pain');
    });

    it('should include reasoning with specialty recommendation', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'head', regionLabel: 'Head', intensity: 6, duration: 'Months' }],
            lifestyleData: { stressLevel: 8, sleepQuality: 2 },
        });

        expect(result.reasoning).toContain(result.suggestedSpecialty);
        expect(result.reasoning).toContain('composite score');
    });
});
