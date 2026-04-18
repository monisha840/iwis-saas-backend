import prisma from '../lib/prisma.js';
import { emitToUser } from '../websocket/index.js';
import logger from '../lib/logger.js';
import config from '../config/index.js';
import { enqueueAppointmentWebhook } from './queue.service.js';
import { emailService } from './email.service.js';
import { smsService } from './sms.service.js';

// ─── SCALING NOTE ────────────────────────────────────────────────────────────
// The previous module-level `processedIds = new Set()` was removed.
// In-process Sets are destroyed on restart and invisible to sibling instances,
// making it impossible to scale horizontally.  Idempotency is now enforced
// exclusively via the DB `notificationSent` flag (atomic DB update) PLUS the
// Bull queue's per-jobId deduplication in enqueueAppointmentWebhook().
// ─────────────────────────────────────────────────────────────────────────────

export class NotificationService {
    /**
     * Track a delivery attempt for a notification (best-effort, never throws)
     */
    static async trackDelivery(notificationId, channel, { status, externalId, errorMessage } = {}) {
        try {
            return await prisma.notificationDelivery.create({
                data: {
                    notificationId,
                    channel,
                    status: status || 'SENT',
                    externalId: externalId || null,
                    errorMessage: errorMessage || null,
                    attemptCount: 1,
                    sentAt: status === 'SENT' || !status ? new Date() : null,
                }
            });
        } catch (err) {
            // Delivery tracking is best-effort — don't fail the notification
            console.error(`[NotificationDelivery] Failed to track ${channel} delivery:`, err.message);
        }
    }

    /**
     * Send appointment confirmation to n8n webhook
     */
    async sendAppointmentConfirmation(appointmentOrId, source = 'SYSTEM') {
        try {
            let appointment = appointmentOrId;
            const appointmentId = typeof appointmentOrId === 'string' ? appointmentOrId : appointmentOrId.id;

            // 1. Fetch full details with all needed relations for payload integrity
            if (typeof appointmentOrId === 'string' || !appointment.doctor || !appointment.patient || !appointment.branch) {
                appointment = await prisma.appointment.findUnique({
                    where: { id: appointmentId },
                    include: {
                        doctor: { include: { user: true } },
                        therapist: { include: { user: true } },
                        patient: { include: { user: true } },
                        branch: true
                    }
                });
            }

            if (!appointment) return false;

            // 2. Persistent Idempotency check + Approval State Validation
            // Only trigger if final approval state is reached for the given type
            const isApproved = this.checkFinalApprovalState(appointment);
            if (!isApproved) {
                logger.info(`[NotificationService] Skipping Webhook for ${appointmentId} - Not fully approved yet.`);
                return false;
            }

            // DB-only idempotency — no in-process Set (supports horizontal scale)
            if (appointment.notificationSent) {
                logger.info(`[NotificationService] IDEMPOTENCY - Webhook Bypassed for ${appointmentId}`);
                return false;
            }

            // 3. Dynamic Payload Construction
            const payload = this.constructWebhookPayload(appointment);

            // 4. Strict Payload Validation - Block if required data is missing
            const validation = this.validatePayload(payload);
            if (!validation.success) {
                logger.warn(`[NotificationService] BLOCKING WEBHOOK for ${appointmentId} - Missing Real Data`, { missing: validation.missing });
                // Not marking as sent so it can be retried once data is corrected
                return false;
            }

            // 5. Enqueue webhook FIRST — if enqueueing fails the flag is never set,
            //    so the next retry attempt will re-enter and try again.
            logger.info(`[NotificationService] Enqueueing webhook for ${appointmentId}`, { payload: JSON.stringify(payload) });
            await enqueueAppointmentWebhook(appointmentId, payload);

            // 6. Mark as processed ONLY after successful enqueue.
            //    DB write is atomic across replicas; Bull's jobId deduplication prevents double-fire.
            await prisma.appointment.update({
                where: { id: appointmentId },
                data: { notificationSent: true }
            });

            return true;
        } catch (error) {
            logger.error(`[NotificationService] Fatal failure in webhook preparation`, error, { appointmentOrId });
            return false;
        }
    }

    /**
     * Check if the appointment has reached the final approval state required for its type
     */
    checkFinalApprovalState(appointment) {
        const type = appointment.consultationType;
        if (type === 'DOCTOR') return appointment.doctorApproved === true;
        if (type === 'THERAPIST') return appointment.therapistApproved === true;
        if (type === 'COMBINED') return appointment.doctorApproved === true && appointment.therapistApproved === true;
        return false;
    }

    /**
     * Construct a payload exclusively from validated database records.
     * No fallbacks, no placeholders, no hardcoded strings.
     */
    constructWebhookPayload(appointment) {
        // Source Identification for Traceability
        const sourceMeta = {
            patientId: appointment.patientId,
            doctorId: appointment.doctorId,
            therapistId: appointment.therapistId,
            branchId: appointment.branchId
        };

        const patientName = appointment.patient?.fullName || appointment.contactDetails?.fullName;

        // Mobile Formatting - Strict DB Source
        let rawPhone = appointment.contactDetails?.phoneNumber || appointment.patient?.phoneNumber || "";
        let sanitizedPhone = rawPhone.replace(/\D/g, '');
        if (sanitizedPhone.startsWith('0')) sanitizedPhone = sanitizedPhone.substring(1);

        const mobileWith91 = sanitizedPhone.length >= 10
            ? (sanitizedPhone.startsWith('91') ? sanitizedPhone : `91${sanitizedPhone}`)
            : null;

        // Date & Time Helpers
        const formatDT = (date) => {
            if (!date) return { date: null, time: null };
            return {
                date: date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
                time: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            };
        };

        const docDT = formatDT(appointment.date ? new Date(appointment.date) : null);
        const therDT = formatDT(appointment.therapistDate ? new Date(appointment.therapistDate) : null);

        // Arrival Calculation (15 mins before)
        let estimatedArrival = null;
        if (appointment.consultationMode === 'OFFLINE') {
            const primaryDate = appointment.date || appointment.therapistDate;
            if (primaryDate) {
                const arrival = new Date(new Date(primaryDate).getTime() - 15 * 60000);
                estimatedArrival = arrival.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            }
        }

        // Base Schema - Strictly Data-Bound
        const basePayload = {
            appointmentId: appointment.id,
            sourceMetadata: sourceMeta,
            patientName: patientName || null,
            mobileWith91: mobileWith91,
            appointmentDate: docDT.date || therDT.date,
            bookingType: appointment.consultationType,
            consultationMedium: appointment.consultationMode,
            bookingStatus: appointment.status,
            createdAt: appointment.createdAt.toISOString(),
            branchName: appointment.branch?.name || null,
            meetingLink: appointment.consultationMode === 'ONLINE' ? appointment.meetingLink : null,
            estimatedArrivalTime: appointment.consultationMode === 'OFFLINE' ? estimatedArrival : null
        };

        const approvalTS = appointment.updatedAt.toISOString();

        // Scenario Specific Logic - Pure Participant Data
        if (appointment.consultationType === 'THERAPIST') {
            return {
                ...basePayload,
                doctorName: null,
                doctorAppointmentTime: null,
                doctorApprovedTime: null,
                therapistName: appointment.therapist?.fullName || null,
                therapistAppointmentTime: therDT.time,
                therapistApprovedTime: approvalTS
            };
        } else if (appointment.consultationType === 'DOCTOR') {
            return {
                ...basePayload,
                doctorName: appointment.doctor?.fullName || null,
                doctorAppointmentTime: docDT.time,
                doctorApprovedTime: approvalTS,
                therapistName: null,
                therapistAppointmentTime: null,
                therapistApprovedTime: null
            };
        } else {
            // COMBINED
            return {
                ...basePayload,
                doctorName: appointment.doctor?.fullName || null,
                doctorAppointmentTime: docDT.time,
                doctorApprovedTime: approvalTS,
                therapistName: appointment.therapist?.fullName || null,
                therapistAppointmentTime: therDT.time,
                therapistApprovedTime: approvalTS
            };
        }
    }

    /**
     * Strict Validation: Block webhook if critical real data is missing.
     */
    validatePayload(payload) {
        const required = ['patientName', 'mobileWith91', 'appointmentDate', 'branchName'];

        // Conditional requirements
        if (payload.consultationMedium === 'ONLINE' && !payload.meetingLink) required.push('meetingLink');
        if (payload.bookingType === 'DOCTOR' || payload.bookingType === 'COMBINED') required.push('doctorName');
        if (payload.bookingType === 'THERAPIST' || payload.bookingType === 'COMBINED') required.push('therapistName');

        const missing = required.filter(field => !payload[field]);

        return {
            success: missing.length === 0,
            missing: missing
        };
    }

    /**
     * Send a timed appointment reminder notification to the patient.
     * Called by the scheduler's 24h and 1h cron jobs.
     *
     * @param {string} appointmentId
     * @param {number} hoursAhead    - How many hours until the appointment (1 or 24)
     */
    async sendAppointmentReminder(appointmentId, hoursAhead) {
        try {
            const appointment = await prisma.appointment.findUnique({
                where: { id: appointmentId },
                include: {
                    patient: { include: { user: { select: { id: true } } } },
                    doctor:    { select: { fullName: true } },
                    therapist: { select: { fullName: true } },
                    branch:    { select: { name: true } },
                }
            });

            if (!appointment || !appointment.patient?.user?.id) return false;

            const clinicianName =
                appointment.doctor?.fullName ||
                appointment.therapist?.fullName ||
                'your clinician';

            const dateStr = new Date(appointment.date).toLocaleString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });

            const locationNote = appointment.branch?.name
                ? ` at ${appointment.branch.name}`
                : '';

            await this.createNotification({
                userId:   appointment.patient.user.id,
                type:     'APPOINTMENT_REMINDER',
                title:    `⏰ Appointment in ${hoursAhead} hour${hoursAhead !== 1 ? 's' : ''}`,
                message:  `Reminder: You have an appointment with ${clinicianName} on ${dateStr}${locationNote}. Please be ready.`,
                priority: hoursAhead <= 1 ? 'HIGH' : 'MEDIUM',
                data:     { appointmentId, hoursAhead }
            });

            return true;
        } catch (error) {
            logger.error('[NotificationService] Failed to send appointment reminder', error, { appointmentId, hoursAhead });
            return false;
        }
    }

    /**
     * Create a notification for a user
     */
    async createNotification({ userId, type, title, message, priority = 'INFO', data = {} }) {
        try {
            const notification = await prisma.notification.create({
                data: { userId, type, title, message, priority, data }
            });

            emitToUser(userId, 'new_notification', notification);

            // Track in-app delivery
            await NotificationService.trackDelivery(notification.id, 'IN_APP', { status: 'SENT' });

            return notification;
        } catch (error) {
            logger.error(`[NotificationService] Failed to create notification`, error, { userId, type });
            throw error;
        }
    }

    /**
     * Send low stock alert (HIGH priority)
     */
    async sendLowStockAlert(medicineName, quantity, branchId = null) {
        try {
            const staffToNotify = await prisma.user.findMany({
                where: {
                    role: { in: ['PHARMACIST', 'ADMIN_DOCTOR'] },
                    ...(branchId ? { branchId } : {})
                },
                select: { id: true }
            });

            for (const staff of staffToNotify) {
                await this.createNotification({
                    userId: staff.id,
                    type: 'LOW_STOCK_ALERT',
                    title: '🚨 Critical Low Stock Alert',
                    message: `Medicine "${medicineName}" is running low (${quantity} remaining). Immediate replenishment suggested.`,
                    priority: 'HIGH',
                    data: { medicineName, quantity, branchId }
                });
            }
            return true;
        } catch (error) {
            logger.error('[NotificationService] Failed to send low stock alert', error);
            return false;
        }
    }

    /**
     * Get user notifications
     */
    async getUserNotifications(userId, { page = 1, limit = 20, skip, take, unreadOnly = false } = {}) {
        const where = { userId };
        if (unreadOnly) where.isRead = false;

        // Support both legacy skip/take and new page/limit params
        const effectiveLimit = take ?? limit;
        const effectiveSkip = skip ?? ((page - 1) * effectiveLimit);

        const [notifications, total, unreadCount] = await Promise.all([
            prisma.notification.findMany({
                where, skip: effectiveSkip, take: effectiveLimit, orderBy: { createdAt: 'desc' }
            }),
            prisma.notification.count({ where: { userId } }),
            prisma.notification.count({ where: { userId, isRead: false } })
        ]);

        const effectivePage = skip != null ? Math.floor(effectiveSkip / effectiveLimit) + 1 : page;

        return {
            data: notifications,
            total,
            page: effectivePage,
            limit: effectiveLimit,
            totalPages: Math.ceil(total / effectiveLimit),
            unreadCount
        };
    }

    /**
     * Mark notification as read
     */
    async markAsRead(notificationId) {
        return await prisma.notification.update({
            where: { id: notificationId },
            data: { isRead: true }
        });
    }

    /**
     * Mark all notifications as read for a user
     */
    async markAllAsRead(userId) {
        return await prisma.notification.updateMany({
            where: { userId, isRead: false },
            data: { isRead: true }
        });
    }

    /**
     * Get unread count
     */
    async getUnreadCount(userId) {
        return await prisma.notification.count({
            where: { userId, isRead: false }
        });
    }

    /**
     * Send an email and track the delivery against a notification record
     */
    async sendTrackedEmail(notificationId, to, title, message, data = {}) {
        try {
            const result = await emailService.sendNotification(to, title, message, data);
            await NotificationService.trackDelivery(notificationId, 'EMAIL', {
                status: 'SENT',
                externalId: result?.messageId || null,
            });
            return result;
        } catch (err) {
            await NotificationService.trackDelivery(notificationId, 'EMAIL', {
                status: 'FAILED',
                errorMessage: err.message,
            });
            throw err;
        }
    }

    /**
     * Send an SMS and track the delivery against a notification record
     */
    async sendTrackedSMS(notificationId, to, message) {
        try {
            const result = await smsService.sendNotification(to, message);
            await NotificationService.trackDelivery(notificationId, 'SMS', {
                status: 'SENT',
                externalId: result?.sid || null,
            });
            return result;
        } catch (err) {
            await NotificationService.trackDelivery(notificationId, 'SMS', {
                status: 'FAILED',
                errorMessage: err.message,
            });
            throw err;
        }
    }
}

export const notificationService = new NotificationService();
