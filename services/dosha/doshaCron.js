/**
 * F04 · Predictive Dosha Imbalance Engine — nightly cron.
 *
 * Per-hospital flag gate → per-patient scorer → DoshaForecast row →
 * PatientCriticalFlag upsert → assigned-doctor notification.
 *
 * Schema gotchas honoured:
 *   • PatientVital.patientId references User.id, NOT Patient.id. Resolved
 *     via patient.userId for every vital query.
 *   • DailyCheckIn.patientId references Patient.id (the normal pattern).
 *
 * Idempotency: a same-day re-run never produces a second DoshaForecast row
 * — we short-circuit if a forecast exists with generatedAt >= startOfDay.
 *
 * Resilience: every per-patient block is wrapped in try/catch. One failure
 * never stops the loop.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { enqueueInAppNotification } from '../queue.service.js';
import { scorePatient } from './doshaScorer.js';

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// IST is UTC+5:30 — derive season from the IST month so a non-IST host
// (Render, Vercel) still gets the right Indian-calendar bucket.
function currentSeasonIST(now = new Date()) {
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
    const month = new Date(istMs).getUTCMonth(); // 0..11
    if (month === 11 || month <= 1) return 'WINTER'; // Dec, Jan, Feb
    if (month >= 2 && month <= 4)   return 'SPRING'; // Mar, Apr, May
    if (month >= 5 && month <= 7)   return 'MONSOON';// Jun, Jul, Aug
    return 'AUTUMN'; // Sep, Oct, Nov
}

function startOfDay(d = new Date()) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

export async function runDoshaForecastCron() {
    const startedAt = new Date();
    const today = startOfDay();
    const season = currentSeasonIST(startedAt);
    logger.info('[dosha-cron] start', { startedAt: startedAt.toISOString(), season });

    // 1) Hospitals with the PREDICTIVE_DOSHA_ENGINE flag enabled.
    let hospitalIds = [];
    try {
        const flags = await prisma.hospitalFeatureFlag.findMany({
            where: { featureKey: 'PREDICTIVE_DOSHA_ENGINE', enabled: true },
            select: { hospitalId: true },
        });
        hospitalIds = flags.map((f) => f.hospitalId);
    } catch (err) {
        logger.error('[dosha-cron] flag lookup failed — aborting run', { err: err.message });
        return { processed: 0, alerted: 0, failed: 0, hospitals: 0 };
    }
    if (hospitalIds.length === 0) {
        logger.info('[dosha-cron] no hospitals have PREDICTIVE_DOSHA_ENGINE enabled — nothing to do');
        return { processed: 0, alerted: 0, failed: 0, hospitals: 0 };
    }

    // 2) For each enabled hospital, fetch the active patients we need to
    //    score. Active = has an ACTIVE primary assignment (mirrors the
    //    invariant used everywhere else in the codebase).
    //    NOTE: we resolve patients via the User → hospitalId path because
    //    Patient itself has no hospitalId column.
    let patients = [];
    try {
        patients = await prisma.patient.findMany({
            where: {
                user: { hospitalId: { in: hospitalIds } },
                patientAssignments: { some: { status: 'ACTIVE' } },
                onboardingCompleted: true,
            },
            select: {
                id: true,
                userId: true,
                fullName: true,
                branchId: true,
                user: { select: { hospitalId: true } },
            },
        });
    } catch (err) {
        logger.error('[dosha-cron] patient lookup failed — aborting run', { err: err.message });
        return { processed: 0, alerted: 0, failed: 0, hospitals: hospitalIds.length };
    }
    logger.info('[dosha-cron] patient pool', { hospitals: hospitalIds.length, patients: patients.length });

    let processed = 0;
    let alerted   = 0;
    let failed    = 0;

    for (let batchStart = 0; batchStart < patients.length; batchStart += BATCH_SIZE) {
        const batch = patients.slice(batchStart, batchStart + BATCH_SIZE);
        for (const patient of batch) {
            try {
                const wasAlerted = await processOne(patient, { today, season });
                processed += 1;
                if (wasAlerted) alerted += 1;
            } catch (err) {
                failed += 1;
                logger.warn('[dosha-cron] per-patient failure — continuing', {
                    patientId: patient.id, err: err.message,
                });
            }
        }
        if (batchStart + BATCH_SIZE < patients.length) {
            await sleep(BATCH_DELAY_MS);
        }
    }

    const finishedAt = new Date();
    logger.info('[dosha-cron] complete', {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        elapsedMs: finishedAt.getTime() - startedAt.getTime(),
        season,
        hospitals: hospitalIds.length,
        patients: patients.length,
        processed, alerted, failed,
    });
    return { hospitals: hospitalIds.length, patients: patients.length, processed, alerted, failed };
}

async function processOne(patient, { today, season }) {
    // Idempotency: a same-day re-run must not double-write.
    const existing = await prisma.doshaForecast.findFirst({
        where: { patientId: patient.id, generatedAt: { gte: today } },
        select: { id: true, alertEmitted: true, dominantDosha: true, daysUntilSymp: true, confidence: true },
    });
    if (existing) {
        logger.debug('[dosha-cron] forecast already exists for today — skipping', {
            patientId: patient.id, forecastId: existing.id,
        });
        return existing.alertEmitted;
    }

    // Build scorer input.
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [constitution, checkIns, vitals, activeRx] = await Promise.all([
        prisma.constitutionProfile.findUnique({
            where: { patientId: patient.id }, select: { prakriti: true },
        }).catch(() => null),
        prisma.dailyCheckIn.findMany({
            where: { patientId: patient.id, createdAt: { gte: since30 } },
            select: { painLevel: true, sleepHours: true, mood: true, mobilityScore: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 30,
        }).catch(() => []),
        // PatientVital.patientId references USER.id (not Patient.id).
        // This is the schema gotcha the spec warned about — resolved here.
        prisma.patientVital.findMany({
            where: { patientId: patient.userId, recordedAt: { gte: since30 } },
            select: { type: true, value: true, recordedAt: true },
            orderBy: { recordedAt: 'desc' },
            take: 30,
        }).catch(() => []),
        prisma.prescription.count({
            where: { patientId: patient.id, discontinuedAt: null },
        }).catch(() => 0),
    ]);

    const result = scorePatient({
        prakriti: constitution?.prakriti ?? null,
        checkIns,
        vitals,
        activePrescriptions: activeRx,
        season,
    });

    if (!result.shouldAlert) {
        logger.debug('[dosha-cron] sub-threshold — no record written', {
            patientId: patient.id,
            scores: result._scores,
            dominantDosha: result.dominantDosha,
        });
        return false;
    }

    // 3) Write DoshaForecast row first so we have an audit trail before any
    //    downstream side-effect (PatientCriticalFlag upsert, notification).
    const forecast = await prisma.doshaForecast.create({
        data: {
            patientId:      patient.id,
            daysUntilSymp:  result.daysUntilSymp,
            confidence:     result.confidence,
            dominantDosha:  result.dominantDosha,
            imbalanceType:  result.imbalanceType,
            triggerFactors: result.triggerFactors,
            alertEmitted:   false, // flipped to true at the end
        },
        select: { id: true },
    });

    // 4) Merge into PatientCriticalFlag (same pattern F07 careGapAgent uses).
    let existingFlag = null;
    try {
        existingFlag = await prisma.patientCriticalFlag.findUnique({
            where: { patientId: patient.id },
            select: { id: true, reasons: true, severity: true },
        });
    } catch (err) {
        logger.warn('[dosha-cron] PatientCriticalFlag lookup failed — continuing without merge', {
            patientId: patient.id, err: err.message,
        });
    }

    const incomingReason = {
        type: 'DOSHA_IMBALANCE_FORECAST',
        dominantDosha:  result.dominantDosha,
        daysUntilSymp:  result.daysUntilSymp,
        confidence:     result.confidence,
        triggerFactors: result.triggerFactors,
        forecastId:     forecast.id,
        detectedAt:     new Date().toISOString(),
    };
    const priorReasons = Array.isArray(existingFlag?.reasons) ? existingFlag.reasons : [];
    const mergedReasons = priorReasons
        .filter((r) => r?.type !== 'DOSHA_IMBALANCE_FORECAST')
        .concat(incomingReason);

    try {
        await prisma.patientCriticalFlag.upsert({
            where: { patientId: patient.id },
            create: {
                patientId: patient.id,
                branchId:  patient.branchId ?? null,
                severity:  'MEDIUM',
                reasons:   mergedReasons,
                notes:     'Predictive Dosha alert — review patient trajectory',
                status:    'ACTIVE',
            },
            update: {
                // Don't demote a HIGH (e.g. critical-triage) flag to MEDIUM —
                // only raise. F07 careGapAgent uses HIGH for triage; this
                // detector is a softer signal.
                ...(existingFlag?.severity === 'HIGH' ? {} : { severity: 'MEDIUM' }),
                reasons:        mergedReasons,
                lastDetectedAt: new Date(),
                status:         'ACTIVE',
                resolvedAt:     null,
                resolvedById:   null,
            },
        });
    } catch (err) {
        logger.warn('[dosha-cron] PatientCriticalFlag upsert failed', {
            patientId: patient.id, err: err.message,
        });
    }

    // 5) Notify the assigned doctor.
    let notified = false;
    try {
        const assignment = await prisma.patientAssignment.findFirst({
            where: { patientId: patient.id, status: 'ACTIVE', type: 'PRIMARY' },
            select: { doctor: { select: { userId: true } } },
        });
        const userId = assignment?.doctor?.userId ?? null;
        if (userId) {
            const confidencePct = Math.round(result.confidence * 100);
            await enqueueInAppNotification({
                userId,
                title: 'Dosha imbalance forecast',
                body:  `${patient.fullName ?? 'Patient'} — ${result.dominantDosha} aggravation forecast within ${result.daysUntilSymp} days (confidence ${confidencePct}%)`,
                type:  'DOSHA_FORECAST_ALERT',
                relatedId: forecast.id,
            });
            notified = true;
        }
    } catch (err) {
        logger.warn('[dosha-cron] notification enqueue failed', {
            patientId: patient.id, err: err.message,
        });
    }

    // 6) Mark the forecast as alerted so the cron's idempotency check on
    //    the next run can short-circuit cleanly.
    try {
        await prisma.doshaForecast.update({
            where: { id: forecast.id },
            data: { alertEmitted: true, alertEmittedAt: new Date() },
        });
    } catch (err) {
        logger.warn('[dosha-cron] flipping alertEmitted failed', {
            forecastId: forecast.id, err: err.message,
        });
    }

    logger.info('[dosha-cron] alert', {
        patientId:     patient.id,
        forecastId:    forecast.id,
        dominantDosha: result.dominantDosha,
        daysUntilSymp: result.daysUntilSymp,
        confidence:    result.confidence,
        triggers:      result.triggerFactors.length,
        notified,
    });
    return true;
}
