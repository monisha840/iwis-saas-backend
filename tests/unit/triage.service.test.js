import { describe, it, expect } from 'vitest';

// Import the pure scoring function directly
const { computeTriageScore } = await import('../../services/triage.service.js');

describe('Triage Scoring Engine', () => {
    it('single region, low severity → ROUTINE urgency', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'left-knee', regionLabel: 'Left Knee', intensity: 2, characters: ['Aching'], duration: 'Days' }],
            symptoms: [],
            medicalHistory: '',
            existingConditions: [],
            lifestyleData: {},
        });

        expect(result.compositeScore).toBeLessThan(4);
        expect(result.urgencyLevel).toBe('ROUTINE');
        expect(result.suggestedSpecialty).toBeTruthy();
    });

    it('multi-region, high intensity, radiation → URGENT urgency', () => {
        const result = computeTriageScore({
            painRegions: [
                { regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 9, characters: ['Stabbing', 'Numbness'], duration: 'Weeks', radiatesTo: 'left-thigh' },
                { regionId: 'left-hip', regionLabel: 'Left Hip', intensity: 7, characters: ['Aching'], duration: 'Weeks' },
                { regionId: 'left-thigh', regionLabel: 'Left Thigh', intensity: 6, characters: ['Tingling'], duration: 'Weeks' },
            ],
            symptoms: ['Back Pain'],
            medicalHistory: 'chronic back issues',
            existingConditions: ['Hypertension'],
            lifestyleData: { stressLevel: 8, sleepQuality: 2 },
        });

        expect(result.compositeScore).toBeGreaterThanOrEqual(6);
        expect(['URGENT', 'CRITICAL']).toContain(result.urgencyLevel);
        expect(result.flags).toContain('radiation_present');
        expect(result.flags).toContain('high_risk_pain_character');
    });

    it('abdomen + digestive keywords → Gastroenterology specialty', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'abdomen', regionLabel: 'Abdomen', intensity: 5, characters: ['Cramping'], duration: 'Days' }],
            symptoms: ['Stomach Pain', 'bloating'],
            medicalHistory: '',
            existingConditions: [],
            lifestyleData: { bowelRegularity: 'Constipated' },
        });

        expect(result.suggestedSpecialty).toBe('Gastroenterology & Digestive Health');
    });

    it('confidence score is between 0 and 1', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'head', regionLabel: 'Head', intensity: 4, characters: [], duration: 'Hours' }],
        });

        expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
        expect(result.confidenceScore).toBeLessThanOrEqual(1);
    });

    it('missing optional fields do not crash scorer', () => {
        // Minimal input
        const result = computeTriageScore({});

        expect(result.compositeScore).toBeDefined();
        expect(result.urgencyLevel).toBe('ROUTINE');
        expect(result.suggestedSpecialty).toBeTruthy();
        expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
    });

    it('high comorbidities increase score', () => {
        const withoutHistory = computeTriageScore({
            painRegions: [{ regionId: 'chest', intensity: 5, characters: ['Aching'], duration: 'Days' }],
        });

        const withHistory = computeTriageScore({
            painRegions: [{ regionId: 'chest', intensity: 5, characters: ['Aching'], duration: 'Days' }],
            existingConditions: ['Diabetes', 'Hypertension', 'Heart disease'],
            medicalHistory: 'diabetes, heart surgery',
        });

        expect(withHistory.compositeScore).toBeGreaterThan(withoutHistory.compositeScore);
    });

    it('lifestyle flags increase score', () => {
        const baseline = computeTriageScore({
            painRegions: [{ regionId: 'head', intensity: 5, characters: [], duration: 'Weeks' }],
        });

        const stressed = computeTriageScore({
            painRegions: [{ regionId: 'head', intensity: 5, characters: [], duration: 'Weeks' }],
            lifestyleData: { stressLevel: 9, sleepQuality: 1 },
        });

        expect(stressed.compositeScore).toBeGreaterThan(baseline.compositeScore);
        expect(stressed.flags).toContain('high_stress');
        expect(stressed.flags).toContain('poor_sleep');
    });

    it('joint regions route to Orthopaedic specialty', () => {
        const result = computeTriageScore({
            painRegions: [
                { regionId: 'left-knee', regionLabel: 'Left Knee', intensity: 6, characters: ['Aching'], duration: 'Months' },
                { regionId: 'right-knee', regionLabel: 'Right Knee', intensity: 5, characters: [], duration: 'Months' },
            ],
        });

        expect(result.suggestedSpecialty).toBe('Orthopaedic & Joint Care');
    });

    it('head + stress → Mind & Wellness specialty', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'head', regionLabel: 'Head', intensity: 4, characters: [], duration: 'Weeks' }],
            symptoms: ['stress', 'anxiety'],
            lifestyleData: { stressLevel: 8 },
        });

        expect(result.suggestedSpecialty).toBe('Mind & Wellness');
    });
});
