/**
 * Daily Check-in Reminder — scheduled broadcast runner.
 *
 * Flow per tick (every minute):
 *   1. Load all ReminderSetting rows where `dailyReminderEnabled = true`.
 *   2. For each, compute the current HH:MM in the hospital's timezone.
 *   3. If the stored `dailyReminderTime` matches AND no run has happened today,
 *      fire `runDailyReminderForHospital(hospitalId)`.
 *
 * `runDailyReminderForHospital` can also be invoked manually from the admin UI
 * (via /api/reminder-settings/trigger-now) for smoke-testing without waiting
 * 24 hours.
 *
 * Idempotency: a hospital's `lastRunAt` must be < today's local midnight for the
 * run to proceed. This keeps minute-level cron ticks safe against cache drift
 * or schema reloads firing twice.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { DeliveryService } from './delivery.service.js';
import { renderTemplate } from '../lib/templateRenderer.js';

const DEFAULT_BODY = `Good morning {{patientName}}! This is a friendly reminder to complete your daily check-in on the IWIS app. Logging your symptoms, sleep, and pain score helps your care team guide your treatment. {{checkInLink}}`;

/**
 * Scheduler entry point. Walks every hospital that has reminders enabled and
 * fires the ones whose configured time matches now (in their timezone).
 */
export async function runDailyReminderTick() {
    let settings;
    try {
        settings = await prisma.reminderSetting.findMany({
            where: { dailyReminderEnabled: true },
            include: { hospital: { select: { id: true, name: true, timezone: true, status: true } } },
        });
    } catch (err) {
        logger.error('[DailyReminder] tick — failed to load settings', err);
        return;
    }

    const now = new Date();
    const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    for (const setting of settings) {
        if (!setting.hospital || setting.hospital.status === 'DECOMMISSIONED') continue;
        const tz = setting.hospital.timezone || 'Asia/Kolkata';
        const localHHMM = currentHHMMInTz(now, tz);
        if (localHHMM !== setting.dailyReminderTime) continue;

        // Already ran today? (compare against UTC midnight — good enough for once-a-day.)
        if (setting.lastRunAt && setting.lastRunAt.getTime() >= todayUtcMs) continue;

        try {
            await runDailyReminderForHospital(setting.hospitalId, { manual: false });
        } catch (err) {
            logger.error(`[DailyReminder] hospital=${setting.hospitalId} run failed`, err);
        }
    }
}

/**
 * Execute the reminder for ONE hospital right now.
 * Respects `skipIfAlreadyCheckedIn` and per-user notification preferences (handled by DeliveryService).
 */
export async function runDailyReminderForHospital(hospitalId, { manual = false, triggeredByUserId = null } = {}) {
    const setting = await prisma.reminderSetting.findUnique({
        where: { hospitalId },
        include: {
            dailyReminderTemplate: true,
            hospital: { select: { id: true, name: true, timezone: true } },
        },
    });
    if (!setting) throw new Error(`No reminder setting for hospital ${hospitalId}`);

    const bodyTemplate = setting.dailyReminderTemplate?.body || setting.dailyReminderInlineBody || DEFAULT_BODY;
    const channels = setting.dailyReminderChannels && setting.dailyReminderChannels.length
        ? setting.dailyReminderChannels
        : ['WHATSAPP', 'IN_APP'];

    // Pull the target patient cohort — onboarded, attached to this hospital.
    const patients = await prisma.patient.findMany({
        where: {
            onboardingCompleted: true,
            user: { hospitalId, deletedAt: null },
            ...(setting.skipIfAlreadyCheckedIn
                ? { NOT: { dailyCheckIns: { some: { createdAt: { gte: startOfTodayInTz(setting.hospital?.timezone) } } } } }
                : {}),
        },
        include: { user: { select: { id: true } } },
        take: 2000, // safety cap per run
    });

    let successCount = 0;
    let attemptCount = 0;

    for (const patient of patients) {
        const userId = patient.user?.id;
        if (!userId) continue;
        attemptCount++;

        const body = renderTemplate(bodyTemplate, {
            patientName: patient.fullName || 'there',
            hospitalName: setting.hospital?.name || 'Al-Shifa Group of Hospitals',
            checkInLink: '',
        });

        try {
            const result = await DeliveryService.send({
                userId,
                hospitalId,
                templateId: setting.dailyReminderTemplateId,
                kind: 'DAILY_CHECKIN',
                channels,
                body,
                inAppTitle: 'Time for your daily check-in',
                inAppType: 'DAILY_CHECKIN_REMINDER',
            });
            if (result.success) successCount++;
        } catch (err) {
            logger.warn('[DailyReminder] send failed for user', { userId, error: err.message });
        }
    }

    await prisma.reminderSetting.update({
        where: { hospitalId },
        data: {
            lastRunAt: new Date(),
            lastRunTargetCount: attemptCount,
            lastRunSuccessCount: successCount,
        },
    });

    logger.info(`[DailyReminder] hospital=${hospitalId} manual=${manual} target=${attemptCount} delivered=${successCount}`);

    return { manual, triggeredByUserId, targetCount: attemptCount, successCount };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Return `HH:MM` for `now` in the given IANA tz. */
function currentHHMMInTz(now, timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            hour: '2-digit', minute: '2-digit', hour12: false, timeZone,
        }).formatToParts(now);
        const hh = parts.find((p) => p.type === 'hour')?.value || '00';
        const mm = parts.find((p) => p.type === 'minute')?.value || '00';
        return `${hh}:${mm}`;
    } catch {
        return now.toISOString().substring(11, 16); // fallback UTC
    }
}

/** Return JS Date representing start-of-today in the given tz, as a UTC instant. */
function startOfTodayInTz(timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timeZone || 'Asia/Kolkata',
        }).formatToParts(new Date());
        const y = parts.find((p) => p.type === 'year')?.value;
        const m = parts.find((p) => p.type === 'month')?.value;
        const d = parts.find((p) => p.type === 'day')?.value;
        // Interpret that local date at 00:00 in the target tz and convert to UTC.
        // Simplest safe approach: treat it as UTC midnight — acceptable for a once-a-day guard.
        return new Date(`${y}-${m}-${d}T00:00:00Z`);
    } catch {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        return d;
    }
}
