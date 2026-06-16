import prisma from '../lib/prisma.js';
import { emitToUser } from '../websocket/index.js';
import logger from '../lib/logger.js';
import config from '../config/index.js';
import { enqueueAppointmentWhatsApp } from './queue.service.js';
import { DeliveryService } from './delivery.service.js';
import { renderTemplate, buildAppointmentContext } from '../lib/templateRenderer.js';

// ─── SCALING NOTE ────────────────────────────────────────────────────────────
// The previous module-level `processedIds = new Set()` was removed.
// In-process Sets are destroyed on restart and invisible to sibling instances,
// making it impossible to scale horizontally.  Idempotency is now enforced
// exclusively via the DB `notificationSent` flag (atomic DB update) PLUS the
// Bull queue's per-jobId deduplication in enqueueAppointmentWhatsApp().
// ─────────────────────────────────────────────────────────────────────────────

// ─── WhatsApp message templates ─────────────────────────────────────────────
// Patient-facing appointment confirmations, sent over Evolution API.
// Kept verbatim — wording is signed off by hospital admin.
function buildOfflineTemplate({ patientName, clinicianName, dateAndTime, estimatedTime }) {
    return `Dear ${patientName},

This is to formally confirm that your appointment has been successfully scheduled.

You are booked for a consultation with ${clinicianName} on ${dateAndTime}.
Your estimated consultation time is ${estimatedTime}.

Kindly arrive at least 10–15 minutes prior to your scheduled time to complete any required formalities. Please bring any relevant medical records or documents for reference.

Should you require any assistance, rescheduling, or further clarification, please do not hesitate to contact the hospital administration.

Sincerely,
Al-Shifa Group of Hospitals`;
}

function buildOnlineTemplate({ patientName, clinicianName, dateAndTime, estimatedTime, meetingLink }) {
    return `Dear ${patientName},

This is to formally confirm that your online consultation has been successfully scheduled.
You are booked for a virtual consultation with ${clinicianName} on ${dateAndTime}. Your estimated consultation time is ${estimatedTime}.
Kindly join the meeting 5–10 minutes prior to your scheduled time to ensure your device, camera, and microphone are functioning properly. Please keep any relevant medical records or documents ready for reference during the session. For the best experience, we recommend using a stable internet connection and a quiet, private space.
Your meeting link: ${meetingLink}
Should you require any assistance, rescheduling, or further clarification, please do not hesitate to contact the hospital administration.
Sincerely,
Al-Shifa Group of Hospitals`;
}

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
     * Send appointment confirmation.
     *
     * Order of template selection:
     *   1. Inline `appointment.customReminderBody` (most specific override)
     *   2. `appointment.customReminderTemplate` (linked MessageTemplate)
     *   3. Hospital's default APPOINTMENT_CONFIRMATION MessageTemplate
     *   4. Hardcoded OFFLINE / ONLINE template
     *
     * Delivery uses DeliveryService when custom channels are configured on the
     * appointment (supports WA → SMS → Email fallback + per-attempt logging).
     * Otherwise it enqueues the legacy WhatsApp-only job.
     */
    async sendAppointmentConfirmation(appointmentOrId, source = 'SYSTEM') {
        try {
            let appointment = appointmentOrId;
            const appointmentId = typeof appointmentOrId === 'string' ? appointmentOrId : appointmentOrId.id;

            // 1. Fetch full details with all needed relations for message integrity
            if (typeof appointmentOrId === 'string' || !appointment.doctor || !appointment.patient || !appointment.branch || !appointment.customReminderTemplate) {
                appointment = await prisma.appointment.findUnique({
                    where: { id: appointmentId },
                    include: {
                        doctor: { include: { user: true } },
                        therapist: { include: { user: true } },
                        patient: { include: { user: true } },
                        branch: { include: { hospital: true } },
                        customReminderTemplate: true,
                    }
                });
            }

            if (!appointment) return false;

            // 2. Persistent Idempotency check + Approval State Validation
            const isApproved = this.checkFinalApprovalState(appointment);
            if (!isApproved) {
                logger.info(`[NotificationService] Skipping confirmation for ${appointmentId} - Not fully approved yet.`);
                return false;
            }
            if (appointment.notificationSent) {
                logger.info(`[NotificationService] IDEMPOTENCY - confirmation bypassed for ${appointmentId}`);
                return false;
            }

            // 3. Pick the template. Custom (inline body > linked template) wins.
            //    Otherwise look for the hospital's default APPOINTMENT_CONFIRMATION.
            //    Otherwise fall back to hardcoded OFFLINE/ONLINE template.
            const hospital = appointment.branch?.hospital || null;
            const hospitalId = hospital?.id || null;

            let body = null;
            let subject = null;
            let templateId = null;
            let channels = appointment.customReminderChannels && appointment.customReminderChannels.length
                ? appointment.customReminderChannels
                : null;

            if (appointment.customReminderBody) {
                body = appointment.customReminderBody;
                subject = appointment.customReminderSubject;
            } else if (appointment.customReminderTemplate) {
                body = appointment.customReminderTemplate.body;
                subject = appointment.customReminderTemplate.subject;
                templateId = appointment.customReminderTemplate.id;
                if (!channels) channels = appointment.customReminderTemplate.channels;
            } else if (hospitalId) {
                const defaultTpl = await prisma.messageTemplate.findFirst({
                    where: {
                        hospitalId,
                        category: 'APPOINTMENT_CONFIRMATION',
                        isDefault: true,
                        isActive: true,
                    },
                });
                if (defaultTpl) {
                    body = defaultTpl.body;
                    subject = defaultTpl.subject;
                    templateId = defaultTpl.id;
                    if (!channels) channels = defaultTpl.channels;
                }
            }

            // 4. Build the context for placeholder substitution + raw WA fallback.
            const estimatedTime = `${config.whatsapp?.defaultConsultationMinutes || 30} minutes`;
            const ctx = buildAppointmentContext({
                appointment, hospital,
                patient: appointment.patient,
                doctor: appointment.doctor,
                therapist: appointment.therapist,
                branch: appointment.branch,
                extras: { estimatedTime },
            });
            if (!ctx.patientName || !ctx.clinicianName) {
                logger.warn(`[NotificationService] BLOCKING confirmation for ${appointmentId} - Missing patient or clinician name`);
                return false;
            }
            if (appointment.consultationMode === 'ONLINE' && !ctx.meetingLink) {
                logger.warn(`[NotificationService] BLOCKING confirmation for ${appointmentId} - Online appointment without meeting link`);
                return false;
            }

            // 5. If a custom template/channels are configured, use DeliveryService
            //    (multi-channel fallback + per-attempt audit log).
            //    Otherwise fall back to the legacy single-channel WhatsApp queue path.
            if (body || (channels && channels.length)) {
                const renderedBody = renderTemplate(body || this.buildWhatsAppMessage(appointment).text, ctx);
                const renderedSubject = subject ? renderTemplate(subject, ctx) : null;
                const patientUserId = appointment.patient?.user?.id || appointment.patient?.userId;
                if (!patientUserId) {
                    logger.warn(`[NotificationService] BLOCKING confirmation for ${appointmentId} - no patient user id`);
                    return false;
                }

                const result = await DeliveryService.send({
                    userId: patientUserId,
                    hospitalId,
                    appointmentId,
                    templateId,
                    kind: 'APPOINTMENT_CONFIRMATION',
                    channels: channels && channels.length ? channels : ['WHATSAPP', 'IN_APP'],
                    body: renderedBody,
                    subject: renderedSubject || undefined,
                    inAppTitle: renderedSubject || 'Appointment confirmed',
                    inAppType: 'APPOINTMENT_CONFIRMATION',
                });

                if (result.success) {
                    await prisma.appointment.update({ where: { id: appointmentId }, data: { notificationSent: true } });
                } else {
                    logger.warn(`[NotificationService] All channels failed for ${appointmentId}`, { attempts: result.attempts });
                }
                return result.success;
            }

            // Legacy path — hardcoded OFFLINE/ONLINE WhatsApp templates through the queue
            const message = this.buildWhatsAppMessage(appointment);
            if (!message.number) {
                logger.warn(`[NotificationService] BLOCKING WhatsApp for ${appointmentId} - No phone number on patient`);
                return false;
            }
            logger.info(`[NotificationService] Enqueueing WhatsApp for ${appointmentId}`, { number: message.number });
            await enqueueAppointmentWhatsApp(appointmentId, { number: message.number, text: message.text, hospitalId });
            await prisma.appointment.update({ where: { id: appointmentId }, data: { notificationSent: true } });
            return true;
        } catch (error) {
            logger.error(`[NotificationService] Fatal failure in confirmation`, error, { appointmentOrId });
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
     * Build the WhatsApp message payload for Evolution API.
     * Picks the OFFLINE (direct) or ONLINE (virtual) template based on `consultationMode`.
     * Returns `{ number, text, patientName, clinicianName }`.
     */
    buildWhatsAppMessage(appointment) {
        const patientName = appointment.patient?.fullName || appointment.contactDetails?.fullName || null;

        // Clinician — prefer whichever is relevant for this appointment type.
        // For COMBINED we go with the doctor as the lead name (they're the principal consultant).
        const clinicianName =
            appointment.consultationType === 'THERAPIST'
                ? (appointment.therapist?.fullName || null)
                : (appointment.doctor?.fullName || appointment.therapist?.fullName || null);

        // Phone: strip non-digits, drop leading 0, prefix 91 (India) if absent.
        const rawPhone = appointment.contactDetails?.phoneNumber || appointment.patient?.phoneNumber || '';
        let digits = rawPhone.replace(/\D/g, '');
        if (digits.startsWith('0')) digits = digits.substring(1);
        const number = digits.length >= 10
            ? (digits.startsWith('91') ? digits : `91${digits}`)
            : null;

        // Date & time — use the primary consultation datetime.
        const primaryDate = appointment.date || appointment.therapistDate;
        const dateAndTime = primaryDate
            ? new Date(primaryDate).toLocaleString('en-IN', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
            })
            : '';

        const estimatedTime = `${config.whatsapp.defaultConsultationMinutes} minutes`;

        const text = appointment.consultationMode === 'ONLINE'
            ? buildOnlineTemplate({
                patientName,
                clinicianName,
                dateAndTime,
                estimatedTime,
                meetingLink: appointment.meetingLink || '',
            })
            : buildOfflineTemplate({
                patientName,
                clinicianName,
                dateAndTime,
                estimatedTime,
            });

        return { number, text, patientName, clinicianName };
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
    async createNotification({ userId, type, title, message, priority = 'INFO', data = {}, relatedId = null }) {
        try {
            const notification = await prisma.notification.create({
                data: { userId, type, title, message, priority, data, relatedId }
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
                    deletedAt: null,
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
     * Mark notification as read. Scoped by userId so a caller can only mark
     * their own notifications — previously this updated by id alone, which
     * meant any authenticated user could clear someone else's unread badge
     * by guessing IDs. Returns null if no matching row was found.
     */
    async markAsRead(notificationId, userId) {
        const result = await prisma.notification.updateMany({
            where: { id: notificationId, ...(userId ? { userId } : {}) },
            data: { isRead: true },
        });
        if (result.count === 0) return null;
        return prisma.notification.findUnique({ where: { id: notificationId } });
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

}

export const notificationService = new NotificationService();
