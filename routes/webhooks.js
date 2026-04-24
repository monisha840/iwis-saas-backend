/**
 * Inbound webhook receiver.
 *
 * Currently supports Daily.co call-lifecycle events so an online
 * appointment auto-flips to COMPLETED when everyone leaves the room — no
 * doctor tap-through required.
 *
 * Security:
 *   - HMAC signature verification (via VideoService.verifyDailyWebhook).
 *   - Uses `express.raw` locally on this route so the signature is computed
 *     against the exact bytes Daily.co sent us, not a re-serialised JSON.
 */

import express from 'express';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { VideoService } from '../services/video.service.js';
import { AppointmentService } from '../services/appointment.service.js';

const router = express.Router();

// Raw body parser — scoped to this route so global express.json() doesn't
// swallow the bytes before we can HMAC them.
const rawJson = express.raw({ type: 'application/json', limit: '128kb' });

router.post('/daily', rawJson, async (req, res) => {
    const signature = req.header('x-webhook-signature');
    const raw = req.body; // Buffer because of express.raw

    if (!VideoService.verifyDailyWebhook(raw, signature)) {
        logger.warn('[Webhook/daily] signature verification failed');
        return res.status(401).json({ error: 'invalid signature' });
    }

    let payload;
    try {
        payload = JSON.parse(raw.toString('utf8'));
    } catch {
        return res.status(400).json({ error: 'invalid json' });
    }

    const event = payload?.event_type || payload?.type;
    const roomName = payload?.payload?.room || payload?.room || null;
    logger.info('[Webhook/daily] received', { event, roomName });

    // We care about meeting-ended events for auto-completion.
    // Daily.co publishes: 'meeting.ended', 'participant.left', etc.
    if (event !== 'meeting.ended') {
        return res.status(200).json({ ok: true, ignored: true });
    }

    if (!roomName) {
        return res.status(200).json({ ok: true, ignored: 'no room name' });
    }

    // Find the appointment whose meetingLink contains this room name.
    const appointment = await prisma.appointment.findFirst({
        where: {
            consultationMode: 'ONLINE',
            meetingLink: { contains: roomName },
            status: { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'] },
        },
    });
    if (!appointment) {
        logger.info('[Webhook/daily] no open appointment matched room', { roomName });
        return res.status(200).json({ ok: true, ignored: 'no matching appointment' });
    }

    try {
        // Reuse the existing status-transition path so side effects fire
        // (zen points, CSAT cron pickup, audit).
        // Signature is (id, user, data) — synthetic system user for audit.
        await AppointmentService.updateAppointment(
            appointment.id,
            { id: 'system', role: 'ADMIN' },
            { status: 'COMPLETED' }
        );
        logger.info('[Webhook/daily] auto-completed appointment', {
            appointmentId: appointment.id, roomName,
        });
        // Best-effort: destroy the Daily.co room now that the call is over.
        VideoService.deleteRoom(roomName, 'daily').catch(() => {});
    } catch (err) {
        logger.error('[Webhook/daily] updateAppointment failed', {
            appointmentId: appointment.id, err: err.message,
        });
    }

    res.status(200).json({ ok: true });
});

export default router;
