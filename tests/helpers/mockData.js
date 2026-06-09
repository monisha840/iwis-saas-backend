/**
 * Shared mock-data factories for the AI feature test suite.
 *
 * Every factory returns a minimal-but-valid object; tests override only the
 * fields they actually care about. Defaults are tuned to be benign — sleep
 * 7h, mood NEUTRAL, painLevel 3, prakriti VATA_PITTA — so a vanilla call
 * produces a "boring patient" with no triggering signals.
 */

let counter = 0;
function id(prefix) {
    counter += 1;
    return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function mockPatient(overrides = {}) {
    const patientId = overrides.id ?? id('pt');
    const userId    = overrides.userId ?? id('u');
    return {
        id: patientId,
        userId,
        fullName: overrides.fullName ?? 'Test Patient',
        branchId: overrides.branchId ?? null,
        onboardingCompleted: overrides.onboardingCompleted ?? true,
        user: {
            hospitalId: overrides.hospitalId ?? 'h-test',
        },
        ...overrides,
    };
}

export function mockDailyCheckIn(overrides = {}) {
    return {
        id: overrides.id ?? id('ci'),
        patientId: overrides.patientId ?? 'pt-1',
        painLevel:     overrides.painLevel     ?? 3,
        sleepHours:    overrides.sleepHours    ?? 7,
        mood:          overrides.mood          ?? 'NEUTRAL',
        mobilityScore: overrides.mobilityScore ?? 5,
        notes:         overrides.notes         ?? null,
        createdAt:     overrides.createdAt     ?? new Date(),
    };
}

export function mockTriageSession(overrides = {}) {
    return {
        id: overrides.id ?? id('ts'),
        patientId:           overrides.patientId           ?? 'pt-1',
        severity:            overrides.severity            ?? 'HIGH',
        suggestedSpecialty:  overrides.suggestedSpecialty  ?? 'General Consultation',
        alternativeSpecialties: overrides.alternativeSpecialties ?? [],
        compositeScore:      overrides.compositeScore      ?? 2.3,
        urgencyLevel:        overrides.urgencyLevel        ?? 'CRITICAL',
        confidenceScore:     overrides.confidenceScore     ?? 0.25,
        inputCompleteness:   overrides.inputCompleteness   ?? 0.5,
        routingMatchStrength: overrides.routingMatchStrength ?? 0,
        redFlagsMatched:     overrides.redFlagsMatched     ?? ['vitals_critical'],
        redFlagForced:       overrides.redFlagForced       ?? true,
        flags:               overrides.flags               ?? ['red_flag_forced'],
        triageNotes:         overrides.triageNotes         ?? 'RED FLAG: Recorded vitals outside safe range',
        isEscalated:         overrides.isEscalated         ?? true,
        reviewCount:         overrides.reviewCount         ?? 0,
        overriddenUrgencyLevel: overrides.overriddenUrgencyLevel ?? null,
        overriddenSpecialty:    overrides.overriddenSpecialty    ?? null,
        overrideReason:         overrides.overrideReason         ?? null,
        branchId:            overrides.branchId            ?? null,
        createdAt:           overrides.createdAt           ?? new Date(),
    };
}

export function mockDoshaForecast(overrides = {}) {
    return {
        id: overrides.id ?? id('df'),
        patientId:      overrides.patientId      ?? 'pt-1',
        generatedAt:    overrides.generatedAt    ?? new Date(),
        daysUntilSymp:  overrides.daysUntilSymp  ?? 14,
        confidence:     overrides.confidence     ?? 0.74,
        dominantDosha:  overrides.dominantDosha  ?? 'VATA',
        imbalanceType:  overrides.imbalanceType  ?? 'AGGRAVATION',
        triggerFactors: overrides.triggerFactors ?? ['Pain rising +0.5/day over 7 days'],
        alertEmitted:   overrides.alertEmitted   ?? false,
        alertEmittedAt: overrides.alertEmittedAt ?? null,
        resolved:       overrides.resolved       ?? false,
        resolvedAt:     overrides.resolvedAt     ?? null,
    };
}

export function mockTongueObservation(overrides = {}) {
    return {
        id: overrides.id ?? id('to'),
        patientId:          overrides.patientId          ?? 'pt-1',
        checkInId:          overrides.checkInId          ?? null,
        photoUrl:           overrides.photoUrl           ?? 'https://example.com/tongue.jpg',
        observedAt:         overrides.observedAt         ?? new Date(),
        aiCoatingColour:    overrides.aiCoatingColour    ?? 'WHITE',
        aiCoatingThickness: overrides.aiCoatingThickness ?? 'THIN',
        aiMoisture:         overrides.aiMoisture         ?? 'NORMAL',
        cracks:             overrides.cracks             ?? false,
        doshaIndication:    overrides.doshaIndication    ?? 'BALANCED',
        confidence:         overrides.confidence         ?? 0.7,
        analysisNotes:      overrides.analysisNotes      ?? 'Healthy pink tongue with thin white coating',
        alertEmitted:       overrides.alertEmitted       ?? false,
    };
}

/**
 * Profile input for nudge `classifyPatient`. Defaults yield LOSS_AVERSE.
 */
export function mockNudgeProfile(overrides = {}) {
    return {
        prakriti:           overrides.prakriti           ?? 'VATA_PITTA',
        streakDays:         overrides.streakDays         ?? 2,
        checkInRate:        overrides.checkInRate        ?? 0.5,
        painTrend:          overrides.painTrend          ?? 0,
        sleepTrend:         overrides.sleepTrend         ?? 0,
        lastCheckInDaysAgo: overrides.lastCheckInDaysAgo ?? 1,
    };
}

/**
 * Convenience: array of N daily check-ins spaced one day apart, newest
 * first, all with the same metric overrides. Useful for the dosha scorer
 * + nudge profile tests.
 */
export function mockCheckInSequence(n, overrides = {}) {
    const out = [];
    const now = Date.now();
    for (let i = 0; i < n; i++) {
        out.push(
            mockDailyCheckIn({
                ...overrides,
                createdAt: new Date(now - i * 24 * 60 * 60 * 1000),
            }),
        );
    }
    return out;
}
