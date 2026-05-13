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
    const raw = req.body;

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

    const HANDLED = new Set(['meeting.started', 'meeting.ended']);
    if (!HANDLED.has(event)) {
        return res.status(200).json({ ok: true, ignored: true });
    }

    if (!roomName) {
        return res.status(200).json({ ok: true, ignored: 'no room name' });
    }

    let appointment = await prisma.appointment.findFirst({
        where: {
            consultationMode: 'ONLINE',
            dailyRoomName: roomName,
            status: { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'] },
        },
    });
    if (!appointment) {
        appointment = await prisma.appointment.findFirst({
            where: {
                consultationMode: 'ONLINE',
                meetingLink: { contains: roomName },
                status: { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'] },
            },
        });
    }
    if (!appointment) {
        logger.info('[Webhook/daily] no open appointment matched room', { roomName, event });
        return res.status(200).json({ ok: true, ignored: 'no matching appointment' });
    }

    const now = new Date();

    if (event === 'meeting.started') {
        try {
            await prisma.appointment.update({
                where: { id: appointment.id },
                data: { videoSessionStartedAt: now },
            });
            logger.info('[Webhook/daily] marked session started', {
                appointmentId: appointment.id, roomName,
            });
        } catch (err) {
            logger.error('[Webhook/daily] failed to set videoSessionStartedAt', {
                appointmentId: appointment.id, err: err.message,
            });
        }
        return res.status(200).json({ ok: true });
    }

    try {
        await prisma.appointment.update({
            where: { id: appointment.id },
            data: { videoSessionEndedAt: now },
        });
        await AppointmentService.updateAppointment(
            appointment.id,
            { id: 'system', role: 'ADMIN' },
            { status: 'COMPLETED' }
        );
        logger.info('[Webhook/daily] auto-completed appointment', {
            appointmentId: appointment.id, roomName,
        });
        VideoService.deleteRoom(roomName, 'daily').catch(() => {});
    } catch (err) {
        logger.error('[Webhook/daily] meeting.ended handler failed', {
            appointmentId: appointment.id, err: err.message,
        });
    }

    res.status(200).json({ ok: true });
});

export default router;
