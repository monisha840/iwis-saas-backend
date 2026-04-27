/**
 * Delivery Service
 *
 * Multi-channel message delivery with explicit fallback order and per-attempt
 * audit logging. Callers pass an ordered list of channels (e.g.
 * ['WHATSAPP','IN_APP']) — the service tries them in order until one
 * succeeds. Every attempt (SENT / FAILED / SKIPPED / FALLBACK) is written to
 * `ReminderDeliveryLog` for later review.
 *
 * Respects `NotificationPreference.whatsappEnabled` — disabled channels are
 * marked SKIPPED (not failed) and the service moves on to the next channel
 * in the list.
 *
 * Used by:
 *   - Daily check-in broadcast (scheduler)
 *   - Appointment confirmation (notification.service)
 *   - Any future reminder
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { WhatsAppService } from './whatsapp.service.js';
import { emitToUser } from '../websocket/index.js';

const DEFAULT_CHANNEL_ORDER = ['WHATSAPP', 'IN_APP'];

export class DeliveryService {
    /**
     * Send a message to a recipient through an ordered channel list, with fallback.
     *
     * @param {Object} opts
     * @param {string}   opts.userId         — target user (required for preference lookup)
     * @param {string=}  opts.hospitalId     — optional; stored on log
     * @param {string=}  opts.appointmentId  — optional; stored on log
     * @param {string=}  opts.templateId     — optional; stored on log
     * @param {'DAILY_CHECKIN'|'APPOINTMENT_CONFIRMATION'|'APPOINTMENT_REMINDER'|'MEDICATION_MISSED_FOLLOWUP'|'MEDICATION_REFILL_3D'|'MEDICATION_REFILL_LAST_DAY'} opts.kind
     * @param {string[]=} opts.channels      — ordered channel list; defaults to WA→IN_APP
     * @param {string}   opts.body           — rendered message body
     * @param {string=}  opts.subject        — kept for back-compat; unused now that email is gone
     * @param {string=}  opts.inAppTitle     — title for the in-app notification card
     * @param {string=}  opts.inAppType      — Notification.type enum value (default matches `kind`)
     *
     * @returns {Promise<{ success: boolean, attempts: Array<{channel,status,target?,externalId?,errorMessage?}> }>}
     */
    static async send(opts) {
        const {
            userId,
            hospitalId = null,
            appointmentId = null,
            templateId = null,
            kind,
            channels,
            body,
            subject = null,
            inAppTitle,
            inAppType,
        } = opts;

        if (!userId || !body || !kind) {
            throw new Error('DeliveryService.send requires userId, body, and kind');
        }

        const order = (channels && channels.length ? channels : DEFAULT_CHANNEL_ORDER)
            .map((c) => String(c).toUpperCase());

        // Resolve recipient contact + preferences
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                patient: { select: { phoneNumber: true } },
                notificationPreference: {
                    select: {
                        whatsappEnabled: true,
                        pushEnabled: true,
                        whatsappNumber: true,
                    },
                },
            },
        });

        if (!user) {
            await this._logAttempt({
                hospitalId, patientUserId: userId, appointmentId, templateId,
                kind, channel: 'IN_APP', status: 'FAILED',
                errorMessage: 'User not found', body,
            });
            return { success: false, attempts: [{ channel: 'IN_APP', status: 'FAILED', errorMessage: 'User not found' }] };
        }

        const pref = user.notificationPreference;
        const phone = user.patient?.phoneNumber || null;
        const whatsappNumber = pref?.whatsappNumber || phone;

        const attempts = [];
        let delivered = false;

        for (const channel of order) {
            // Preference gate
            if (pref) {
                if (channel === 'WHATSAPP' && pref.whatsappEnabled === false) {
                    attempts.push(await this._record({ hospitalId, userId, appointmentId, templateId, kind, channel, status: 'SKIPPED', errorMessage: 'patient has whatsapp disabled', body }));
                    continue;
                }
            }

            try {
                if (channel === 'WHATSAPP') {
                    if (!whatsappNumber) throw new Error('no whatsapp number on file');
                    const digits = normalizePhoneForWhatsApp(whatsappNumber);
                    if (!digits) throw new Error('whatsapp number invalid');
                    const result = await WhatsAppService.sendText(digits, body);
                    if (result.status === 'SKIPPED') {
                        // Service not configured — record and fall through
                        attempts.push(await this._record({ hospitalId, userId, appointmentId, templateId, kind, channel, status: 'SKIPPED', target: digits, errorMessage: 'evolution api not configured', body }));
                        continue;
                    }
                    attempts.push(await this._record({ hospitalId, userId, appointmentId, templateId, kind, channel, status: 'SENT', target: digits, externalId: result.externalId, body }));
                    delivered = true;
                    break;
                }

                if (channel === 'IN_APP') {
                    const notification = await prisma.notification.create({
                        data: {
                            userId,
                            type: inAppType || kindToNotificationType(kind),
                            title: inAppTitle || 'New message',
                            message: body.slice(0, 500),
                            priority: 'MEDIUM',
                            data: { kind, appointmentId, templateId },
                        },
                    });
                    emitToUser(userId, 'new_notification', notification);
                    attempts.push(await this._record({ hospitalId, userId, appointmentId, templateId, kind, channel, status: 'SENT', target: userId, externalId: notification.id, body }));
                    delivered = true;
                    break;
                }
            } catch (err) {
                logger.warn(`[DeliveryService] ${channel} failed`, { userId, kind, error: err.message });
                attempts.push(await this._record({ hospitalId, userId, appointmentId, templateId, kind, channel, status: 'FAILED', errorMessage: err.message, body }));
                // fall through to next channel
            }
        }

        // If we exhausted the list without delivery and the list didn't already include IN_APP, try it.
        if (!delivered && !order.includes('IN_APP')) {
            try {
                const notification = await prisma.notification.create({
                    data: {
                        userId,
                        type: inAppType || kindToNotificationType(kind),
                        title: inAppTitle || 'New message',
                        message: body.slice(0, 500),
                        priority: 'MEDIUM',
                        data: { kind, appointmentId, templateId, fallback: true },
                    },
                });
                emitToUser(userId, 'new_notification', notification);
                attempts.push(await this._record({ hospitalId, userId, appointmentId, templateId, kind, channel: 'IN_APP', status: 'FALLBACK', target: userId, externalId: notification.id, body }));
                delivered = true;
            } catch (err) {
                logger.error('[DeliveryService] in-app fallback failed', err, { userId, kind });
            }
        }

        return { success: delivered, attempts };
    }

    // ─── internal ────────────────────────────────────────────────────────────
    static async _record({ hospitalId, userId, appointmentId, templateId, kind, channel, status, target = null, externalId = null, errorMessage = null, body = null }) {
        return this._logAttempt({
            hospitalId, patientUserId: userId, appointmentId, templateId,
            kind, channel, status, target, externalId, errorMessage, body,
        });
    }

    static async _logAttempt(data) {
        try {
            const row = await prisma.reminderDeliveryLog.create({ data });
            return {
                channel: row.channel,
                status: row.status,
                target: row.target,
                externalId: row.externalId,
                errorMessage: row.errorMessage,
            };
        } catch (err) {
            // Logging is best-effort — never fail the delivery because we couldn't audit it.
            logger.warn('[DeliveryService] delivery log write failed', { error: err.message });
            return { channel: data.channel, status: data.status, errorMessage: data.errorMessage };
        }
    }
}

function kindToNotificationType(kind) {
    switch (kind) {
        case 'DAILY_CHECKIN':                return 'DAILY_CHECKIN_REMINDER';
        case 'APPOINTMENT_CONFIRMATION':     return 'APPOINTMENT_CONFIRMATION';
        case 'APPOINTMENT_REMINDER':         return 'APPOINTMENT_REMINDER';
        case 'MEDICATION_MISSED_FOLLOWUP':   return 'MEDICATION_MISSED_FOLLOWUP';
        case 'MEDICATION_REFILL_3D':         return 'MEDICATION_REFILL_3D';
        case 'MEDICATION_REFILL_LAST_DAY':   return 'MEDICATION_REFILL_LAST_DAY';
        default: return 'GENERAL';
    }
}

/** Strip non-digits, drop leading 0, prefix 91 if absent. */
function normalizePhoneForWhatsApp(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/\D/g, '');
    if (digits.startsWith('0')) digits = digits.substring(1);
    if (digits.length < 10) return null;
    return digits.startsWith('91') ? digits : `91${digits}`;
}

export const deliveryService = DeliveryService;
