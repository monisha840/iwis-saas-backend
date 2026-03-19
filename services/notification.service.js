import prisma from '../lib/prisma.js';
import { emitToUser } from '../websocket/index.js';

const N8N_WEBHOOK_URL = "https://n8n.srv930949.hstgr.cloud/webhook/6d090cd6-89ef-4fc3-97d1-0a6c0ca9debe";
const WEBHOOK_SECRET = "shifa-ayush-secret-token-2024";

// Track processed appointment IDs for idempotency
const processedIds = new Set();

export class NotificationService {
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
                console.log(`[NotificationService] Skipping Webhook for ${appointmentId} - Not fully approved yet.`);
                return false;
            }

            if (processedIds.has(appointmentId) || appointment.notificationSent) {
                console.log(`[NotificationService] IDEMPOTENCY - Webhook Bypassed for ${appointmentId}`);
                return false;
            }

            // 3. Dynamic Payload Construction
            const payload = this.constructWebhookPayload(appointment);

            // 4. Strict Payload Validation - Block if required data is missing
            const validation = this.validatePayload(payload);
            if (!validation.success) {
                console.error(`[NotificationService] BLOCKING WEBHOOK for ${appointmentId} - Missing Real Data: ${validation.missing.join(', ')}`);
                // Not marking as sent so it can be retried once data is corrected
                return false;
            }

            // 5. Mark as processed BEFORE dispatching to guarantee once-only behavior
            await prisma.appointment.update({
                where: { id: appointmentId },
                data: { notificationSent: true }
            });
            processedIds.add(appointmentId);

            console.log(`[NotificationService] Dispatching Extended Webhook for ${appointmentId} (Record Source Verified):`, JSON.stringify(payload, null, 2));

            // 6. Trigger webhook and wait for response
            try {
                const response = await fetch(N8N_WEBHOOK_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Webhook-Secret': WEBHOOK_SECRET
                    },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`[NotificationService] Webhook failed (${response.status}) for ${appointmentId}: ${errorText}`);
                } else {
                    console.log(`[NotificationService] Webhook delivered successfully for ${appointmentId}`);
                }
            } catch (err) {
                console.error(`[NotificationService] Error calling webhook for ${appointmentId}:`, err.message);
            }

            return true;
        } catch (error) {
            console.error(`[NotificationService] Fatal failure in webhook preparation for ${appointmentOrId}:`, error.message);
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
     * Create a notification for a user
     */
    async createNotification({ userId, type, title, message, priority = 'INFO', data = {} }) {
        try {
            const notification = await prisma.notification.create({
                data: { userId, type, title, message, priority, data }
            });

            emitToUser(userId, 'new_notification', notification);
            return notification;
        } catch (error) {
            console.error(`[NotificationService] Failed to create notification:`, error.message);
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
            console.error('[NotificationService] Failed to send low stock alert:', error.message);
            return false;
        }
    }

    /**
     * Get user notifications
     */
    async getUserNotifications(userId, { skip = 0, take = 20, unreadOnly = false } = {}) {
        const where = { userId };
        if (unreadOnly) where.isRead = false;

        const [notifications, total, unreadCount] = await Promise.all([
            prisma.notification.findMany({
                where, skip, take, orderBy: { createdAt: 'desc' }
            }),
            prisma.notification.count({ where: { userId } }),
            prisma.notification.count({ where: { userId, isRead: false } })
        ]);

        return { notifications, total, unreadCount };
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
}

export const notificationService = new NotificationService();
