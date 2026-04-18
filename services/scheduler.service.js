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
     * Medication adherence reminders: notify patients who have active prescriptions
     * but have not logged any medication intake today.
     * Runs: daily at 8pm
     */
    async sendMedicationAdherenceReminders() {
        try {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);

            const todayEnd = new Date();
            todayEnd.setHours(23, 59, 59, 999);

            // Find prescriptions that are still within their expected active window
            // Duration is a string like "7 days", "1 month" — we compare createdAt
            // to a generous 90-day window (covers all common durations)
            const ninetyDaysAgo = new Date();
            ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

            const activePrescriptions = await prisma.prescription.findMany({
                where: { createdAt: { gte: ninetyDaysAgo } },
                include: { patient: { include: { user: true } } },
            });

            // Group by patientId to send one notification per patient (not per prescription)
            const patientMap = new Map();
            for (const rx of activePrescriptions) {
                if (!rx.patient?.userId) continue;

                // Check if patient logged any medication for this prescription today
                const logsToday = await prisma.medicationLog.count({
                    where: {
                        prescriptionId: rx.id,
                        takenAt: { gte: todayStart, lte: todayEnd },
                        taken: true,
                    },
                });

                if (logsToday === 0 && !patientMap.has(rx.patientId)) {
                    patientMap.set(rx.patientId, rx.patient);
                }
            }

            for (const [, patient] of patientMap) {
                await notificationService.createNotification({
                    userId: patient.userId,
                    type: 'MEDICATION_ADHERENCE_REMINDER',
                    title: '💊 Medication reminder',
                    message: `Don't forget to take your medication today and log it in your wellness tracker to maintain your health streak.`,
                    priority: 'LOW',
                    data: {},
                });
            }

            logger.info(`[SchedulerService] Medication adherence reminders sent to ${patientMap.size} patients`);
        } catch (error) {
            logger.error('[SchedulerService] Error sending medication adherence reminders:', error);
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
     */
    async detectNoShows() {
        try {
            const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
            const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000);

            const noShows = await prisma.appointment.findMany({
                where: {
                    date: { gte: sixtyMinAgo, lte: thirtyMinAgo },
                    status: { in: ['PENDING', 'CONFIRMED', 'ACCEPTED'] },
                },
                include: { patient: { include: { user: true } } },
            });

            for (const appt of noShows) {
                await prisma.appointment.update({
                    where: { id: appt.id },
                    data: { status: 'NO_SHOW' },
                });

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
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

            const appointments = await prisma.appointment.findMany({
                where: {
                    status: 'COMPLETED',
                    updatedAt: { gte: threeHoursAgo, lte: twoHoursAgo },
                    feedback: null,
                },
                include: { patient: true, doctor: { include: { user: true } } }
            });

            for (const appt of appointments) {
                if (!appt.patient?.userId) continue;

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
