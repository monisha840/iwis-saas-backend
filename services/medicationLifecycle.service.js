/**
 * Medication Lifecycle Service.
 *
 * Composes the existing pieces — Prescription, PharmacyDispense,
 * MedicationLog, RefillRequest — into a single lifecycle:
 *   PRESCRIBED → DISPENSED → ACTIVE USAGE → NEARING DEPLETION → REFILLED
 *
 * Responsibilities:
 *   - computeDepletionForecast(prescriptionId): remaining doses, run-out date,
 *     adherence rate, status label.
 *   - onDispense(tx, prescriptionId, qty): atomic counter update + end-date
 *     recompute + reset of reminder-notification stamps so the next cycle
 *     fires correctly.
 *   - onConsumption(tx, prescriptionId, qty): atomic counter update + end-date
 *     recompute. No stamp reset.
 *   - runMissedDoseSweep(): daily cron — day-1 miss → in-app, day-2 streak →
 *     WhatsApp follow-up via DeliveryService.
 *   - runRefillForecastSweep(): daily cron — 3-day-ahead in-app, last-day
 *     WhatsApp final nudge.
 *
 * Notes:
 *   - dispensedQty and consumedQty are the source of truth. totalQuantity is
 *     kept in-sync for back-compat with old code paths that still read it.
 *   - All writes use updateMany({where: ..., data: {...}}) CAS to avoid
 *     clobbering a concurrent stamp update.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';
import { DeliveryService } from './delivery.service.js';
import { parseDailyDoseCount, parseFrequencySlots } from './medicationFrequency.js';
import { renderTemplate } from '../lib/templateRenderer.js';

const MS_DAY = 24 * 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────────────────────
// Template resolution
// ───────────────────────────────────────────────────────────────────────────

/**
 * Look up the hospital's default MessageTemplate for a category and render it
 * with the medication context. Returns null when no active default exists —
 * caller falls back to a hardcoded body.
 *
 * Covered by the existing `MESSAGING_TEMPLATES` feature registry row, so
 * hospitals without the feature flag simply get the hardcoded body.
 */
async function renderMedicationTemplate(hospitalId, category, vars) {
    if (!hospitalId) return null;
    try {
        const template = await prisma.messageTemplate.findFirst({
            where: { hospitalId, category, isDefault: true, isActive: true },
            select: { id: true, body: true, subject: true },
        });
        if (!template || !template.body) return null;
        return {
            body: renderTemplate(template.body, vars),
            subject: template.subject ? renderTemplate(template.subject, vars) : null,
            templateId: template.id,
        };
    } catch (err) {
        // MessageTemplate table may not exist yet on very old deployments —
        // always degrade gracefully to the hardcoded body.
        logger.warn('[MedicationLifecycle] template lookup failed', { hospitalId, category, error: err.message });
        return null;
    }
}

function buildMedicationContext(rx, forecast, extras = {}) {
    return {
        patientName: rx.patient?.fullName || 'there',
        medicationName: rx.medicationName,
        dosage: rx.dosage,
        frequency: rx.frequency,
        daysRemaining: forecast?.daysRemaining ?? '',
        remainingDoses: forecast?.remainingDoses ?? '',
        hospitalName: rx.branch?.hospital?.name || 'Al-Shifa',
        branchName: rx.branch?.name || '',
        checkInLink: 'https://app.alshifa.health/patient',
        ...extras,
    };
}

// ───────────────────────────────────────────────────────────────────────────
// Forecast
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute a depletion forecast for a single prescription.
 *
 * @param {string} prescriptionId
 * @returns {Promise<{
 *   prescriptionId: string,
 *   medicationName: string,
 *   dailyDoseCount: number,
 *   dispensedQty: number,
 *   consumedQty: number,
 *   remainingDoses: number,
 *   daysRemaining: number | null,
 *   predictedRunOutDate: Date | null,
 *   adherenceRate: number | null,
 *   status: 'PRN' | 'NOT_STARTED' | 'ACTIVE' | 'NEARING_DEPLETION' | 'DEPLETED' | 'DISCONTINUED'
 * } | null>}
 */
export async function computeDepletionForecast(prescriptionId) {
    const rx = await prisma.prescription.findUnique({
        where: { id: prescriptionId },
        select: {
            id: true, medicationName: true, frequency: true,
            dailyDoseCount: true, dispensedQty: true, consumedQty: true,
            startDate: true, expectedEndDate: true, discontinuedAt: true,
            patientId: true,
        },
    });
    if (!rx) return null;

    const dailyDoseCount = rx.dailyDoseCount ?? parseDailyDoseCount(rx.frequency);
    const remainingDoses = Math.max(0, rx.dispensedQty - rx.consumedQty);

    if (rx.discontinuedAt) {
        return baseForecast(rx, dailyDoseCount, remainingDoses, null, null, null, 'DISCONTINUED');
    }

    // PRN — no schedule, no reminders, no forecast
    if (!dailyDoseCount || dailyDoseCount <= 0) {
        return baseForecast(rx, 0, remainingDoses, null, null, null, 'PRN');
    }

    if (rx.dispensedQty <= 0) {
        return baseForecast(rx, dailyDoseCount, 0, null, null, null, 'NOT_STARTED');
    }

    const adherenceRate = await _computeAdherenceRate(rx.id, dailyDoseCount);

    // Primary forecast: supply / daily-dose. This is the physical "when will
    // the pills run out" figure regardless of whether the patient is logging
    // correctly. Low-adherence patients get the same forecast — their supply
    // lasts longer in the real world (fewer doses consumed) but we intentionally
    // do NOT credit them for under-dosing by pushing the run-out date further.
    const daysRemaining = Math.floor(remainingDoses / dailyDoseCount);
    const predictedRunOutDate = new Date(Date.now() + daysRemaining * MS_DAY);

    const status = remainingDoses <= 0
        ? 'DEPLETED'
        : (daysRemaining <= 3 ? 'NEARING_DEPLETION' : 'ACTIVE');

    return baseForecast(rx, dailyDoseCount, remainingDoses, daysRemaining, predictedRunOutDate, adherenceRate, status);
}

function baseForecast(rx, dailyDoseCount, remainingDoses, daysRemaining, predictedRunOutDate, adherenceRate, status) {
    return {
        prescriptionId: rx.id,
        medicationName: rx.medicationName,
        dailyDoseCount,
        dispensedQty: rx.dispensedQty,
        consumedQty: rx.consumedQty,
        remainingDoses,
        daysRemaining,
        predictedRunOutDate,
        adherenceRate,
        status,
    };
}

async function _computeAdherenceRate(prescriptionId, dailyDoseCount) {
    if (!dailyDoseCount || dailyDoseCount <= 0) return null;
    const since = new Date(Date.now() - 7 * MS_DAY);
    const logs = await prisma.medicationLog.count({
        where: { prescriptionId, taken: true, date: { gte: since } },
    });
    const expected = dailyDoseCount * 7;
    if (expected === 0) return null;
    return Math.min(1, logs / expected);
}

// ───────────────────────────────────────────────────────────────────────────
// Counter updates
// ───────────────────────────────────────────────────────────────────────────

/**
 * Called from PharmacyService.dispenseMedicines inside its transaction.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} prescriptionId
 * @param {number} qty  how many doses were dispensed
 */
export async function onDispense(tx, prescriptionId, qty) {
    if (!qty || qty <= 0) return null;

    const rx = await tx.prescription.findUnique({
        where: { id: prescriptionId },
        select: { id: true, frequency: true, dailyDoseCount: true, dispensedQty: true, consumedQty: true },
    });
    if (!rx) return null;

    const dailyDoseCount = rx.dailyDoseCount ?? parseDailyDoseCount(rx.frequency);
    const newDispensed = rx.dispensedQty + qty;
    const remainingAfter = Math.max(0, newDispensed - rx.consumedQty);
    const expectedEndDate = (dailyDoseCount && dailyDoseCount > 0)
        ? new Date(Date.now() + Math.floor(remainingAfter / dailyDoseCount) * MS_DAY)
        : null;

    // Reset reminder stamps — a new dispense pushes the run-out date forward,
    // so the 3-day and last-day reminders should be eligible to fire again
    // once supply drops back into the threshold.
    await tx.prescription.update({
        where: { id: prescriptionId },
        data: {
            dispensedQty: { increment: qty },
            totalQuantity: { increment: qty }, // legacy back-compat
            dailyDoseCount: rx.dailyDoseCount ?? dailyDoseCount,
            expectedEndDate,
            threeDayNotifiedAt: null,
            lastDayNotifiedAt: null,
        },
    });

    return { newDispensed, expectedEndDate };
}

/**
 * Called when a patient logs a dose as taken. Must run inside the same
 * transaction that creates the MedicationLog row, so either both succeed
 * or neither does.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} prescriptionId
 * @param {number} qty  doses consumed (usually 1)
 */
export async function onConsumption(tx, prescriptionId, qty = 1) {
    if (!qty || qty <= 0) return null;

    const rx = await tx.prescription.findUnique({
        where: { id: prescriptionId },
        select: { id: true, startDate: true, dispensedQty: true, consumedQty: true, dailyDoseCount: true, frequency: true },
    });
    if (!rx) return null;

    const dailyDoseCount = rx.dailyDoseCount ?? parseDailyDoseCount(rx.frequency);
    const newConsumed = rx.consumedQty + qty;
    const remainingAfter = Math.max(0, rx.dispensedQty - newConsumed);
    const expectedEndDate = (dailyDoseCount && dailyDoseCount > 0)
        ? new Date(Date.now() + Math.floor(remainingAfter / dailyDoseCount) * MS_DAY)
        : null;

    const data = {
        consumedQty: { increment: qty },
        // totalQuantity retains historical meaning (remaining balance) so
        // older code paths reading it still get sensible numbers.
        totalQuantity: { decrement: qty },
        expectedEndDate,
        // Logging resets the missed-dose streak — the patient is back on-track.
        missedDoseStreak: 0,
        missedDoseNotifiedAt: null,
    };
    if (!rx.startDate) data.startDate = new Date();
    if (!rx.dailyDoseCount && dailyDoseCount > 0) data.dailyDoseCount = dailyDoseCount;

    await tx.prescription.update({ where: { id: prescriptionId }, data });
    return { newConsumed, expectedEndDate };
}

// ───────────────────────────────────────────────────────────────────────────
// Cron sweeps
// ───────────────────────────────────────────────────────────────────────────

/**
 * Missed-dose sweep. Runs daily at 8pm via `medication-adherence-reminders`.
 *
 * Logic (per prescription per patient):
 *   - Count expected doses so far today (slots whose hour has passed).
 *   - Count logs so far today.
 *   - If expected > logged → at least one dose missed.
 *     - Increment missedDoseStreak; stamp missedDoseNotifiedAt.
 *     - streak = 1 → in-app nudge only.
 *     - streak ≥ 2 → WhatsApp follow-up via DeliveryService (guard: at most
 *       one WA follow-up per prescription per 48h).
 */
export async function runMissedDoseSweep() {
    const now = new Date();
    const hour = now.getHours();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

    // Narrow the candidate set: active, not discontinued, dispensed enough to
    // be in usage phase, and with a daily dose schedule.
    const prescriptions = await prisma.prescription.findMany({
        where: {
            discontinuedAt: null,
            dispensedQty: { gt: 0 },
            OR: [
                { dailyDoseCount: { gt: 0 } },
                { dailyDoseCount: null }, // we'll parse frequency for these
            ],
        },
        include: {
            patient: { include: { user: { select: { id: true } } } },
            branch: { include: { hospital: { select: { id: true, name: true } } } },
        },
        take: 1000,
    });

    let pinged = 0;
    for (const rx of prescriptions) {
        try {
            const userId = rx.patient?.user?.id;
            if (!userId) continue;

            const dailyDoseCount = rx.dailyDoseCount ?? parseDailyDoseCount(rx.frequency);
            if (!dailyDoseCount || dailyDoseCount <= 0) continue;

            // Opt-out check
            const pref = await prisma.notificationPreference.findUnique({ where: { userId } });
            if (pref && pref.medicationReminders === false) continue;

            // Expected doses by this hour — approximate via slot schedule
            const slots = parseFrequencySlots(rx.frequency);
            const slotHourMap = { morning: 9, afternoon: 14, evening: 20 };
            const expectedSoFar = slots.filter(s => slotHourMap[s] <= hour).length;
            if (expectedSoFar === 0) continue;

            const loggedToday = await prisma.medicationLog.count({
                where: {
                    prescriptionId: rx.id, taken: true,
                    date: { gte: todayStart, lte: todayEnd },
                },
            });
            if (loggedToday >= expectedSoFar) continue; // all caught up

            const newStreak = (rx.missedDoseStreak || 0) + 1;

            // Update streak + stamp atomically. We stamp even if the WA send
            // is skipped later, so the CAS next tick doesn't double-fire.
            await prisma.prescription.update({
                where: { id: rx.id },
                data: { missedDoseStreak: newStreak, missedDoseNotifiedAt: now },
            });

            if (newStreak === 1) {
                // Soft nudge — in-app only
                await notificationService.createNotification({
                    userId,
                    type: 'MEDICATION_MISSED',
                    title: `💊 Missed a dose of ${rx.medicationName}?`,
                    message: `You haven't logged ${rx.medicationName} today. Tap to mark it taken if you have, or skip if you missed.`,
                    priority: 'LOW',
                    relatedId: rx.id,
                    data: { prescriptionId: rx.id, kind: 'MEDICATION_MISSED' },
                });
                pinged++;
                continue;
            }

            // streak >= 2 — WhatsApp follow-up, guarded at 48h window
            const recentFollowup = await prisma.notification.findFirst({
                where: {
                    userId,
                    type: 'MEDICATION_MISSED_FOLLOWUP',
                    relatedId: rx.id,
                    createdAt: { gt: new Date(Date.now() - 2 * MS_DAY) },
                },
            });
            if (recentFollowup) continue;

            const hospitalId = rx.branch?.hospital?.id || null;
            const vars = buildMedicationContext(rx, null, { streakDays: newStreak });
            const fallback = `Hi ${vars.patientName} — we noticed you haven't logged ${rx.medicationName} (${rx.dosage}) for 2 days. Staying consistent matters for your treatment. Open the Al-Shifa app to log a dose or contact your care team.`;
            const rendered = await renderMedicationTemplate(hospitalId, 'MEDICATION_MISSED_FOLLOWUP', vars);
            const body = rendered?.body || fallback;

            await DeliveryService.send({
                userId,
                kind: 'MEDICATION_MISSED_FOLLOWUP',
                channels: ['WHATSAPP', 'SMS', 'IN_APP'],
                body,
                subject: rendered?.subject || null,
                templateId: rendered?.templateId || null,
                inAppTitle: `💊 2 days without logging ${rx.medicationName}`,
                inAppType: 'MEDICATION_MISSED_FOLLOWUP',
                hospitalId,
            });

            // Track the follow-up in notifications so the 48h guard works.
            await prisma.notification.create({
                data: {
                    userId,
                    type: 'MEDICATION_MISSED_FOLLOWUP',
                    title: `💊 Follow-up: ${rx.medicationName}`,
                    message: body.slice(0, 500),
                    priority: 'MEDIUM',
                    relatedId: rx.id,
                    data: { prescriptionId: rx.id, streak: newStreak },
                },
            });
            pinged++;
        } catch (err) {
            logger.warn('[MedicationLifecycle] missed-dose sweep failed for prescription', { prescriptionId: rx.id, error: err.message });
        }
    }

    logger.info(`[MedicationLifecycle] missed-dose sweep pinged ${pinged} patients`);
    return pinged;
}

/**
 * Refill forecast sweep. Runs daily at 9am via `medication-refill-forecast`.
 *
 * Per active prescription:
 *   daysRemaining === 3  → in-app reminder with refill CTA (once)
 *   daysRemaining === 0  → WhatsApp final nudge (once)
 *   daysRemaining < 0    → clinician notification (at most once per 48h)
 */
export async function runRefillForecastSweep() {
    const now = new Date();

    const prescriptions = await prisma.prescription.findMany({
        where: {
            discontinuedAt: null,
            dispensedQty: { gt: 0 },
        },
        include: {
            patient: { include: { user: { select: { id: true } } } },
            doctor:  { include: { user: { select: { id: true } } } },
            therapist: { include: { user: { select: { id: true } } } },
            branch: { include: { hospital: { select: { id: true, name: true } } } },
        },
        take: 1000,
    });

    let reminders = 0;
    for (const rx of prescriptions) {
        try {
            const forecast = await computeDepletionForecast(rx.id);
            if (!forecast) continue;
            if (['PRN', 'NOT_STARTED', 'DISCONTINUED'].includes(forecast.status)) continue;

            const userId = rx.patient?.user?.id;
            const daysRemaining = forecast.daysRemaining;
            const hospitalId = rx.branch?.hospital?.id || null;
            const vars = buildMedicationContext(rx, forecast);

            // Three-day reminder (in-app only)
            if (userId && daysRemaining === 3 && !rx.threeDayNotifiedAt) {
                const pref = await prisma.notificationPreference.findUnique({ where: { userId } });
                if (!pref || pref.medicationReminders !== false) {
                    const fallback = `Your supply of ${rx.medicationName} (${rx.dosage}) will last about 3 more days. Request a refill now to avoid a gap in treatment.`;
                    const rendered = await renderMedicationTemplate(hospitalId, 'MEDICATION_REFILL_3D', vars);
                    await notificationService.createNotification({
                        userId,
                        type: 'MEDICATION_REFILL_3D',
                        title: `⏰ ${rx.medicationName} runs out in 3 days`,
                        message: rendered?.body || fallback,
                        priority: 'MEDIUM',
                        relatedId: rx.id,
                        data: { prescriptionId: rx.id, kind: 'MEDICATION_REFILL_3D', daysRemaining, templateId: rendered?.templateId || null },
                    });
                    await prisma.prescription.updateMany({
                        where: { id: rx.id, threeDayNotifiedAt: null },
                        data: { threeDayNotifiedAt: now },
                    });
                    reminders++;
                }
            }

            // Last-day reminder (WhatsApp → SMS → IN_APP)
            if (userId && daysRemaining === 0 && !rx.lastDayNotifiedAt) {
                const pref = await prisma.notificationPreference.findUnique({ where: { userId } });
                if (!pref || pref.medicationReminders !== false) {
                    const fallback = `Final reminder: your ${rx.medicationName} (${rx.dosage}) runs out today. Please request a refill from the Al-Shifa pharmacy to keep your treatment on track.`;
                    const rendered = await renderMedicationTemplate(hospitalId, 'MEDICATION_REFILL_LAST_DAY', vars);
                    const body = rendered?.body || fallback;
                    await DeliveryService.send({
                        userId,
                        kind: 'MEDICATION_REFILL_LAST_DAY',
                        channels: ['WHATSAPP', 'SMS', 'IN_APP'],
                        body,
                        subject: rendered?.subject || null,
                        templateId: rendered?.templateId || null,
                        inAppTitle: `🚨 ${rx.medicationName} runs out today`,
                        inAppType: 'MEDICATION_REFILL_LAST_DAY',
                        hospitalId,
                    });
                    await prisma.prescription.updateMany({
                        where: { id: rx.id, lastDayNotifiedAt: null },
                        data: { lastDayNotifiedAt: now },
                    });
                    reminders++;
                }
            }

            // Clinician alert when patient has run out (daysRemaining < 0)
            if (daysRemaining !== null && daysRemaining < 0) {
                const prescriberId = rx.doctor?.user?.id || rx.therapist?.user?.id;
                if (prescriberId) {
                    const recentAlert = await prisma.notification.findFirst({
                        where: {
                            userId: prescriberId,
                            type: 'MEDICATION_DEPLETED_CLINICIAN',
                            relatedId: rx.id,
                            createdAt: { gt: new Date(Date.now() - 2 * MS_DAY) },
                        },
                    });
                    if (!recentAlert) {
                        await notificationService.createNotification({
                            userId: prescriberId,
                            type: 'MEDICATION_DEPLETED_CLINICIAN',
                            title: `📋 ${rx.patient?.fullName || 'Patient'} out of ${rx.medicationName}`,
                            message: `${rx.patient?.fullName || 'A patient'}'s supply of ${rx.medicationName} ran out ${Math.abs(daysRemaining)} day(s) ago.`,
                            priority: 'LOW',
                            relatedId: rx.id,
                            data: { prescriptionId: rx.id, daysOverdue: Math.abs(daysRemaining) },
                        });
                    }
                }
            }
        } catch (err) {
            logger.warn('[MedicationLifecycle] refill forecast failed for prescription', { prescriptionId: rx.id, error: err.message });
        }
    }

    logger.info(`[MedicationLifecycle] refill forecast sweep sent ${reminders} reminders`);
    return reminders;
}

// ───────────────────────────────────────────────────────────────────────────
// Patient-facing helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Get forecasts for all active prescriptions of a patient.
 * @param {string} patientId  Patient.id (NOT user.id)
 */
export async function getForecastsForPatient(patientId) {
    const prescriptions = await prisma.prescription.findMany({
        where: { patientId, discontinuedAt: null, dispensedQty: { gt: 0 } },
        select: { id: true },
    });
    const forecasts = await Promise.all(
        prescriptions.map(p => computeDepletionForecast(p.id).catch(() => null)),
    );
    return forecasts.filter(Boolean);
}

/**
 * Get adherence stats for a single prescription (doctor-facing).
 */
export async function getAdherenceStats(prescriptionId) {
    const rx = await prisma.prescription.findUnique({
        where: { id: prescriptionId },
        select: {
            id: true, medicationName: true, dosage: true, frequency: true,
            dailyDoseCount: true, dispensedQty: true, consumedQty: true,
            startDate: true, expectedEndDate: true, createdAt: true,
        },
    });
    if (!rx) return null;

    const dailyDoseCount = rx.dailyDoseCount ?? parseDailyDoseCount(rx.frequency);
    const since7 = new Date(Date.now() - 7 * MS_DAY);
    const since30 = new Date(Date.now() - 30 * MS_DAY);

    const [logs7, logs30, missedLogs, dispenses] = await Promise.all([
        prisma.medicationLog.count({ where: { prescriptionId, taken: true, date: { gte: since7 } } }),
        prisma.medicationLog.count({ where: { prescriptionId, taken: true, date: { gte: since30 } } }),
        prisma.medicationLog.findMany({
            where: { prescriptionId, taken: false, date: { gte: since30 } },
            select: { id: true, date: true, notes: true },
            orderBy: { date: 'desc' },
            take: 30,
        }).catch(() => []),
        prisma.pharmacyDispense.findMany({
            where: { prescriptionId },
            select: {
                id: true, createdAt: true, totalAmount: true,
                items: { select: { quantity: true, medicine: { select: { name: true } } } },
            },
            orderBy: { createdAt: 'desc' },
        }),
    ]);

    const expected7 = (dailyDoseCount || 0) * 7;
    const expected30 = (dailyDoseCount || 0) * 30;

    return {
        prescriptionId: rx.id,
        medicationName: rx.medicationName,
        dosage: rx.dosage,
        frequency: rx.frequency,
        dailyDoseCount,
        adherenceRate7d: expected7 > 0 ? Math.min(1, logs7 / expected7) : null,
        adherenceRate30d: expected30 > 0 ? Math.min(1, logs30 / expected30) : null,
        logsLast7d: logs7,
        logsLast30d: logs30,
        missedSlots: missedLogs,
        dispenseHistory: dispenses,
        dispensedQty: rx.dispensedQty,
        consumedQty: rx.consumedQty,
        startDate: rx.startDate,
        expectedEndDate: rx.expectedEndDate,
    };
}

export const MedicationLifecycleService = {
    computeDepletionForecast,
    onDispense,
    onConsumption,
    runMissedDoseSweep,
    runRefillForecastSweep,
    getForecastsForPatient,
    getAdherenceStats,
};
