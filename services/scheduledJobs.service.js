/**
 * Scheduled Jobs Service — BullMQ repeatable jobs replacing node-cron.
 *
 * Benefits over node-cron:
 *   - Single-instance execution (no duplicate runs across multiple server instances)
 *   - Persistence across restarts (jobs survive process crashes)
 *   - Built-in retry / backoff on failure
 *   - Observability via Bull Board dashboard
 *
 * Falls back to the legacy node-cron scheduler when Redis is unavailable.
 */

import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import logger from '../lib/logger.js';

let scheduledQueue = null;
let scheduledWorker = null;

const JOB_DEFINITIONS = [
    { name: 'appointment-reminders-24h', cron: '0 * * * *', handler: 'appointmentReminders24h' },
    { name: 'appointment-reminders-1h', cron: '*/15 * * * *', handler: 'appointmentReminders1h' },
    { name: 'cleanup-old-notifications', cron: '0 0 * * *', handler: 'cleanupNotifications' },
    { name: 'post-session-followups', cron: '0 9 * * *', handler: 'postSessionFollowups' },
    { name: 'care-gap-alerts', cron: '0 8 * * 1', handler: 'careGapAlerts' },
    { name: 'medication-adherence-reminders', cron: '0 20 * * *', handler: 'medicationReminders' },
    // Supply-based refill forecast: 3-day in-app + last-day WhatsApp (daily at 9am)
    { name: 'medication-refill-forecast', cron: '0 9 * * *', handler: 'medicationRefillForecast' },
    { name: 'expiring-prescriptions', cron: '0 8 * * *', handler: 'expiringPrescriptions' },
    { name: 'detect-no-shows', cron: '*/15 * * * *', handler: 'detectNoShows' },
    { name: 'csat-surveys', cron: '*/15 * * * *', handler: 'csatSurveys' },
    { name: 'care-gap-detection', cron: '0 7 * * *', handler: 'careGapDetection' },
    { name: 'gamification-recalc', cron: '0 2 * * *', handler: 'gamificationRecalc' },
    { name: 'clinician-streaks', cron: '55 23 * * *', handler: 'clinicianStreaks' },
    { name: 'branch-competitions', cron: '0 3 * * *', handler: 'branchCompetitions' },
    { name: 'weekly-gamification-digest', cron: '0 9 * * 1', handler: 'weeklyDigest' },
    { name: 'streak-at-risk', cron: '0 20 * * *', handler: 'streakAtRisk' },
    { name: 'feature-registry-sync', cron: '30 2 * * *', handler: 'featureRegistrySync' },
    // Daily check-in broadcast — every minute. The handler itself matches the
    // current HH:MM against each hospital's configured `dailyReminderTime`.
    { name: 'daily-checkin-reminder', cron: '* * * * *', handler: 'dailyCheckinReminder' },
    { name: 'wellness-decline-check', cron: '0 18 * * *', handler: 'wellnessDeclineCheck' },
    // Dashboard refactor — todo overdue reminder sweep (every 30 min)
    { name: 'todo-overdue-reminders', cron: '*/30 * * * *', handler: 'todoOverdueReminders' },
    // Online consultation pre-call reminders (30 min + 5 min windows, single sweep every 5 min)
    { name: 'online-call-reminders', cron: '*/5 * * * *', handler: 'onlineCallReminders' },
    // Fallback auto-complete for ONLINE appointments whose end is >2h past (every 30 min)
    { name: 'auto-complete-online-calls', cron: '*/30 * * * *', handler: 'autoCompleteOnlineCalls' },
    // Flip PENDING follow-ups past their dueDate to MISSED (hourly)
    { name: 'missed-followup-sweep', cron: '15 * * * *', handler: 'missedFollowUpSweep' },
    // Detect adherence-based critical patients (every 4 hours)
    { name: 'critical-journey-scan', cron: '0 */4 * * *', handler: 'criticalJourneyScan' },
];

async function processJob(job) {
    const { handler } = job.data;
    logger.info(`[ScheduledJobs] Running: ${job.name} (handler: ${handler})`);

    // Lazy-import services to avoid circular dependency issues
    const { schedulerService } = await import('./scheduler.service.js');

    // Map handler names to service methods
    const handlers = {
        appointmentReminders24h: () => schedulerService.sendDayBeforeReminders?.(),
        appointmentReminders1h: () => schedulerService.sendOneHourReminders?.(),
        cleanupNotifications: () => schedulerService.cleanupOldNotifications?.(),
        postSessionFollowups: () => schedulerService.sendPostSessionFollowUps?.(),
        careGapAlerts: () => schedulerService.sendCareGapAlerts?.(),
        medicationReminders: () => schedulerService.sendMedicationAdherenceReminders?.(),
        medicationRefillForecast: () => schedulerService.runMedicationRefillForecast?.(),
        expiringPrescriptions: () => schedulerService.checkExpiringPrescriptions?.(),
        detectNoShows: () => schedulerService.detectNoShows?.(),
        csatSurveys: () => schedulerService.sendCSATSurveys?.(),
        careGapDetection: () => schedulerService.runCareGapDetection?.(),
        gamificationRecalc: () => schedulerService.runGamificationRecalculation?.(),
        clinicianStreaks: () => schedulerService.updateClinicianStreaks?.(),
        branchCompetitions: () => schedulerService.recalculateBranchCompetitions?.(),
        weeklyDigest: () => schedulerService.sendWeeklyGamificationDigest?.(),
        streakAtRisk: () => schedulerService.sendStreakAtRiskNotifications?.(),
        featureRegistrySync: async () => {
            const { runFeatureRegistrySync } = await import('./featureRegistrySync.service.js');
            return runFeatureRegistrySync();
        },
        dailyCheckinReminder: async () => {
            const { runDailyReminderTick } = await import('./dailyReminder.service.js');
            return runDailyReminderTick();
        },
        wellnessDeclineCheck: () => schedulerService.detectWellnessDecline?.(),
        todoOverdueReminders: async () => {
            const { TodoService } = await import('./todo.service.js');
            return TodoService.runOverdueReminderSweep();
        },
        onlineCallReminders:      () => schedulerService.sendOnlineCallReminders?.(),
        autoCompleteOnlineCalls:  () => schedulerService.autoCompleteExpiredOnlineCalls?.(),
        missedFollowUpSweep: async () => {
            const { FollowUpService } = await import('./followUp.service.js');
            return FollowUpService.detectMissedFollowUps();
        },
        criticalJourneyScan: async () => {
            const { CriticalJourneyService } = await import('./criticalJourney.service.js');
            return CriticalJourneyService.detect();
        },
    };

    const fn = handlers[handler];
    if (fn) {
        await fn();
        logger.info(`[ScheduledJobs] Completed: ${job.name}`);
    } else {
        logger.warn(`[ScheduledJobs] Unknown handler: ${handler}`);
    }
}

export async function initScheduledJobs() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        logger.warn('[ScheduledJobs] No REDIS_URL configured — falling back to node-cron scheduler');
        // Import and run the old cron-based scheduler as fallback
        try {
            const { schedulerService } = await import('./scheduler.service.js');
            schedulerService.init();
        } catch (err) {
            logger.error('[ScheduledJobs] Failed to initialize fallback scheduler:', err.message);
        }
        return;
    }

    try {
        const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

        scheduledQueue = new Queue('scheduled-jobs', { connection });

        // Remove any existing repeatable jobs first to prevent duplicates on restart
        const existingJobs = await scheduledQueue.getRepeatableJobs();
        for (const job of existingJobs) {
            await scheduledQueue.removeRepeatableByKey(job.key);
        }

        // Register all repeatable jobs
        for (const def of JOB_DEFINITIONS) {
            await scheduledQueue.add(def.name, { handler: def.handler }, {
                repeat: { pattern: def.cron },
                removeOnComplete: { count: 50 },
                removeOnFail: { count: 20 },
            });
            logger.info(`[ScheduledJobs] Registered: ${def.name} (${def.cron})`);
        }

        // Create worker
        scheduledWorker = new Worker('scheduled-jobs', processJob, {
            connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
            concurrency: 2,
        });

        scheduledWorker.on('failed', (job, err) => {
            logger.error(`[ScheduledJobs] Failed: ${job?.name}`, { error: err.message });
        });

        // Seed badges (previously done in scheduler.init)
        try {
            const { schedulerService } = await import('./scheduler.service.js');
            schedulerService.seedBadges();
        } catch (err) {
            logger.error('[ScheduledJobs] Badge seeding failed:', err.message);
        }

        logger.info(`[ScheduledJobs] BullMQ scheduler initialized with ${JOB_DEFINITIONS.length} jobs`);
    } catch (err) {
        logger.error('[ScheduledJobs] Failed to initialize BullMQ scheduler, falling back to node-cron:', err.message);
        try {
            const { schedulerService } = await import('./scheduler.service.js');
            schedulerService.init();
        } catch (fallbackErr) {
            logger.error('[ScheduledJobs] Fallback scheduler also failed:', fallbackErr.message);
        }
    }
}

export async function shutdownScheduledJobs() {
    if (scheduledWorker) await scheduledWorker.close();
    if (scheduledQueue) await scheduledQueue.close();
    logger.info('[ScheduledJobs] Scheduler shut down');
}

/**
 * Expose the scheduled-jobs queue for Bull Board integration.
 */
export function getScheduledJobsQueue() {
    return scheduledQueue;
}
