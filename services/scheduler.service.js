import cron from 'node-cron';
import prisma from '../lib/prisma.js';
import { notificationService } from './notification.service.js';

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
        console.log('[SchedulerService] Initializing scheduled jobs...');

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

        console.log('[SchedulerService] All jobs scheduled');
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

            console.log(`[SchedulerService] Found ${appointments.length} appointments for 24h reminders`);

            for (const appointment of appointments) {
                await notificationService.sendAppointmentReminder(appointment.id, 24);
            }
        } catch (error) {
            console.error('[SchedulerService] Error sending 24h reminders:', error);
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

            console.log(`[SchedulerService] Found ${appointments.length} appointments for 1h reminders`);

            for (const appointment of appointments) {
                await notificationService.sendAppointmentReminder(appointment.id, 1);
            }
        } catch (error) {
            console.error('[SchedulerService] Error sending 1h reminders:', error);
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

            console.log(`[SchedulerService] Cleaned up ${result.count} old notifications`);
        } catch (error) {
            console.error('[SchedulerService] Error cleaning up notifications:', error);
        }
    }

    /**
     * Stop all scheduled jobs
     */
    stopAll() {
        console.log('[SchedulerService] Stopping all jobs...');
        this.jobs.forEach((job) => job.stop());
    }
}

export const schedulerService = new SchedulerService();
