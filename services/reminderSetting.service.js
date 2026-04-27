/**
 * ReminderSetting Service — per-hospital config for the daily check-in broadcast.
 *
 * One row per hospital (enforced by @unique hospitalId). Admins and admin-doctors
 * can read / update the time, channels, and the template (or inline body) used.
 * The scheduler loads this at every tick to decide when to fire.
 */

import prisma from '../lib/prisma.js';

const ADMIN_ROLES = new Set(['ADMIN', 'ADMIN_DOCTOR']);
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const VALID_CHANNELS = new Set(['WHATSAPP', 'IN_APP']);

export class ReminderSettingService {
    /** Fetch the hospital's reminder setting; creates a default row on first read. */
    static async getOrInit(user, hospitalIdOverride) {
        const hospitalId = resolveHospital(user, hospitalIdOverride);
        const existing = await prisma.reminderSetting.findUnique({
            where: { hospitalId },
            include: { dailyReminderTemplate: true },
        });
        if (existing) return existing;
        return prisma.reminderSetting.create({
            data: { hospitalId },
            include: { dailyReminderTemplate: true },
        });
    }

    static async update(user, data, hospitalIdOverride) {
        assertAdmin(user);
        const hospitalId = resolveHospital(user, hospitalIdOverride);

        const payload = sanitize(data);

        // Validate template belongs to this hospital (if provided)
        if (payload.dailyReminderTemplateId) {
            const tpl = await prisma.messageTemplate.findUnique({
                where: { id: payload.dailyReminderTemplateId },
                select: { id: true, hospitalId: true, category: true, isActive: true },
            });
            if (!tpl) throw badRequest('Template not found');
            if (tpl.hospitalId !== hospitalId && user.role !== 'SUPER_ADMIN') {
                throw forbidden('Template belongs to another hospital');
            }
            if (!tpl.isActive) throw badRequest('Template is inactive');
        }

        await prisma.reminderSetting.upsert({
            where: { hospitalId },
            create: { hospitalId, ...payload },
            update: payload,
        });

        return this.getOrInit(user, hospitalIdOverride);
    }

    static async listDeliveries(user, { kind, limit = 100, offset = 0, hospitalId } = {}) {
        const scope = resolveHospital(user, hospitalId);
        const where = { hospitalId: scope };
        if (kind) where.kind = kind;
        const [rows, total] = await Promise.all([
            prisma.reminderDeliveryLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: Math.min(500, Number(limit) || 100),
                skip: Number(offset) || 0,
                include: { template: { select: { name: true } } },
            }),
            prisma.reminderDeliveryLog.count({ where }),
        ]);
        return { data: rows, total };
    }

    /**
     * Manually fire today's broadcast now — used by admins to test the setup.
     * Respects the stored template/channels but ignores the `dailyReminderTime`.
     */
    static async triggerNow(user, hospitalIdOverride) {
        assertAdmin(user);
        const hospitalId = resolveHospital(user, hospitalIdOverride);
        const { runDailyReminderForHospital } = await import('./dailyReminder.service.js');
        return runDailyReminderForHospital(hospitalId, { manual: true, triggeredByUserId: user.id });
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sanitize(data) {
    const out = {};
    if (data.dailyReminderEnabled !== undefined) out.dailyReminderEnabled = !!data.dailyReminderEnabled;
    if (data.dailyReminderTime !== undefined) {
        const t = String(data.dailyReminderTime).trim();
        if (!HHMM_RE.test(t)) throw badRequest('dailyReminderTime must be HH:MM (24h)');
        out.dailyReminderTime = t;
    }
    if (data.dailyReminderChannels !== undefined) {
        if (!Array.isArray(data.dailyReminderChannels) || !data.dailyReminderChannels.length) {
            throw badRequest('dailyReminderChannels must be a non-empty array');
        }
        const channels = data.dailyReminderChannels.map((c) => String(c).toUpperCase());
        for (const c of channels) {
            if (!VALID_CHANNELS.has(c)) throw badRequest(`Unsupported channel: ${c}`);
        }
        out.dailyReminderChannels = channels;
    }
    if (data.dailyReminderTemplateId !== undefined) {
        out.dailyReminderTemplateId = data.dailyReminderTemplateId || null;
    }
    if (data.dailyReminderInlineBody !== undefined) {
        out.dailyReminderInlineBody = data.dailyReminderInlineBody ? String(data.dailyReminderInlineBody) : null;
    }
    if (data.skipIfAlreadyCheckedIn !== undefined) {
        out.skipIfAlreadyCheckedIn = !!data.skipIfAlreadyCheckedIn;
    }
    return out;
}

function assertAdmin(user) {
    if (user.role === 'SUPER_ADMIN') return;
    if (!ADMIN_ROLES.has(user.role)) throw forbidden('Only admins can change reminder settings');
}

function resolveHospital(user, requestedHospitalId) {
    if (user.role === 'SUPER_ADMIN') {
        if (!requestedHospitalId) throw badRequest('SUPER_ADMIN must pass hospitalId');
        return requestedHospitalId;
    }
    if (!user.hospitalId) throw badRequest('User has no hospital context');
    return user.hospitalId;
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function forbidden(msg)  { const e = new Error(msg); e.status = 403; return e; }
