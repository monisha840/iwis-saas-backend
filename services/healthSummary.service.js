/**
 * Patient health-summary aggregator.
 *
 * Single source of truth for the three views that show a patient's current
 * clinical state at a glance:
 *   • Consultation room "Patient Snapshot" card (clinician)
 *   • Patient portal "My Records" tab (patient self-view)
 *   • Health-report PDF (downstream, reads the same underlying tables)
 *
 * Pulls the latest reading per vital type from PatientVital, the patient's
 * ConstitutionProfile row, the latest TriageSession.lifestyleData, and the
 * latest pain regions from triage / daily check-in.
 *
 * Schema footgun noted: PatientVital.patientId references User.id, not
 * Patient.id (schema.prisma:1802). Every other relation here uses Patient.id.
 * We resolve the user id from the patient record once and reuse it.
 */

import prisma from '../lib/prisma.js';

const TRACKED_VITAL_TYPES = [
    'PAIN_SCORE',
    'WEIGHT',
    'SLEEP_HOURS',
    'MOOD',
    'BP_SYSTOLIC',
    'BP_DIASTOLIC',
    'GLUCOSE',
];

function bmiCategoryOf(bmi) {
    if (bmi == null) return null;
    if (bmi < 18.5) return 'Underweight';
    if (bmi < 25)   return 'Normal';
    if (bmi < 30)   return 'Overweight';
    return 'Obese';
}

function pickHeightCm(onboardingData) {
    if (!onboardingData || typeof onboardingData !== 'object') return null;
    const raw = onboardingData.heightCm ?? onboardingData.height ?? onboardingData.heightInCm;
    const n = typeof raw === 'string' ? parseFloat(raw) : raw;
    return typeof n === 'number' && isFinite(n) && n > 0 ? n : null;
}

/**
 * Build the health summary for one patient.
 *
 * @param {string} patientId — Patient.id (NOT User.id).
 * @returns {Promise<object>} the snapshot payload consumed by the FE.
 */
export async function getHealthSummary(patientId) {
    if (!patientId) {
        const e = new Error('patientId is required');
        e.status = 400;
        throw e;
    }

    const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        include: {
            constitutionProfile: true,
        },
    });
    if (!patient) {
        const e = new Error('Patient not found');
        e.status = 404;
        throw e;
    }
    const userId = patient.userId;

    // Latest-per-type vitals. Two data sources contribute:
    //   • PatientVital  — clinician-recorded readings (Quick Intake modal).
    //   • DailyCheckIn  — patient self-reports (pain / sleep / mood).
    // For each vital type we take whichever source has the more recent
    // entry. Each reading carries a `source` label so the FE can show
    // "clinician" vs "self-reported" badges.
    const recent = await prisma.patientVital.findMany({
        where: { patientId: userId, type: { in: TRACKED_VITAL_TYPES } },
        orderBy: { recordedAt: 'desc' },
        take: 50,
    });
    const latestVitals = {};
    for (const v of recent) {
        if (!latestVitals[v.type]) {
            latestVitals[v.type] = {
                value: v.value,
                unit: v.unit,
                recordedAt: v.recordedAt,
                source: v.source === 'manual' || v.source === 'clinician' ? 'clinician' : v.source,
            };
        }
    }

    // Merge in the most recent DailyCheckIn — patient self-report. Whichever
    // source is more recent per vital type wins.
    const latestCheckInForVitals = await prisma.dailyCheckIn.findFirst({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        select: {
            createdAt: true,
            painLevel: true,
            sleepHours: true,
            mood: true,
        },
    });
    if (latestCheckInForVitals) {
        const t = latestCheckInForVitals.createdAt;
        const pickSelfReport = (type, value, unit) => {
            const existing = latestVitals[type];
            if (!existing || new Date(t) > new Date(existing.recordedAt)) {
                latestVitals[type] = { value, unit, recordedAt: t, source: 'self-reported' };
            }
        };
        if (latestCheckInForVitals.painLevel != null) {
            pickSelfReport('PAIN_SCORE', latestCheckInForVitals.painLevel, '/10');
        }
        if (latestCheckInForVitals.sleepHours != null) {
            pickSelfReport('SLEEP_HOURS', latestCheckInForVitals.sleepHours, 'hrs');
        }
        if (latestCheckInForVitals.mood) {
            // Map DailyCheckIn mood strings to the 1-5 scale used by PatientVital.MOOD.
            // Centered on NEUTRAL=3 so HAPPY=4 and SAD=2 round-trip well. Case-
            // insensitive + legacy 'OKAY' kept around so older check-in rows
            // still surface here.
            const moodMap = { SAD: 2, NEUTRAL: 3, OKAY: 3, HAPPY: 4 };
            const numeric = moodMap[String(latestCheckInForVitals.mood).toUpperCase()];
            if (typeof numeric === 'number') {
                pickSelfReport('MOOD', numeric, '/5');
            }
        }
    }

    // Latest triage — its lifestyleData drives the Lifestyle section.
    const latestTriage = await prisma.triageSession.findFirst({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        select: {
            id: true,
            createdAt: true,
            lifestyleData: true,
            painRegions: true,
        },
    });

    // Latest daily check-in (patient self-report). If newer than the triage,
    // prefer its painRegions for the snapshot pain row.
    const latestCheckIn = await prisma.dailyCheckIn.findFirst({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, painRegions: true },
    });

    // Pick the pain regions from whichever source is newer.
    const painRegions = (() => {
        const triageDate = latestTriage?.createdAt?.getTime() ?? 0;
        const checkInDate = latestCheckIn?.createdAt?.getTime() ?? 0;
        if (checkInDate > triageDate && Array.isArray(latestCheckIn?.painRegions)) {
            return latestCheckIn.painRegions;
        }
        if (Array.isArray(latestTriage?.painRegions)) {
            return latestTriage.painRegions;
        }
        return [];
    })();

    // Height: PatientVital doesn't track HEIGHT (not in the enum), so it lives
    // on Patient.onboardingData. Source label tells the FE where it came from.
    const heightCm = pickHeightCm(patient.onboardingData);
    const height = heightCm != null
        ? { cm: heightCm, source: 'intake' }
        : null;

    // Derived: BMI + Ideal Body Weight.
    const weightKg = latestVitals.WEIGHT?.value ?? null;
    let bmi = null;
    if (weightKg != null && heightCm != null) {
        const m = heightCm / 100;
        bmi = Math.round((weightKg / (m * m)) * 10) / 10;
    }
    let idealWeightKg = null;
    if (heightCm != null) {
        const factor = String(patient.gender || '').toUpperCase() === 'MALE' ? 0.9 : 0.85;
        idealWeightKg = Math.round((heightCm - 100) * factor * 10) / 10;
    }

    // Prakriti — canonical ConstitutionProfile row. Resolver name (who assessed)
    // is best-effort; the User table just stores ids, so the FE will resolve
    // the display name from a separate call if it wants pretty attribution.
    const cp = patient.constitutionProfile;
    const prakriti = cp?.prakriti
        ? {
            type:          cp.prakriti,                 // raw enum (e.g. VATA_PITTA)
            display:       cp.prakriti.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            satvaRating:   cp.satvaRating ?? null,
            agniType:      cp.agniType ?? null,
            assessedAt:    cp.completedAt ?? cp.updatedAt,
            assessedBy:    cp.lastUpdatedBy ?? null,
        }
        : null;

    // Lifestyle — pulled from the latest triage. Source label tells the FE
    // whether the values came from a patient-submitted triage or a clinician
    // observation (we'll distinguish those with TriageSession.category later).
    const lifestyle = latestTriage?.lifestyleData && typeof latestTriage.lifestyleData === 'object'
        ? {
            sleepQuality:      latestTriage.lifestyleData.sleepQuality ?? null,
            stressLevel:       latestTriage.lifestyleData.stressLevel ?? null,
            exerciseFrequency: latestTriage.lifestyleData.exerciseFrequency ?? null,
            dietType:          latestTriage.lifestyleData.dietType ?? latestTriage.lifestyleData.dietQuality ?? null,
            recordedAt:        latestTriage.createdAt,
            source:            'triage',
        }
        : null;

    return {
        patientId: patient.id,
        latestVitals,
        height,
        weight: latestVitals.WEIGHT
            ? { kg: latestVitals.WEIGHT.value, recordedAt: latestVitals.WEIGHT.recordedAt }
            : null,
        bmi: bmi != null ? { value: bmi, category: bmiCategoryOf(bmi) } : null,
        idealWeight: idealWeightKg != null ? { kg: idealWeightKg } : null,
        prakriti,
        lifestyle,
        painRegions,
    };
}

/**
 * Recent N readings for one vital type — drives the snapshot popover and the
 * patient-view sparklines.
 *
 * @param {string} patientId — Patient.id.
 * @param {string} vitalType — VitalType enum value.
 * @param {number} limit — defaults to 6.
 */
export async function getVitalHistory(patientId, vitalType, limit = 6) {
    if (!TRACKED_VITAL_TYPES.includes(vitalType)) {
        const e = new Error(`Unsupported vitalType: ${vitalType}`);
        e.status = 400;
        throw e;
    }
    const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { userId: true },
    });
    if (!patient) {
        const e = new Error('Patient not found');
        e.status = 404;
        throw e;
    }
    const rows = await prisma.patientVital.findMany({
        where: { patientId: patient.userId, type: vitalType },
        orderBy: { recordedAt: 'desc' },
        take: Math.max(1, Math.min(50, limit)),
        select: { value: true, unit: true, recordedAt: true, source: true },
    });
    return rows;
}
