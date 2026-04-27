import cron from 'node-cron';
import prisma from '../lib/prisma.js';
import { notificationService } from './notification.service.js';
import logger from '../lib/logger.js';

/**
 * Scheduler service for automated tasks
 * Uses node-cron to run periodic jobs
 */
class SchedulerService {
    constructor() {
        this.jobs = [];
    }

    /**
     * Initialize all scheduled jobs
     */
    init() {
        logger.info('[SchedulerService] Initializing scheduled jobs...');

        // Check for 24-hour reminders every hour
        this.jobs.push(
            cron.schedule('0 * * * *', () => {
                this.sendDayBeforeReminders();
            })
        );

        // Check for 1-hour reminders every 15 minutes
        this.jobs.push(
            cron.schedule('*/15 * * * *', () => {
                this.sendOneHourReminders();
            })
        );

        // Clean up old notifications (older than 30 days) - runs daily at midnight
        this.jobs.push(
            cron.schedule('0 0 * * *', () => {
                this.cleanupOldNotifications();
            })
        );

        // Post-session follow-up nudges — runs daily at 9am
        this.jobs.push(
            cron.schedule('0 9 * * *', () => {
                this.sendPostSessionFollowUps();
            })
        );

        // Care-gap detection — runs every Monday at 8am
        this.jobs.push(
            cron.schedule('0 8 * * 1', () => {
                this.sendCareGapAlerts();
            })
        );

        // Medication adherence reminders — runs daily at 8pm
        this.jobs.push(
            cron.schedule('0 20 * * *', () => {
                this.sendMedicationAdherenceReminders();
            })
        );

        // Medication refill forecast — runs daily at 9am
        this.jobs.push(
            cron.schedule('0 9 * * *', () => {
                this.runMedicationRefillForecast();
            })
        );

        // Prescription expiry alerts — runs daily at 8am
        this.jobs.push(
            cron.schedule('0 8 * * *', () => {
                this.checkExpiringPrescriptions();
            })
        );

        // No-show detection — every 15 minutes
        this.jobs.push(
            cron.schedule('*/15 * * * *', () => {
                this.detectNoShows();
            })
        );

        // Post-appointment CSAT survey — every 15 minutes
        this.jobs.push(
            cron.schedule('*/15 * * * *', () => {
                this.sendCSATSurveys();
            })
        );

        // Consultation-feedback 24h reminder push — hourly sweep over the
        // 24–48h window. No separate expiry job: the 48h cutoff is applied at
        // read time by ConsultationFeedbackService.getPending.
        this.jobs.push(
            cron.schedule('30 * * * *', () => {
                this.sendConsultationFeedbackReminders();
            })
        );

        // Journey-feedback 72h reminder push — hourly sweep. Pending feedback
        // rows older than 72h with no reminderSentAt get one notification.
        // Expiry (30 days) is applied at read time, no separate cleanup job.
        this.jobs.push(
            cron.schedule('45 * * * *', () => {
                this.sendJourneyFeedbackReminders();
            })
        );

        // Advanced care gap detection — daily at 7am
        this.jobs.push(
            cron.schedule('0 7 * * *', () => {
                this.runCareGapDetection();
            })
        );

        // ── Gamification jobs ─────────────────────────────────────────────────

        // Daily leaderboard recalculation + badge checking — runs at 2am
        this.jobs.push(
            cron.schedule('0 2 * * *', () => {
                this.runGamificationRecalculation();
            })
        );

        // Clinician streak updates — runs at 11:55pm daily
        this.jobs.push(
            cron.schedule('55 23 * * *', () => {
                this.updateClinicianStreaks();
            })
        );

        // Branch competition recalculation — runs daily at 3am
        this.jobs.push(
            cron.schedule('0 3 * * *', () => {
                this.recalculateBranchCompetitions();
            })
        );

        // Weekly gamification digest — runs every Monday at 9am
        this.jobs.push(
            cron.schedule('0 9 * * 1', () => {
                this.sendWeeklyGamificationDigest();
            })
        );

        // Streak-at-risk notifications — runs daily at 8pm
        this.jobs.push(
            cron.schedule('0 20 * * *', () => {
                this.sendStreakAtRiskNotifications();
            })
        );

        // Seed badge definitions on startup
        this.seedBadges();

        logger.info('[SchedulerService] All jobs scheduled');
    }

    /**
     * Seed badge definitions (runs once on startup).
     */
    async seedBadges() {
        try {
            const { BadgeService } = await import('./badge.service.js');
            await BadgeService.seedDefaults();
        } catch (error) {
            logger.error('[SchedulerService] Error seeding badges:', error);
        }
    }

    /**
     * Full gamification recalculation: scores → badges → adaptive targets.
     * Runs daily at 2am.
     */
    async runGamificationRecalculation() {
        try {
            const { LeaderboardService } = await import('./leaderboard.service.js');
            const { BadgeService } = await import('./badge.service.js');
            const { AntiGamingService } = await import('./antiGaming.service.js');
            const { AdaptiveTargetsService } = await import('./adaptiveTargets.service.js');

            logger.info('[SchedulerService] Starting gamification recalculation...');

            // Step 1: Recalculate all scores
            const result = await LeaderboardService.recalculateAll();

            // Step 2: Get the full leaderboard for rank-aware badge checking
            const leaderboard = await LeaderboardService.getLeaderboard();

            // Step 3: Check badges and anomalies for each participant
            for (let i = 0; i < leaderboard.length; i++) {
                const entry = leaderboard[i];
                const rank = i + 1;

                try {
                    // Anti-gaming check
                    await AntiGamingService.checkScoreAnomaly(entry.id, entry.role, entry.score);

                    // Badge check
                    await BadgeService.checkAndAwardBadges(entry.id, entry.role, entry.metrics, entry.score, rank);

                    // Adaptive targets
                    await AdaptiveTargetsService.recalculateTargets(entry.id, entry.role);
                } catch (err) {
                    logger.error(`[SchedulerService] Post-recalc failed for ${entry.id}:`, err.message);
                }
            }

            logger.info(`[SchedulerService] Gamification recalculation complete: ${result.recalculated} scored`);
        } catch (error) {
            logger.error('[SchedulerService] Error in gamification recalculation:', error);
        }
    }

    /**
     * Update clinician streaks — runs at 11:55pm daily.
     */
    async updateClinicianStreaks() {
        try {
            const { StreakService } = await import('./streak.service.js');
            const updated = await StreakService.updateAllClinicianStreaks();
            logger.info(`[SchedulerService] Updated ${updated} clinician streaks`);
        } catch (error) {
            logger.error('[SchedulerService] Error updating clinician streaks:', error);
        }
    }

    /**
     * Recalculate branch competition scores.
     */
    async recalculateBranchCompetitions() {
        try {
            const { BranchCompetitionService } = await import('./branchCompetition.service.js');
            const count = await BranchCompetitionService.recalculateActiveCompetitions();
            logger.info(`[SchedulerService] Recalculated ${count} active branch competitions`);
        } catch (error) {
            logger.error('[SchedulerService] Error recalculating branch competitions:', error);
        }
    }

    /**
     * Send weekly gamification digest to all clinicians.
     */
    async sendWeeklyGamificationDigest() {
        try {
            const [doctors, therapists] = await Promise.all([
                prisma.doctor.findMany({ include: { user: { select: { id: true } } } }),
                prisma.therapist.findMany({ include: { user: { select: { id: true } } } })
            ]);

            const participants = [
                ...doctors.map(d => ({ profileId: d.id, userId: d.user.id, name: d.fullName })),
                ...therapists.map(t => ({ profileId: t.id, userId: t.user.id, name: t.fullName }))
            ];

            // Get latest leaderboard for rank info
            const { LeaderboardService } = await import('./leaderboard.service.js');
            const leaderboard = await LeaderboardService.getLeaderboard();
            const rankMap = {};
            leaderboard.forEach((entry, i) => { rankMap[entry.id] = { rank: i + 1, score: entry.score, trend: entry.trend }; });

            let sentCount = 0;
            for (const p of participants) {
                const info = rankMap[p.profileId];
                if (!info) continue;

                const trendEmoji = info.trend === 'up' ? '↑' : info.trend === 'down' ? '↓' : '→';
                await notificationService.createNotification({
                    userId: p.userId,
                    type: 'GAMIFICATION_DIGEST',
                    title: `Weekly Performance: Score ${info.score} ${trendEmoji}`,
                    message: `You're ranked #${info.rank} out of ${leaderboard.length} clinicians this week. ${info.trend === 'up' ? 'Great progress!' : 'Keep pushing!'}`,
                    priority: 'LOW',
                    data: { score: info.score, rank: info.rank, trend: info.trend }
                });
                sentCount++;
            }

            logger.info(`[SchedulerService] Sent ${sentCount} weekly gamification digests`);
        } catch (error) {
            logger.error('[SchedulerService] Error sending gamification digests:', error);
        }
    }

    /**
     * Send streak-at-risk notifications to clinicians who haven't logged activity today.
     */
    async sendStreakAtRiskNotifications() {
        try {
            const activeStreaks = await prisma.clinicianStreak.findMany({
                where: { currentStreak: { gte: 3 } } // Only warn for meaningful streaks
            });

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            let sentCount = 0;
            for (const streak of activeStreaks) {
                const lastActive = streak.lastActiveDate ? new Date(streak.lastActiveDate) : null;
                if (!lastActive) continue;

                const lastActiveStr = lastActive.toISOString().split('T')[0];
                const todayStr = today.toISOString().split('T')[0];

                // If they were NOT active today, warn them
                if (lastActiveStr !== todayStr) {
                    const user = streak.participantRole === 'DOCTOR'
                        ? await prisma.doctor.findUnique({ where: { id: streak.participantId }, select: { userId: true } })
                        : await prisma.therapist.findUnique({ where: { id: streak.participantId }, select: { userId: true } });

                    if (user) {
                        await notificationService.createNotification({
                            userId: user.userId,
                            type: 'STREAK_AT_RISK',
                            title: `Your ${streak.currentStreak}-day streak is at risk!`,
                            message: `You haven't logged any activity today. Complete an appointment, respond to a patient, or write a prescription to keep your streak alive.`,
                            priority: 'MEDIUM',
                            data: { currentStreak: streak.currentStreak }
                        });
                        sentCount++;
                    }
                }
            }

            if (sentCount > 0) {
                logger.info(`[SchedulerService] Sent ${sentCount} streak-at-risk notifications`);
            }
        } catch (error) {
            logger.error('[SchedulerService] Error sending streak-at-risk notifications:', error);
        }
    }

    /**
     * Send reminders 24 hours before appointments
     */
    async sendDayBeforeReminders() {
        try {
            const tomorrow = new Date();
            tomorrow.setHours(tomorrow.getHours() + 24);

            const hourAfterTomorrow = new Date(tomorrow);
            hourAfterTomorrow.setHours(hourAfterTomorrow.getHours() + 1);

            // Find appointments scheduled for tomorrow (within 1-hour window)
            const appointments = await prisma.appointment.findMany({
                where: {
                    date: {
                        gte: tomorrow,
                        lt: hourAfterTomorrow,
                    },
                    status: {
                        in: ['SCHEDULED', 'CONFIRMED'],
                    },
                },
            });

            logger.info(`[SchedulerService] Found ${appointments.length} appointments for 24h reminders`);

            for (const appointment of appointments) {
                await notificationService.sendAppointmentReminder(appointment.id, 24);
            }
        } catch (error) {
            logger.error('[SchedulerService] Error sending 24h reminders:', error);
        }
    }

    /**
     * Send reminders 1 hour before appointments
     */
    async sendOneHourReminders() {
        try {
            const oneHourFromNow = new Date();
            oneHourFromNow.setHours(oneHourFromNow.getHours() + 1);

            const fifteenMinutesAfter = new Date(oneHourFromNow);
            fifteenMinutesAfter.setMinutes(fifteenMinutesAfter.getMinutes() + 15);

            // Find appointments in the next hour (within 15-minute window)
            const appointments = await prisma.appointment.findMany({
                where: {
                    date: {
                        gte: oneHourFromNow,
                        lt: fifteenMinutesAfter,
                    },
                    status: {
                        in: ['SCHEDULED', 'CONFIRMED'],
                    },
                },
            });

            logger.info(`[SchedulerService] Found ${appointments.length} appointments for 1h reminders`);

            for (const appointment of appointments) {
                await notificationService.sendAppointmentReminder(appointment.id, 1);
            }
        } catch (error) {
            logger.error('[SchedulerService] Error sending 1h reminders:', error);
        }
    }

    /**
     * ONLINE-appointment pre-call reminders with the embedded meeting link.
     * Two windows are swept each run so one cron (every 5 min) covers both:
     *   - [27, 32) min before start → "starts in 30 minutes"
     *   - [3, 7) min before start   → "starts in 5 minutes, join now"
     * Runs only for ONLINE appointments with a populated meetingLink.
     * Deduplication is handled by the in-app notification `data.kind` check
     * so a single appointment is never reminded twice for the same window.
     */
    async sendOnlineCallReminders() {
        const now = new Date();
        const windows = [
            { kind: 'online_reminder_30m', startOffset: 27, endOffset: 32, minutesBefore: 30 },
            { kind: 'online_reminder_5m',  startOffset: 3,  endOffset: 7,  minutesBefore: 5  },
        ];

        for (const w of windows) {
            try {
                const winStart = new Date(now.getTime() + w.startOffset * 60_000);
                const winEnd   = new Date(now.getTime() + w.endOffset   * 60_000);

                const appointments = await prisma.appointment.findMany({
                    where: {
                        consultationMode: 'ONLINE',
                        meetingLink: { not: null },
                        date: { gte: winStart, lt: winEnd },
                        status: { in: ['SCHEDULED', 'CONFIRMED', 'ACCEPTED'] },
                    },
                    include: {
                        patient: { include: { user: { select: { id: true } } } },
                        doctor:  { select: { userId: true } },
                        therapist: { select: { userId: true } },
                    },
                });

                for (const appt of appointments) {
                    // Dedupe check: have we already reminded for this window?
                    const already = await prisma.notification.findFirst({
                        where: {
                            type: 'APPOINTMENT_REMINDER',
                            // Match on appointmentId + kind inside the JSON `data` column.
                            // Prisma supports path-based JSON filters on Postgres.
                            AND: [
                                { data: { path: ['appointmentId'], equals: appt.id } },
                                { data: { path: ['kind'],          equals: w.kind  } },
                            ],
                        },
                        select: { id: true },
                    });
                    if (already) continue;

                    const targets = [
                        appt.patient?.user?.id,
                        appt.doctor?.userId,
                        appt.therapist?.userId,
                    ].filter(Boolean);

                    const title = `Your online consultation starts in ${w.minutesBefore} minutes`;
                    const message = `Join the video call when you're ready. The waiting room opens 15 minutes before the start time.`;

                    await Promise.all(targets.map((userId) =>
                        notificationService.createNotification({
                            userId,
                            type: 'APPOINTMENT_REMINDER',
                            title,
                            message,
                            priority: w.minutesBefore <= 5 ? 'HIGH' : 'MEDIUM',
                            data: {
                                kind: w.kind,
                                appointmentId: appt.id,
                                meetingLink: appt.meetingLink,
                                startAt: appt.date,
                            },
                        }).catch(() => { /* best-effort */ })
                    ));
                }

                logger.info(
                    `[SchedulerService] online-reminder ${w.kind} → ${appointments.length} appointments`
                );
            } catch (err) {
                logger.error(`[SchedulerService] online-reminder ${w.kind} failed`, { err: err.message });
            }
        }
    }

    /**
     * Fallback auto-complete for ONLINE appointments.
     *
     * The Daily.co `meeting.ended` webhook normally flips status to COMPLETED.
     * For Jitsi-mode tenants (no DAILY_API_KEY) there is NO webhook, so this
     * sweep closes the gap: any ONLINE appointment whose scheduled end is >2h
     * in the past and is still in a non-terminal state gets marked COMPLETED.
     * Using the same path as the webhook so all status-transition side effects
     * (zen points, CSAT cron pickup) still fire.
     */
    async autoCompleteExpiredOnlineCalls() {
        const { AppointmentService } = await import('./appointment.service.js');
        try {
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
            const stale = await prisma.appointment.findMany({
                where: {
                    consultationMode: 'ONLINE',
                    date: { lt: twoHoursAgo },
                    status: { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'] },
                },
                select: { id: true },
            });
            for (const { id } of stale) {
                try {
                    await AppointmentService.updateAppointment(
                        id,
                        { id: 'system', role: 'ADMIN' },
                        { status: 'COMPLETED' }
                    );
                } catch (err) {
                    logger.warn('[SchedulerService] autoCompleteExpiredOnlineCalls: update failed', {
                        appointmentId: id, err: err.message,
                    });
                }
            }
            if (stale.length > 0) {
                logger.info(`[SchedulerService] Auto-completed ${stale.length} stale ONLINE appointments`);
            }
        } catch (err) {
            logger.error('[SchedulerService] autoCompleteExpiredOnlineCalls failed', { err: err.message });
        }
    }

    /**
     * Clean up notifications older than 30 days
     */
    async cleanupOldNotifications() {
        try {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const result = await prisma.notification.deleteMany({
                where: {
                    createdAt: {
                        lt: thirtyDaysAgo,
                    },
                    isRead: true,
                },
            });

            logger.info(`[SchedulerService] Cleaned up ${result.count} old notifications`);
        } catch (error) {
            logger.error('[SchedulerService] Error cleaning up notifications:', error);
        }
    }

    /**
     * Send post-session follow-up nudges.
     * Targets: appointments COMPLETED 3 days ago where no DailyCheckIn has been
     * submitted since the completion date.
     * Runs: daily at 9am
     */
    async sendPostSessionFollowUps() {
        try {
            const threeDaysAgo = new Date();
            threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

            const fourDaysAgo = new Date();
            fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);

            // Appointments completed roughly 3 days ago
            const completedAppointments = await prisma.appointment.findMany({
                where: {
                    status: 'COMPLETED',
                    updatedAt: { gte: fourDaysAgo, lt: threeDaysAgo },
                },
                include: { patient: true },
            });

            let sentCount = 0;  // M-7: count only actually sent notifications, not total eligible

            for (const appt of completedAppointments) {
                if (!appt.patient?.userId) continue;

                // Check if patient has submitted a check-in since the appointment date
                const checkIn = await prisma.dailyCheckIn.findFirst({
                    where: {
                        patientId: appt.patientId,
                        createdAt: { gte: new Date(appt.updatedAt) },
                    },
                });

                if (!checkIn) {
                    await notificationService.createNotification({
                        userId: appt.patient.userId,
                        type: 'POST_SESSION_FOLLOWUP',
                        title: '💬 How are you feeling after your session?',
                        message: `It has been 3 days since your last session. Please submit a wellness check-in to track your recovery progress.`,
                        priority: 'MEDIUM',
                        data: { appointmentId: appt.id },
                    });
                    sentCount++;
                }
            }

            logger.info(`[SchedulerService] Post-session follow-up sent for ${sentCount} out of ${completedAppointments.length} eligible appointments`);
        } catch (error) {
            logger.error('[SchedulerService] Error sending post-session follow-ups:', error);
        }
    }

    /**
     * Care-gap detection: alert patients and their doctor when no appointment
     * has been scheduled for > 21 days on an active journey.
     * Runs: every Monday at 8am
     */
    async sendCareGapAlerts() {
        try {
            const twentyOneDaysAgo = new Date();
            twentyOneDaysAgo.setDate(twentyOneDaysAgo.getDate() - 21);

            const atRiskJourneys = await prisma.journey.findMany({
                where: { status: 'ACTIVE' },
                include: {
                    patient: { include: { user: true } },
                    doctor: { include: { user: true } },
                },
            });

            let alertCount = 0;

            for (const journey of atRiskJourneys) {
                // Find the most recent appointment for this patient
                const lastAppointment = await prisma.appointment.findFirst({
                    where: {
                        patientId: journey.patientId,
                        status: { in: ['COMPLETED', 'CONFIRMED', 'SCHEDULED'] },
                    },
                    orderBy: { date: 'desc' },
                });

                const lastDate = lastAppointment?.date || journey.startDate;
                if (new Date(lastDate) < twentyOneDaysAgo) {
                    // M-2: Deduplication — skip patients already notified about this care gap
                    //       within the past 7 days to prevent alert spam.
                    if (journey.patient?.userId) {
                        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                        const recentAlert = await prisma.notification.findFirst({
                            where: {
                                userId: journey.patient.userId,
                                type: 'CARE_GAP_PATIENT',
                                createdAt: { gte: sevenDaysAgo }
                            },
                            select: { id: true }
                        });
                        if (recentAlert) continue;
                    }

                    // Notify patient
                    if (journey.patient?.userId) {
                        await notificationService.createNotification({
                            userId: journey.patient.userId,
                            type: 'CARE_GAP_PATIENT',
                            title: '📅 Time to schedule your next session',
                            message: `You haven't had an appointment in over 3 weeks. Your ongoing treatment journey benefits from regular sessions. Book your next visit today.`,
                            priority: 'MEDIUM',
                            data: { journeyId: journey.id },
                        });
                    }

                    // Notify assigned doctor
                    if (journey.doctor?.userId) {
                        await notificationService.createNotification({
                            userId: journey.doctor.userId,
                            type: 'CARE_GAP_DOCTOR',
                            title: `⚠️ Care gap: ${journey.patient?.fullName || 'Patient'}`,
                            message: `${journey.patient?.fullName || 'A patient'} on an active journey has had no appointment for over 21 days. Consider reaching out.`,
                            priority: 'LOW',
                            data: { journeyId: journey.id, patientId: journey.patientId },
                        });
                    }

                    alertCount++;
                }
            }

            logger.info(`[SchedulerService] Care-gap alerts sent for ${alertCount} journeys`);
        } catch (error) {
            logger.error('[SchedulerService] Error sending care-gap alerts:', error);
        }
    }

    /**
     * Medication missed-dose sweep. Delegates to MedicationLifecycleService —
     * per-prescription streak tracking, day-1 in-app nudge, day-2 WhatsApp
     * follow-up with 48h dedup.
     * Runs: daily at 8pm
     */
    async sendMedicationAdherenceReminders() {
        try {
            const { runMissedDoseSweep } = await import('./medicationLifecycle.service.js');
            const pinged = await runMissedDoseSweep();
            logger.info(`[SchedulerService] Missed-dose sweep pinged ${pinged} patients`);
        } catch (error) {
            logger.error('[SchedulerService] Error running missed-dose sweep:', error);
        }
    }

    /**
     * Supply-based refill forecast sweep. Delegates to MedicationLifecycleService.
     * 3 days before run-out → in-app reminder; last day → WhatsApp final nudge;
     * overdue → clinician notification (once per 48h).
     * Runs: daily at 9am
     */
    async runMedicationRefillForecast() {
        try {
            const { runRefillForecastSweep } = await import('./medicationLifecycle.service.js');
            const sent = await runRefillForecastSweep();
            logger.info(`[SchedulerService] Refill forecast sweep sent ${sent} reminders`);
        } catch (error) {
            logger.error('[SchedulerService] Error running refill forecast sweep:', error);
        }
    }

    /**
     * Daily check-in reminder — sent at 10:00 AM to patients who haven't
     * completed today's check-in. Quiet-hours: skip patients whose
     * NotificationPreference disables push.
     */
    async sendDailyCheckInReminders() {
        try {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);

            // Patients with no DailyCheckIn today
            const patients = await prisma.patient.findMany({
                where: {
                    onboardingCompleted: true,
                    NOT: { dailyCheckIns: { some: { createdAt: { gte: todayStart } } } },
                },
                include: { user: { select: { id: true } } },
                take: 500,
            });

            let sent = 0;
            for (const patient of patients) {
                if (!patient.user?.id) continue;
                const pref = await prisma.notificationPreference.findUnique({
                    where: { userId: patient.user.id },
                });
                if (pref && !pref.pushEnabled && !pref.whatsappEnabled) continue;

                await notificationService.createNotification({
                    userId: patient.user.id,
                    type: 'DAILY_CHECKIN_REMINDER',
                    title: 'Time for your daily check-in',
                    message: 'Take 60 seconds to log how you\'re feeling today. Your care team uses this to track your progress.',
                    priority: 'MEDIUM',
                    data: { kind: 'OPEN_CHECKIN_MODAL' },
                });
                sent++;
            }

            logger.info(`[SchedulerService] Daily check-in reminders sent: ${sent}`);
        } catch (error) {
            logger.error('[SchedulerService] Error sending daily check-in reminders:', error);
        }
    }

    /**
     * Wellness decline detection — flags patients whose 3 most recent check-ins
     * show monotonically rising pain levels and sends an encouragement message.
     */
    async detectWellnessDecline() {
        try {
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const recentCheckIns = await prisma.dailyCheckIn.findMany({
                where: { createdAt: { gte: sevenDaysAgo } },
                orderBy: { createdAt: 'desc' },
                include: { patient: { include: { user: true } } },
            });

            // Group by patient, take 3 most recent
            const byPatient = new Map();
            for (const c of recentCheckIns) {
                if (!byPatient.has(c.patientId)) byPatient.set(c.patientId, []);
                if (byPatient.get(c.patientId).length < 3) byPatient.get(c.patientId).push(c);
            }

            let alerted = 0;
            for (const [, list] of byPatient) {
                if (list.length < 3) continue;
                const [a, b, c] = list; // most recent first
                if (a.painLevel > b.painLevel && b.painLevel > c.painLevel && a.painLevel >= 6) {
                    const userId = list[0].patient?.user?.id;
                    if (!userId) continue;
                    await notificationService.createNotification({
                        userId,
                        type: 'WELLNESS_DECLINE',
                        title: 'We\'re here to help',
                        message: 'Your pain levels have risen for 3 days in a row. Consider messaging your doctor or completing a fresh check-in.',
                        priority: 'HIGH',
                        data: { kind: 'OPEN_CHECKIN_MODAL' },
                    });
                    alerted++;
                }
            }
            logger.info(`[SchedulerService] Wellness decline alerts sent: ${alerted}`);
        } catch (error) {
            logger.error('[SchedulerService] Error in detectWellnessDecline:', error);
        }
    }

    /**
     * Detect prescriptions expiring within the next 5 days and notify patients
     */
    async checkExpiringPrescriptions() {
        try {
            const { RefillService } = await import('./refill.service.js');
            const count = await RefillService.detectExpiringPrescriptions(5);
            logger.info(`[SchedulerService] Expiry alerts sent for ${count} prescriptions`);
        } catch (error) {
            logger.error('[SchedulerService] Error checking expiring prescriptions:', error);
        }
    }

    /**
     * No-show detection: 30 min after appointment start, if status still PENDING → mark as NO_SHOW.
     *
     * Also flips the live QueueEntry to ABSENT (if one exists or the
     * appointment is queueable) so the branch admin's Live Queue Board
     * lights up the absent patient automatically without waiting for
     * manual detection. The PatientQueueService.markAbsent helper emits
     * the patient_absent Socket.IO event to the branch room, so the
     * Live Queue Board's "Contact Patient" affordance appears in real
     * time and notifies the branch admin.
     */
    async detectNoShows() {
        try {
            const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
            const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000);

            const noShows = await prisma.appointment.findMany({
                where: {
                    date: { gte: sixtyMinAgo, lte: thirtyMinAgo },
                    status: { in: ['PENDING', 'CONFIRMED', 'ACCEPTED'] },
                    arrivalStatus: { in: ['NOT_ARRIVED'] },
                },
                include: { patient: { include: { user: true } }, branch: true },
            });

            // Lazy import to avoid a circular dep (queue service imports
            // websocket → websocket pulls prisma → prisma is fine, but the
            // queue service calls scheduler types in tests).
            const { PatientQueueService } = await import('./patientQueue.service.js');

            for (const appt of noShows) {
                await prisma.appointment.update({
                    where: { id: appt.id },
                    data: { status: 'NO_SHOW' },
                });

                // Mirror onto the queue board → ABSENT. Best-effort: only
                // queueable appointments (with a doctorId + branchId) go
                // through this path; rest fall back to legacy NO_SHOW only.
                if (appt.doctorId && appt.branchId) {
                    try {
                        await PatientQueueService.markAbsent(appt.id, { actorUserId: null });
                    } catch (qErr) {
                        logger.warn('[SchedulerService] queue markAbsent hook failed', {
                            appointmentId: appt.id, err: qErr.message,
                        });
                    }
                }

                // Audit event
                logger.audit('APPOINTMENT_NO_SHOW', null, appt.id, {
                    patientId: appt.patientId,
                    scheduledDate: appt.date,
                });

                // Notify patient
                if (appt.patient?.userId) {
                    await notificationService.createNotification({
                        userId: appt.patient.userId,
                        type: 'NO_SHOW',
                        title: 'Missed Appointment',
                        message: 'You missed your scheduled appointment. Please rebook at your earliest convenience.',
                        priority: 'MEDIUM',
                        data: { appointmentId: appt.id },
                    });
                }

                // Notify branch admins so they can immediately initiate
                // the absent-patient contact flow from the Live Queue Board.
                if (appt.branchId) {
                    try {
                        const branchAdmins = await prisma.user.findMany({
                            where: { branchId: appt.branchId, role: 'BRANCH_ADMIN' },
                            select: { id: true },
                        });
                        await Promise.all(branchAdmins.map((admin) =>
                            notificationService.createNotification({
                                userId: admin.id,
                                type: 'PATIENT_ABSENT',
                                title: 'Patient marked absent',
                                message: `${appt.patient?.fullName || 'A patient'} did not arrive for their scheduled appointment. Reach out from the Live Queue Board.`,
                                priority: 'HIGH',
                                relatedId: appt.id,
                                data: { appointmentId: appt.id, branchId: appt.branchId },
                            }).catch(() => null),
                        ));
                    } catch (notifErr) {
                        logger.warn('[SchedulerService] branch admin no-show notify failed', {
                            err: notifErr.message,
                        });
                    }
                }
            }

            if (noShows.length > 0) {
                logger.info(`[SchedulerService] Marked ${noShows.length} appointments as NO_SHOW`);
            }
        } catch (error) {
            logger.error('[SchedulerService] Error detecting no-shows:', error);
        }
    }

    /**
     * Post-appointment CSAT: send feedback request 2-3 hours after completed appointment.
     */
    async sendCSATSurveys() {
        try {
            // `csatSentAt` is the idempotency flag — the old 1-hour window could
            // drop surveys on cron blips or duplicate them across overlapping runs.
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

            const appointments = await prisma.appointment.findMany({
                where: {
                    status: 'COMPLETED',
                    updatedAt: { lte: twoHoursAgo },
                    csatSentAt: null,
                    feedback: null,
                },
                include: { patient: true, doctor: { include: { user: true } } }
            });

            for (const appt of appointments) {
                if (!appt.patient?.userId) continue;

                // Claim the survey slot first — updateMany with the csatSentAt=null
                // guard acts as a CAS, so only one cron run can send per appointment
                // even if runs overlap.
                const claimed = await prisma.appointment.updateMany({
                    where: { id: appt.id, csatSentAt: null },
                    data: { csatSentAt: new Date() },
                });
                if (claimed.count === 0) continue;

                const doctorName = appt.doctor?.fullName || 'your doctor';
                await notificationService.createNotification({
                    userId: appt.patient.userId,
                    type: 'FEEDBACK_REQUEST',
                    title: 'How was your visit?',
                    message: `Please rate your appointment with ${doctorName}`,
                    actionUrl: `/appointments/${appt.id}/feedback`,
                    priority: 'LOW',
                    data: { appointmentId: appt.id },
                });
            }

            if (appointments.length > 0) {
                logger.info(`[SchedulerService] Sent ${appointments.length} CSAT survey requests`);
            }
        } catch (error) {
            logger.error('[SchedulerService] Error sending CSAT surveys:', error);
        }
    }

    /**
     * 24-hour reminder for the 4-question post-consultation feedback flow.
     * Fires at most once per appointment; expiry is handled by the read-time
     * 48h cutoff inside ConsultationFeedbackService.getPending.
     */
    async sendConsultationFeedbackReminders() {
        try {
            const { ConsultationFeedbackService } = await import('./consultationFeedback.service.js');
            const sent = await ConsultationFeedbackService.sendRemindersForPending();
            if (sent > 0) {
                logger.info(`[SchedulerService] Consultation-feedback reminders: ${sent} sent`);
            }
        } catch (error) {
            logger.error('[SchedulerService] Error sending consultation-feedback reminders:', error);
        }
    }

    /**
     * 72h reminder push for end-of-journey feedback rows the patient hasn't
     * engaged with. Idempotent via reminderSentAt stamp on each row.
     */
    async sendJourneyFeedbackReminders() {
        try {
            const { JourneyFeedbackService } = await import('./journeyFeedback.service.js');
            const sent = await JourneyFeedbackService.sendRemindersForPending();
            if (sent > 0) {
                logger.info(`[SchedulerService] Journey-feedback reminders: ${sent} sent`);
            }
        } catch (error) {
            logger.error('[SchedulerService] Error sending journey-feedback reminders:', error);
        }
    }

    /**
     * Advanced care gap detection across 5 dimensions.
     */
    async runCareGapDetection() {
        try {
            const { CareGapService } = await import('./careGap.service.js');
            const alerts = await CareGapService.detectAndNotify();
            logger.info(`[SchedulerService] Care gap detection: ${alerts} alerts sent`);
        } catch (error) {
            logger.error('[SchedulerService] Error in care gap detection:', error);
        }
    }

    /**
     * Stop all scheduled jobs
     */
    stopAll() {
        logger.info('[SchedulerService] Stopping all jobs...');
        this.jobs.forEach((job) => job.stop());
    }
}

export const schedulerService = new SchedulerService();
