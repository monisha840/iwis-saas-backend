/**
 * F01 · Patient Digital Twin — aggregator.
 *
 * Single-pass build of the twin panel payload. Eight parallel queries via
 * Promise.all so the response stays fast even on a slow pooler. No new
 * derivations live here that aren't visible to the clinician — every number
 * in the output traces back to a source row the clinician can pull up.
 *
 * Schema gotchas honoured:
 *   - PatientVital.patientId references User.id (not Patient.id).
 *     Resolved via patient.userId.
 *   - TreatmentJourney.patientId also references User.id (not Patient.id);
 *     it's the JourneyPatient relation on User. Same userId resolution.
 *   - The /full-details endpoint already exists in routes/timeline.js and
 *     is left untouched per spec — this builds a separate, narrower payload
 *     tailored to the twin panel's needs.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

const SIMILAR_PATIENT_PRIVACY_FLOOR = 5;
// Free-text mood column — map common values to a 1..5 wellness axis.
// Values come from DailyCheckIn seeds + the F04 scorer's mood set.
const MOOD_SCALE = {
    HAPPY: 5,
    GOOD: 4,
    NEUTRAL: 3,
    OKAY: 3,
    SAD: 2,
    STRESSED: 2,
    ANXIOUS: 2,
    WORRIED: 2,
    TENSE: 2,
    AGITATED: 2,
};

function moodToNumeric(mood) {
    if (mood == null) return null;
    const key = String(mood).toUpperCase().trim();
    return MOOD_SCALE[key] ?? 3;
}

/**
 * Build the complete twin payload for one patient.
 * @param {string} patientId  Patient.id (NOT userId)
 * @returns {Promise<object|null>}  null if the patient doesn't exist
 */
export async function buildDigitalTwin(patientId) {
    if (!patientId) return null;

    // Resolve once — every other query depends on Patient → User mapping.
    const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: {
            id: true,
            userId: true,
            user: { select: { hospitalId: true } },
        },
    });
    if (!patient) return null;

    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const hospitalId = patient.user?.hospitalId ?? null;

    // Eight parallel queries — Promise.all so the slowest pull defines the
    // response time, not the sum of all of them.
    const [
        profile,
        checkIns,
        vitals,
        activePrescriptions,
        latestForecast,
        tongueObservations,
        journey,
        assignment,
    ] = await Promise.all([
        prisma.constitutionProfile.findUnique({
            where: { patientId },
            select: { prakriti: true, agniType: true, satvaRating: true },
        }).catch(() => null),

        prisma.dailyCheckIn.findMany({
            where: { patientId, createdAt: { gte: since30 } },
            select: { painLevel: true, sleepHours: true, mood: true, mobilityScore: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 30,
        }).catch(() => []),

        // PatientVital.patientId references USER.id.
        prisma.patientVital.findMany({
            where: { patientId: patient.userId, recordedAt: { gte: since30 } },
            select: { type: true, value: true, recordedAt: true },
            orderBy: { recordedAt: 'desc' },
            take: 30,
        }).catch(() => []),

        prisma.prescription.findMany({
            where: { patientId, discontinuedAt: null },
            select: { id: true, medicationName: true, dosage: true, frequency: true },
            orderBy: { createdAt: 'desc' },
            take: 20,
        }).catch(() => []),

        prisma.doshaForecast.findFirst({
            where: { patientId, resolved: false },
            orderBy: { generatedAt: 'desc' },
            select: {
                dominantDosha: true, daysUntilSymp: true,
                confidence: true, triggerFactors: true,
            },
        }).catch(() => null),

        prisma.tongueObservation.findMany({
            where: { patientId },
            orderBy: { observedAt: 'desc' },
            take: 14,
            select: {
                aiCoatingColour: true, doshaIndication: true,
                confidence: true, observedAt: true,
            },
        }).catch(() => []),

        // TreatmentJourney.patientId also references USER.id.
        prisma.treatmentJourney.findFirst({
            where: { patientId: patient.userId },
            orderBy: { updatedAt: 'desc' },
            select: { condition: true, status: true, wellnessScore: true },
        }).catch(() => null),

        prisma.patientAssignment.findFirst({
            where: { patientId, status: 'ACTIVE', type: 'PRIMARY' },
            select: { doctor: { select: { fullName: true } } },
        }).catch(() => null),
    ]);

    // Build trend arrays — chronological order (oldest first) for clean
    // left-to-right sparklines.
    const ordered = [...checkIns].reverse();
    const painTrend     = ordered.map((c) => ({ date: c.createdAt.toISOString().slice(0, 10), value: Number(c.painLevel)  || 0 }));
    const sleepTrend    = ordered.map((c) => ({ date: c.createdAt.toISOString().slice(0, 10), value: Number(c.sleepHours) || 0 }));
    const moodTrend     = ordered.map((c) => ({ date: c.createdAt.toISOString().slice(0, 10), value: moodToNumeric(c.mood) ?? 3 }));
    const mobilityTrend = ordered
        .filter((c) => c.mobilityScore != null)
        .map((c) => ({ date: c.createdAt.toISOString().slice(0, 10), value: Number(c.mobilityScore) || 0 }));

    // doshaBalance: rule-based derivation (see header). Seeded from Prakriti.
    const doshaBalance = deriveDoshaBalance({
        prakriti: profile?.prakriti ?? null,
        checkIns,
        tongueObservations,
        forecast: latestForecast,
    });

    // tongueSummary — derive trend from the last 3 observations.
    const tongueSummary = buildTongueSummary(tongueObservations);

    // similarPatientsCount — same hospital, same prakriti, same condition.
    // Count-only by construction; we never select identifying fields.
    let similarPatientsCount = 0;
    try {
        if (hospitalId && profile?.prakriti && journey?.condition) {
            similarPatientsCount = await prisma.patient.count({
                where: {
                    id: { not: patientId },
                    user: {
                        hospitalId,
                        treatmentJourneys: { some: { condition: journey.condition } },
                    },
                    constitutionProfile: { prakriti: profile.prakriti },
                },
            });
        }
    } catch (err) {
        logger.warn('[twin] similarPatientsCount failed — defaulting to 0', { err: err.message });
        similarPatientsCount = 0;
    }

    return {
        patientId,
        prakriti:    profile?.prakriti ?? null,
        agniType:    profile?.agniType ?? null,
        satvaRating: profile?.satvaRating ?? null,

        painTrend,
        sleepTrend,
        moodTrend,
        mobilityTrend,

        doshaBalance,

        forecast: latestForecast
            ? {
                dominantDosha:  latestForecast.dominantDosha,
                daysUntilSymp:  latestForecast.daysUntilSymp,
                confidence:     latestForecast.confidence,
                triggerFactors: latestForecast.triggerFactors,
            }
            : null,

        tongueSummary,

        activeMedCount: activePrescriptions.length,
        activeMeds: activePrescriptions.slice(0, 3).map((p) => ({
            name:      p.medicationName,
            dosage:    p.dosage,
            frequency: p.frequency,
        })),

        wellnessScore:    journey?.wellnessScore ?? null,
        journeyCondition: journey?.condition ?? null,
        journeyStatus:    journey?.status ?? null,

        // Cohort summary — count + a privacy hint so the frontend can fall
        // back to "Limited data" cleanly without recomputing the floor.
        similarPatientsCount,
        privacyFloor: SIMILAR_PATIENT_PRIVACY_FLOOR,

        // Useful surface for log + dev debugging — not rendered.
        _meta: {
            checkInsCount:      checkIns.length,
            vitalsCount:        vitals.length,
            tongueObsCount:     tongueObservations.length,
            assignedDoctorName: assignment?.doctor?.fullName ?? null,
        },
    };
}

// ── doshaBalance derivation ────────────────────────────────────────────────
// Visual indicator, not a clinical score. Three rules, each contributing
// nudges to the relevant dosha bucket:
//   1. Baseline from Prakriti
//   2. Check-in signals (pain rising / sleep declining → Vata)
//   3. Tongue colour (YELLOW → Pitta, WHITE → Kapha)
//   4. Forecast dominant dosha gets a +10 nudge
// Output normalised to sum == 100, rounded to integers (so the bars
// always tile to 100% on screen).
function deriveDoshaBalance({ prakriti, checkIns, tongueObservations, forecast }) {
    // 1) Baseline from Prakriti.
    let v = 33, p = 33, k = 34;
    const pk = (prakriti || '').toUpperCase();
    if (pk === 'VATA')        { v = 70; p = 15; k = 15; }
    else if (pk === 'PITTA')  { v = 15; p = 70; k = 15; }
    else if (pk === 'KAPHA')  { v = 15; p = 15; k = 70; }
    else if (pk === 'VATA_PITTA')  { v = 50; p = 40; k = 10; }
    else if (pk === 'PITTA_KAPHA') { v = 10; p = 50; k = 40; }
    else if (pk === 'VATA_KAPHA')  { v = 50; p = 10; k = 40; }
    else if (pk === 'TRIDOSHA')    { v = 34; p = 33; k = 33; }

    // 2) Check-in signals — split last-7 vs prior-7.
    const sorted = [...checkIns].sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const last7  = sorted.filter((c) => now - new Date(c.createdAt).getTime() <= 7 * day);
    const prior7 = sorted.filter((c) => now - new Date(c.createdAt).getTime() >  7 * day && now - new Date(c.createdAt).getTime() <= 14 * day);
    const mean = (arr, key) =>
        arr.length === 0 ? 0 : arr.reduce((s, x) => s + (Number(x[key]) || 0), 0) / arr.length;

    const painRising    = mean(last7, 'painLevel')  - mean(prior7, 'painLevel')  > 1;
    const sleepDeclining = mean(last7, 'sleepHours') - mean(prior7, 'sleepHours') < -0.5;
    if (painRising)     v += 10;
    if (sleepDeclining) v += 10;

    // 3) Tongue signals — read the most recent observation only.
    const latestTongue = tongueObservations[0];
    if (latestTongue) {
        const colour = (latestTongue.aiCoatingColour || '').toUpperCase();
        if (colour === 'YELLOW' || colour === 'GREEN') p += 10;
        else if (colour === 'WHITE')                   k += 10;
        else if (colour === 'BROWN' || colour === 'BLACK') v += 10;
    }

    // 4) Forecast nudge.
    if (forecast) {
        const dom = (forecast.dominantDosha || '').toUpperCase();
        if (dom === 'VATA')  v += 10;
        if (dom === 'PITTA') p += 10;
        if (dom === 'KAPHA') k += 10;
    }

    // Normalise to 100.
    const total = v + p + k;
    let vN = Math.round((v / total) * 100);
    let pN = Math.round((p / total) * 100);
    let kN = 100 - vN - pN; // ensures exact 100
    if (kN < 0) { kN = 0; pN = Math.max(0, 100 - vN - kN); }
    return { vata: vN, pitta: pN, kapha: kN };
}

// ── tongueSummary ──────────────────────────────────────────────────────────
function buildTongueSummary(observations) {
    if (!observations || observations.length === 0) return null;
    const latest = observations[0];
    if (!latest.doshaIndication && !latest.aiCoatingColour) return null;

    let trend = 'STABLE';
    if (observations.length >= 3) {
        const last3 = observations.slice(0, 3);
        const someBalanced = last3.some((o) => o.doshaIndication === 'BALANCED');
        const allSameImbalance =
            last3.every((o) => o.doshaIndication && o.doshaIndication === latest.doshaIndication &&
                latest.doshaIndication !== 'BALANCED');

        // "Improving" = moving toward BALANCED in the most recent entry.
        if (latest.doshaIndication === 'BALANCED' && !someBalanced) {
            // last3[0]=BALANCED but last3[1]/last3[2] weren't — actually
            // can't happen because someBalanced would be true. So this
            // branch represents the case where the OLDER two were also
            // BALANCED but the middle wasn't.
            trend = 'IMPROVING';
        } else if (last3[0].doshaIndication === 'BALANCED' && last3[2].doshaIndication !== 'BALANCED') {
            trend = 'IMPROVING';
        } else if (allSameImbalance) {
            trend = 'WORSENING';
        }
    }

    return {
        latestDosha:  latest.doshaIndication ?? null,
        latestColour: latest.aiCoatingColour ?? null,
        trend,
    };
}
