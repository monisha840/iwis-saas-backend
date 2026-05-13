/**
 * Video Service — provider-abstracted video call room management.
 *
 * Strategy:
 *   - Daily.co when DAILY_API_KEY is set (preferred — waiting room, expiry,
 *     webhook lifecycle events, SDK embed).
 *   - Jitsi Meet (public meet.jit.si) as zero-config fallback.
 *
 * Both providers return the same shape so the caller doesn't care which one
 * is active: { url, roomName, provider, expiresAt }.
 */

import crypto from 'crypto';
import logger from '../lib/logger.js';

const DAILY_API_KEY = process.env.DAILY_API_KEY;
const DAILY_DOMAIN  = process.env.DAILY_DOMAIN; // e.g. "alshifa" → rooms at alshifa.daily.co
const DAILY_WEBHOOK_SECRET = process.env.DAILY_WEBHOOK_SECRET;

const DAILY_API = 'https://api.daily.co/v1';

export const VIDEO_PROVIDER = DAILY_API_KEY ? 'daily' : 'jitsi';

// ────────────────────────────────────────────────────────────────────────
// Daily.co provider
// ────────────────────────────────────────────────────────────────────────

async function dailyCreateRoom({ appointmentId, startAt, endAt }) {
    // Room name: short, stable, tied to appointment — easy to look up on webhook.
    const roomName = `appt-${appointmentId.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}`;

    // `nbf` = not before (join window opens 15 min before start).
    // `exp` = expiry (room destroyed 2h after end).
    const nbf = Math.floor((startAt.getTime() - 15 * 60_000) / 1000);
    const exp = Math.floor((endAt.getTime()   + 120 * 60_000) / 1000);

    const body = {
        name: roomName,
        privacy: 'public', // public + knocking gives waiting-room UX without needing per-user tokens
        properties: {
            exp,
            nbf,
            enable_knocking:      true,  // waiting room — owner must admit
            enable_prejoin_ui:    true,
            enable_chat:          true,
            enable_screenshare:   true,
            start_video_off:      false,
            start_audio_off:      false,
            // Auto-destroy the room 2h past the scheduled end.
            eject_at_room_exp:    true,
        },
    };

    const res = await fetch(`${DAILY_API}/rooms`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${DAILY_API_KEY}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Daily.co createRoom ${res.status}: ${text}`);
    }
    const room = await res.json();
    return {
        provider:  'daily',
        roomName:  room.name,
        url:       room.url,
        expiresAt: new Date(exp * 1000),
    };
}

async function dailyDeleteRoom(roomName) {
    if (!roomName) return;
    try {
        await fetch(`${DAILY_API}/rooms/${encodeURIComponent(roomName)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${DAILY_API_KEY}` },
        });
    } catch (err) {
        logger.warn('[Video] dailyDeleteRoom failed', { roomName, err: err.message });
    }
}

async function dailyGetRoom(roomName) {
    const res = await fetch(`${DAILY_API}/rooms/${encodeURIComponent(roomName)}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${DAILY_API_KEY}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Daily.co getRoom ${res.status}: ${text}`);
    }
    return res.json();
}

async function dailyCreateMeetingToken({ roomName, userId, userName, isOwner, expiresAt }) {
    const body = {
        properties: {
            room_name: roomName,
            user_id:   userId,
            user_name: userName,
            is_owner:  isOwner,
            exp:       Math.floor(expiresAt.getTime() / 1000),
        },
    };
    const res = await fetch(`${DAILY_API}/meeting-tokens`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${DAILY_API_KEY}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Daily.co createMeetingToken ${res.status}: ${text}`);
    }
    const json = await res.json();
    return json.token;
}

/**
 * Verify HMAC signature on an inbound Daily.co webhook.
 * Daily sends `x-webhook-signature` over the raw request body.
 */
function dailyVerifySignature(rawBody, signature) {
    if (!DAILY_WEBHOOK_SECRET) return false;
    if (!signature) return false;
    const expected = crypto
        .createHmac('sha256', DAILY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');
    // Constant-time comparison
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ────────────────────────────────────────────────────────────────────────
// Jitsi fallback
// ────────────────────────────────────────────────────────────────────────

function jitsiCreateRoom({ appointmentId, endAt }) {
    // Public Jitsi doesn't expose a create-room API; we just mint a random path.
    const suffix = crypto.randomBytes(12).toString('hex');
    const roomName = `al-shifa-${appointmentId.slice(0, 8)}-${suffix.slice(0, 8)}`;
    return {
        provider:  'jitsi',
        roomName,
        url:       `https://meet.jit.si/${roomName}`,
        // Jitsi rooms don't truly expire; we set a logical 2h-past-end marker
        // so the UI can hide "join" past that window.
        expiresAt: new Date(endAt.getTime() + 120 * 60_000),
    };
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

export const VideoService = {
    provider: VIDEO_PROVIDER,

    /**
     * Create a room for an appointment.
     * @param {{ appointmentId: string, startAt: Date, endAt?: Date }} input
     *   - `startAt`: scheduled start (Appointment.date)
     *   - `endAt`:   scheduled end — defaults to startAt + 30min if omitted.
     * @returns {Promise<{ provider, roomName, url, expiresAt }>}
     */
    async createRoom({ appointmentId, startAt, endAt }) {
        const start = startAt instanceof Date ? startAt : new Date(startAt);
        const end   = endAt   instanceof Date ? endAt   : new Date(start.getTime() + 30 * 60_000);

        try {
            if (DAILY_API_KEY) {
                return await dailyCreateRoom({ appointmentId, startAt: start, endAt: end });
            }
        } catch (err) {
            // If Daily.co is misconfigured, don't fail the booking — fall back to Jitsi.
            logger.error('[Video] Daily.co room creation failed — falling back to Jitsi', {
                appointmentId, err: err.message,
            });
        }
        return jitsiCreateRoom({ appointmentId, endAt: end });
    },

    async deleteRoom(roomName, provider) {
        if (provider === 'daily' && DAILY_API_KEY) {
            await dailyDeleteRoom(roomName);
        }
        // Jitsi has no server-side destroy; rooms evaporate when empty.
    },

    async getRoom(roomName, provider) {
        if (provider !== 'daily' || !DAILY_API_KEY) return null;
        return dailyGetRoom(roomName);
    },

    async createMeetingToken({ roomName, userId, userName, isOwner, expiresAt }) {
        if (!DAILY_API_KEY) return null;
        return dailyCreateMeetingToken({ roomName, userId, userName, isOwner, expiresAt });
    },

    verifyDailyWebhook(rawBody, signature) {
        return dailyVerifySignature(rawBody, signature);
    },

    /**
     * Given a meetingLink URL, pull the room name out of it. Used by the
     * webhook handler to look up the appointment when Daily.co only sends
     * us `room` in the payload.
     */
    parseRoomName(meetingLink) {
        if (!meetingLink) return null;
        try {
            const u = new URL(meetingLink);
            // Daily: https://{domain}.daily.co/{roomName}
            // Jitsi: https://meet.jit.si/{roomName}
            const path = u.pathname.replace(/^\/+/, '').split('/')[0];
            return path || null;
        } catch { return null; }
    },
};
