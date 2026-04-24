/**
 * Super-admin triage oversight (platform-wide).
 *
 * Cross-hospital view of the Triage v2 funnel so platform operators can:
 *   1. Monitor red-flag firing rates, urgency mix, and auto-hold conversion
 *   2. See clinician override disagreement broken down per hospital
 *   3. Manage the central SpecialtyRoute vocabulary (DB-backed routing)
 *
 * No patient PII leaves this layer — only aggregate counts and route config.
 */
import prisma from '../lib/prisma.js';
import { SuperAdminAuditService } from './superAdmin.audit.service.js';

export class SuperAdminTriageService {
    /**
     * Aggregate triage funnel across every non-decommissioned hospital for the
     * last `days` window. Groups by hospital and rolls up totals.
     */
    static async platformOverview({ days = 30 } = {}) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // One pass — fetch minimal columns, join patient→user→hospital via Prisma relation
        const [sessions, overrides, hospitals] = await Promise.all([
            prisma.triageSession.findMany({
                where: { createdAt: { gte: since } },
                select: {
                    id: true,
                    urgencyLevel: true,
                    redFlagForced: true,
                    redFlagsMatched: true,
                    compositeScore: true,
                    heldSlotClinicianId: true,
                    escalatedAfterUpdate: true,
                    reviewCount: true,
                    patient: { select: { user: { select: { hospitalId: true } } } },
                },
            }),
            prisma.triageOverride.findMany({
                where: { createdAt: { gte: since } },
                select: {
                    id: true,
                    originalUrgencyLevel: true,
                    overriddenUrgencyLevel: true,
                    originalSpecialty: true,
                    overriddenSpecialty: true,
                    triageSession: { select: { patient: { select: { user: { select: { hospitalId: true } } } } } },
                },
            }),
            prisma.hospital.findMany({
                where: { status: { not: 'DECOMMISSIONED' } },
                select: { id: true, name: true, slug: true, plan: true, status: true },
            }),
        ]);

        const byHospital = new Map();
        for (const h of hospitals) {
            byHospital.set(h.id, {
                hospital: h,
                totalSessions: 0,
                urgencyMix: { ROUTINE: 0, MODERATE: 0, URGENT: 0, CRITICAL: 0 },
                redFlagFired: 0,
                autoHeldSlots: 0,
                reTriaged: 0,
                escalatedOnReTriage: 0,
                overridesTotal: 0,
                urgencyOverrides: 0,
                specialtyOverrides: 0,
            });
        }

        // Platform totals accumulator
        const totals = {
            totalSessions: 0,
            urgencyMix: { ROUTINE: 0, MODERATE: 0, URGENT: 0, CRITICAL: 0 },
            redFlagFired: 0,
            redFlagsByType: {},
            autoHeldSlots: 0,
            reTriaged: 0,
            escalatedOnReTriage: 0,
            overridesTotal: 0,
            urgencyOverrides: 0,
            specialtyOverrides: 0,
        };

        for (const s of sessions) {
            const hid = s.patient?.user?.hospitalId;
            const bucket = (hid && byHospital.get(hid)) || null;
            totals.totalSessions++;
            if (bucket) bucket.totalSessions++;

            const lvl = s.urgencyLevel || 'ROUTINE';
            if (totals.urgencyMix[lvl] !== undefined) totals.urgencyMix[lvl]++;
            if (bucket && bucket.urgencyMix[lvl] !== undefined) bucket.urgencyMix[lvl]++;

            if (s.redFlagForced) {
                totals.redFlagFired++;
                if (bucket) bucket.redFlagFired++;
                for (const f of (s.redFlagsMatched || [])) {
                    totals.redFlagsByType[f] = (totals.redFlagsByType[f] || 0) + 1;
                }
            }
            if (s.heldSlotClinicianId) {
                totals.autoHeldSlots++;
                if (bucket) bucket.autoHeldSlots++;
            }
            if ((s.reviewCount || 0) > 0) {
                totals.reTriaged++;
                if (bucket) bucket.reTriaged++;
            }
            if (s.escalatedAfterUpdate) {
                totals.escalatedOnReTriage++;
                if (bucket) bucket.escalatedOnReTriage++;
            }
        }

        for (const o of overrides) {
            const hid = o.triageSession?.patient?.user?.hospitalId;
            const bucket = (hid && byHospital.get(hid)) || null;
            totals.overridesTotal++;
            if (bucket) bucket.overridesTotal++;

            if (o.overriddenUrgencyLevel && o.overriddenUrgencyLevel !== o.originalUrgencyLevel) {
                totals.urgencyOverrides++;
                if (bucket) bucket.urgencyOverrides++;
            }
            if (o.overriddenSpecialty && o.overriddenSpecialty !== o.originalSpecialty) {
                totals.specialtyOverrides++;
                if (bucket) bucket.specialtyOverrides++;
            }
        }

        // Override disagreement rate = overrides / sessions
        const disagreementRate = totals.totalSessions === 0
            ? 0
            : Number((totals.overridesTotal / totals.totalSessions).toFixed(3));

        const perHospital = Array.from(byHospital.values()).map(b => ({
            ...b,
            disagreementRate: b.totalSessions === 0
                ? 0
                : Number((b.overridesTotal / b.totalSessions).toFixed(3)),
        }));

        return {
            windowDays: days,
            totals: { ...totals, disagreementRate },
            perHospital,
        };
    }

    // ── Specialty Route vocabulary (platform-wide; scope lives in the row itself) ─
    static async listSpecialtyRoutes() {
        return prisma.specialtyRoute.findMany({ orderBy: [{ priority: 'desc' }, { specialty: 'asc' }] });
    }

    static async upsertSpecialtyRoute({ actorId, ip, specialty, tags, priority, isActive }) {
        if (!specialty || typeof specialty !== 'string') {
            const e = new Error('specialty is required'); e.status = 400; throw e;
        }
        const normalisedTags = (tags || []).map(t => String(t).toLowerCase().trim()).filter(Boolean);
        const before = await prisma.specialtyRoute.findUnique({ where: { specialty } });
        const row = await prisma.specialtyRoute.upsert({
            where: { specialty },
            create: {
                specialty,
                tags: normalisedTags,
                priority: priority ?? 0,
                isActive: isActive ?? true,
            },
            update: {
                tags: normalisedTags,
                priority: priority ?? 0,
                isActive: isActive ?? true,
            },
        });
        await SuperAdminAuditService.log({
            superAdminId: actorId,
            action: before ? 'TRIAGE_ROUTE_UPDATED' : 'TRIAGE_ROUTE_CREATED',
            details: { specialty, before, after: row },
            ipAddress: ip,
        });
        return row;
    }

    static async deleteSpecialtyRoute({ actorId, ip, id }) {
        const row = await prisma.specialtyRoute.findUnique({ where: { id } });
        if (!row) { const e = new Error('Route not found'); e.status = 404; throw e; }
        await prisma.specialtyRoute.delete({ where: { id } });
        await SuperAdminAuditService.log({
            superAdminId: actorId,
            action: 'TRIAGE_ROUTE_DELETED',
            details: { specialty: row.specialty, id },
            ipAddress: ip,
        });
        return { id };
    }
}
