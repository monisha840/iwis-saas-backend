import { describe, it, expect } from 'vitest';

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

    it('multi-region, high intensity, radiation → URGENT or higher', () => {
        const result = computeTriageScore({
            painRegions: [
                { regionId: 'lower-back', regionLabel: 'Lower Back', intensity: 9, characters: ['Stabbing', 'Numbness'], duration: 'Weeks', radiatesTo: 'left-thigh' },
                { regionId: 'left-hip',   regionLabel: 'Left Hip',  intensity: 7, characters: ['Aching'],              duration: 'Weeks' },
                { regionId: 'left-thigh', regionLabel: 'Left Thigh',intensity: 6, characters: ['Tingling'],            duration: 'Weeks' },
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
            symptoms: ['stomach', 'bloating'],
            medicalHistory: '',
            existingConditions: [],
            lifestyleData: { bowelRegularity: 'Constipated' },
        });

        expect(result.suggestedSpecialty).toBe('Gastroenterology & Digestive Health');
    });

    it('confidence scores are bounded and split', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'head', regionLabel: 'Head', intensity: 4, characters: [], duration: 'Hours' }],
        });

        expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
        expect(result.confidenceScore).toBeLessThanOrEqual(1);
        expect(result.inputCompleteness).toBeGreaterThanOrEqual(0);
        expect(result.inputCompleteness).toBeLessThanOrEqual(1);
        expect(result.routingMatchStrength).toBeGreaterThanOrEqual(0);
        expect(result.routingMatchStrength).toBeLessThanOrEqual(1);
    });

    it('missing optional fields do not crash scorer', () => {
        const result = computeTriageScore({});
        expect(result.compositeScore).toBeDefined();
        expect(result.urgencyLevel).toBe('ROUTINE');
        expect(result.suggestedSpecialty).toBeTruthy();
        expect(result.redFlagsMatched).toEqual([]);
        expect(result.redFlagForced).toBe(false);
    });

    it('high comorbidities increase score', () => {
        const baseline = computeTriageScore({
            painRegions: [{ regionId: 'knee', intensity: 5, characters: ['Aching'], duration: 'Days' }],
        });
        const withHistory = computeTriageScore({
            painRegions: [{ regionId: 'knee', intensity: 5, characters: ['Aching'], duration: 'Days' }],
            existingConditions: ['Diabetes', 'Hypertension', 'Heart disease'],
            medicalHistory: 'diabetes, heart surgery',
        });
        expect(withHistory.compositeScore).toBeGreaterThan(baseline.compositeScore);
    });

    it('lifestyle flags increase score', () => {
        const baseline = computeTriageScore({
            painRegions: [{ regionId: 'upper-back', intensity: 5, characters: [], duration: 'Weeks' }],
        });
        const stressed = computeTriageScore({
            painRegions: [{ regionId: 'upper-back', intensity: 5, characters: [], duration: 'Weeks' }],
            lifestyleData: { stressLevel: 9, sleepQuality: 1 },
        });
        expect(stressed.compositeScore).toBeGreaterThan(baseline.compositeScore);
        expect(stressed.flags).toContain('high_stress');
        expect(stressed.flags).toContain('poor_sleep');
    });

    it('joint regions route to Orthopaedic specialty', () => {
        const result = computeTriageScore({
            painRegions: [
                { regionId: 'left-knee',  regionLabel: 'Left Knee',  intensity: 6, characters: ['Aching'], duration: 'Months' },
                { regionId: 'right-knee', regionLabel: 'Right Knee', intensity: 5, characters: [],         duration: 'Months' },
            ],
        });
        expect(result.suggestedSpecialty).toBe('Orthopaedic & Joint Care');
    });
});

describe('Red-Flag Override Rules', () => {
    it('chest pain radiating to arm forces CRITICAL regardless of score', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'chest', intensity: 4, characters: [], duration: 'Hours', radiatesTo: 'left-arm' }],
        });
        expect(result.urgencyLevel).toBe('CRITICAL');
        expect(result.redFlagForced).toBe(true);
        expect(result.redFlagsMatched).toContain('chest_pain_with_radiation');
    });

    it('sudden severe headache → thunderclap red flag', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'head', intensity: 9, characters: ['Stabbing'], duration: 'Just started' }],
            onsetPattern: 'Sudden',
        });
        expect(result.urgencyLevel).toBe('CRITICAL');
        expect(result.redFlagsMatched).toContain('sudden_severe_headache');
    });

    it('unilateral numbness → stroke red flag', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'left-arm', intensity: 3, characters: ['Numbness'], duration: 'Hours' }],
        });
        expect(result.urgencyLevel).toBe('CRITICAL');
        expect(result.redFlagsMatched).toContain('unilateral_weakness_or_numbness');
    });

    it('pregnancy + severe abdominal pain → red flag', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'abdomen', intensity: 8, characters: [], duration: 'Hours' }],
            patient: { onboardingData: { pregnant: true } },
        });
        expect(result.redFlagsMatched).toContain('pregnancy_bleeding_or_severe_abdominal');
        expect(result.urgencyLevel).toBe('CRITICAL');
    });

    it('anaphylaxis signs force CRITICAL', () => {
        const result = computeTriageScore({
            symptoms: ['allergic reaction', 'throat swelling', 'shortness of breath'],
            painRegions: [],
        });
        expect(result.redFlagsMatched).toContain('anaphylaxis_signs');
    });

    it('suicidal ideation flag forces CRITICAL', () => {
        const result = computeTriageScore({
            lifestyleData: { suicidalIdeation: true },
        });
        expect(result.redFlagsMatched).toContain('suicidal_ideation');
        expect(result.urgencyLevel).toBe('CRITICAL');
    });

    it('critical vitals (SpO2 ≤ 92) force CRITICAL', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'knee', intensity: 2, duration: 'Days' }],
            recentVitals: { SPO2: 88 },
        });
        expect(result.redFlagsMatched).toContain('vitals_critical');
        expect(result.urgencyLevel).toBe('CRITICAL');
    });

    it('no red flag inputs → no red flag fired', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'knee', intensity: 3, duration: 'Days' }],
        });
        expect(result.redFlagForced).toBe(false);
        expect(result.redFlagsMatched).toEqual([]);
    });
});

describe('Duration handling', () => {
    it('picks the longest duration across regions', () => {
        const result = computeTriageScore({
            painRegions: [
                { regionId: 'knee', intensity: 5, duration: 'Hours' },
                { regionId: 'back', intensity: 5, duration: 'Months' },
            ],
        });
        // durationScore for 'Months' = 7, for 'Hours' = 4; we must pick the worst
        expect(result.breakdown.durationScore).toBeGreaterThanOrEqual(7);
    });

    it('acute + chronic regions → acute_on_chronic flag', () => {
        const result = computeTriageScore({
            painRegions: [
                { regionId: 'knee', intensity: 5, duration: 'Just started' },
                { regionId: 'back', intensity: 5, duration: 'Months' },
            ],
        });
        expect(result.flags).toContain('acute_on_chronic');
    });
});

describe('Condition × Symptom interactions', () => {
    it('Diabetes + chest pain adds interaction boost', () => {
        const baseline = computeTriageScore({
            painRegions: [{ regionId: 'chest', intensity: 5, duration: 'Days' }],
        });
        const interacted = computeTriageScore({
            painRegions: [{ regionId: 'chest', intensity: 5, duration: 'Days' }],
            existingConditions: ['Diabetes'],
        });
        expect(interacted.flags).toContain('interaction_diabetes_chest');
        expect(interacted.compositeScore).toBeGreaterThan(baseline.compositeScore);
    });

    it('Asthma + breathing symptoms triggers respiratory interaction', () => {
        const result = computeTriageScore({
            existingConditions: ['Asthma'],
            symptoms: ['shortness of breath', 'wheeze'],
            painRegions: [],
        });
        expect(result.flags).toContain('interaction_asthma_respiratory');
    });

    it('thyroid + knee pain does NOT trigger chest-specific interaction', () => {
        const result = computeTriageScore({
            existingConditions: ['Thyroid'],
            painRegions: [{ regionId: 'knee', intensity: 4, duration: 'Days' }],
        });
        expect(result.flags).not.toContain('interaction_htn_chest_or_head');
        expect(result.flags).not.toContain('interaction_cardiac_chest');
    });
});

describe('Age / vitals modifiers', () => {
    it('elderly patient with moderate pain gets elderly_with_pain flag', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'back', intensity: 6, duration: 'Days' }],
            patient: { age: 72 },
        });
        expect(result.flags).toContain('elderly_with_pain');
        expect(result.breakdown.ageBoost).toBeGreaterThan(0);
    });

    it('paediatric patient with moderate pain gets paediatric_concern flag', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'abdomen', intensity: 5, duration: 'Hours' }],
            patient: { age: 4 },
        });
        expect(result.flags).toContain('paediatric_concern');
    });

    it('mild out-of-range vitals add continuous boost without forcing CRITICAL', () => {
        const result = computeTriageScore({
            painRegions: [{ regionId: 'knee', intensity: 4, duration: 'Days' }],
            recentVitals: { BP_SYSTOLIC: 165, SPO2: 94 },
        });
        expect(result.urgencyLevel).not.toBe('CRITICAL');
        expect(result.compositeScore).toBeGreaterThan(3);
    });
});

describe('DB-backed specialty routing', () => {
    it('routes according to injected specialtyRoutes', () => {
        const routes = [
            { specialty: 'Custom Clinic', tags: ['knee', 'shoulder'], priority: 100 },
            { specialty: 'Orthopaedic & Joint Care', tags: ['knee', 'shoulder'], priority: 10 },
        ];
        const result = computeTriageScore({
            painRegions: [{ regionId: 'knee', regionLabel: 'Knee', intensity: 5, duration: 'Days' }],
            specialtyRoutes: routes,
        });
        // Same match count but higher priority wins
        expect(result.suggestedSpecialty).toBe('Custom Clinic');
    });

    it('uses exact-tag match, not substring', () => {
        // Naive substring matching would let "head" match anywhere. With exact-tag match,
        // a symptom array of ['ahead'] must NOT route to Mind & Wellness.
        const result = computeTriageScore({
            painRegions: [{ regionId: 'forearm', intensity: 3, duration: 'Days' }],
            symptoms: ['ahead'],
        });
        expect(result.suggestedSpecialty).not.toBe('Mind & Wellness');
    });
});
