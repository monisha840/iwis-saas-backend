import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { cacheService } from './cache.service.js';

// The five structured follow-up categories every clinician must review.
export const CHECKLIST_CATEGORIES = [
    'GENERAL_ROUTINE',
    'DIET',
    'YOGA_EXERCISE',
    'THERAPY_HOME',
    'OTHERS',
];

const VALID_STATUSES = ['COMPLETED', 'PARTIAL', 'NOT_FOLLOWED'];
const ALLOWED_ROLES  = ['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR', 'ADMIN'];

/**
 * Validate and normalise checklist item array.
 * Returns a cleaned array or throws with a descriptive message.
 */
function validateItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
        throw Object.assign(new Error('items must be a non-empty array'), { status: 422 });
    }

    const seenCategories = new Set();
    return items.map((item, idx) => {
        if (!item || typeof item !== 'object') {
            throw Object.assign(new Error(`items[${idx}]: must be an object`), { status: 422 });
        }

        const { category, status, notes } = item;

        if (!CHECKLIST_CATEGORIES.includes(category)) {
            throw Object.assign(
                new Error(`items[${idx}]: invalid category "${category}". Must be one of: ${CHECKLIST_CATEGORIES.join(', ')}`),
                { status: 422 }
            );
        }
        if (seenCategories.has(category)) {
            throw Object.assign(
                new Error(`items[${idx}]: duplicate category "${category}". Each category must appear at most once.`),
                { status: 422 }
            );
        }
        seenCategories.add(category);

        if (!VALID_STATUSES.includes(status)) {
            throw Object.assign(
                new Error(`items[${idx}]: invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`),
                { status: 422 }
            );
        }

        return {
            category,
            status,
            notes: notes ? String(notes).slice(0, 1000) : null,
        };
    });
}

export class RetentionChecklistService {
    /**
     * Upsert a retention checklist for an appointment.
     * Access: DOCTOR, THERAPIST, ADMIN_DOCTOR who owns or is assigned to the appointment.
     */
    static async upsert(user, appointmentId, rawItems) {
        const { id: userId, role } = user;

        if (!ALLOWED_ROLES.includes(role)) {
            throw Object.assign(new Error('Access denied'), { status: 403 });
        }

        // Validate appointment exists and belongs to this clinician (branch-aware)
        const appointment = await prisma.appointment.findUnique({
            where: { id: appointmentId },
            select: {
                id: true,
                patientId: true,
                branchId: true,
                doctorId: true,
                therapistId: true,
                doctor:    { select: { userId: true } },
                therapist: { select: { userId: true } },
            },
        });

        if (!appointment) {
            throw Object.assign(new Error('Appointment not found'), { status: 404 });
        }

        // Role-based appointment ownership check
        const isAdmin = role === 'ADMIN' || role === 'ADMIN_DOCTOR';
        const isAssignedDoctor    = appointment.doctor?.userId    === userId;
        const isAssignedTherapist = appointment.therapist?.userId === userId;

        if (!isAdmin && !isAssignedDoctor && !isAssignedTherapist) {
            throw Object.assign(new Error('You are not assigned to this appointment'), { status: 403 });
        }

        // Branch-lock for non-super-admin roles
        const userRecord = await prisma.user.findUnique({ where: { id: userId }, select: { branchId: true } });
        if (userRecord?.branchId && !isAdmin && appointment.branchId && appointment.branchId !== userRecord.branchId) {
            throw Object.assign(new Error('Cross-branch access denied'), { status: 403 });
        }

        const cleanedItems = validateItems(rawItems);

        const checklist = await prisma.retentionChecklist.upsert({
            where: { appointmentId },
            create: {
                appointmentId,
                patientId:     appointment.patientId,
                clinicianId:   userId,
                clinicianRole: role,
                items:         cleanedItems,
                branchId:      appointment.branchId ?? userRecord?.branchId ?? null,
            },
            update: {
                items:      cleanedItems,
                clinicianId:   userId,
                clinicianRole: role,
                updatedAt: new Date(),
            },
            include: {
                appointment: { select: { id: true, date: true, status: true } },
            },
        });

        logger.info(`RetentionChecklist upserted [appointmentId: ${appointmentId}, clinician: ${userId}]`);

        // ── Gamification: invalidate leaderboard cache so the next fetch re-derives
        // the consistency metric which accounts for active clinical follow-up days.
        const clinicianProfileId = await this._resolveClinicianProfileId(userId, role);
        if (clinicianProfileId) {
            const branchKey = appointment.branchId ? `leaderboard:${appointment.branchId}` : null;
            await Promise.allSettled([
                cacheService.delete(`leaderboard:global`).catch(() => {}),
                branchKey ? cacheService.delete(branchKey).catch(() => {}) : Promise.resolve(),
            ]);
        }

        return checklist;
    }

    /**
     * Fetch the checklist for a single appointment.
     * Access: DOCTOR/THERAPIST assigned to the appointment, ADMIN, or the PATIENT themselves.
     */
    static async getByAppointment(user, appointmentId) {
        const { id: userId, role } = user;

        const checklist = await prisma.retentionChecklist.findUnique({
            where: { appointmentId },
            include: {
                appointment: { select: { id: true, date: true, status: true, patientId: true, doctor: { select: { userId: true } }, therapist: { select: { userId: true } } } },
            },
        });

        if (!checklist) return null;  // null is valid — not yet submitted

        // Access control
        const isAdmin    = role === 'ADMIN' || role === 'ADMIN_DOCTOR';
        const isAssigned = checklist.appointment?.doctor?.userId === userId || checklist.appointment?.therapist?.userId === userId;

        if (role === 'PATIENT') {
            const patient = await prisma.patient.findUnique({ where: { userId }, select: { id: true } });
            if (!patient || checklist.patientId !== patient.id) {
                throw Object.assign(new Error('Access denied'), { status: 403 });
            }
        } else if (!isAdmin && !isAssigned) {
            throw Object.assign(new Error('Access denied'), { status: 403 });
        }

        return checklist;
    }

    /**
     * Fetch all checklists for a patient (most recent first).
     * Access: ADMIN, ADMIN_DOCTOR, assigned DOCTOR/THERAPIST, or the PATIENT themselves.
     */
    static async getByPatient(user, patientId, { page = 1, limit = 20 } = {}) {
        const { id: userId, role } = user;
        const isAdmin = role === 'ADMIN' || role === 'ADMIN_DOCTOR';

        if (role === 'PATIENT') {
            const patient = await prisma.patient.findUnique({ where: { userId }, select: { id: true } });
            if (!patient || patient.id !== patientId) {
                throw Object.assign(new Error('Access denied'), { status: 403 });
            }
        } else if (!isAdmin) {
            // Doctor / Therapist: must have at least one appointment with this patient
            const clinicianId = await this._resolveClinicianProfileId(userId, role);
            const hasAppointment = clinicianId && await prisma.appointment.findFirst({
                where: {
                    patientId,
                    OR: [{ doctorId: clinicianId }, { therapistId: clinicianId }],
                },
                select: { id: true },
            });
            if (!hasAppointment) {
                throw Object.assign(new Error('Access denied'), { status: 403 });
            }
        }

        const safePage  = Math.max(1, parseInt(page, 10) || 1);
        const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
        const skip = (safePage - 1) * safeLimit;

        const [checklists, total] = await prisma.$transaction([
            prisma.retentionChecklist.findMany({
                where: { patientId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
                include: {
                    appointment: {
                        select: { id: true, date: true, status: true, consultationType: true },
                    },
                },
            }),
            prisma.retentionChecklist.count({ where: { patientId } }),
        ]);

        return {
            checklists,
            pagination: { total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) },
        };
    }

    /**
     * Retention analytics for a clinician: submitted-checklist counts grouped by status.
     * Used for the engagement/follow-up accountability metric.
     */
    static async getClinicianStats(clinicianUserId, days = 30) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const checklists = await prisma.retentionChecklist.findMany({
            where: { clinicianId: clinicianUserId, createdAt: { gte: since } },
            select: { items: true, createdAt: true },
        });

        const totalSubmitted = checklists.length;
        const categorySummary = {};
        CHECKLIST_CATEGORIES.forEach(c => { categorySummary[c] = { COMPLETED: 0, PARTIAL: 0, NOT_FOLLOWED: 0 }; });

        checklists.forEach(cl => {
            const items = Array.isArray(cl.items) ? cl.items : [];
            items.forEach(item => {
                if (item?.category && item?.status && categorySummary[item.category]) {
                    categorySummary[item.category][item.status] = (categorySummary[item.category][item.status] || 0) + 1;
                }
            });
        });

        // Distinct active follow-up days (contributes to consistency score)
        const activeDays = new Set(checklists.map(c => c.createdAt.toISOString().split('T')[0]));

        return {
            totalSubmitted,
            activeDays: activeDays.size,
            categorySummary,
            periodDays: days,
        };
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    static async _resolveClinicianProfileId(userId, role) {
        if (role === 'DOCTOR' || role === 'ADMIN_DOCTOR') {
            const d = await prisma.doctor.findUnique({ where: { userId }, select: { id: true } });
            return d?.id ?? null;
        }
        if (role === 'THERAPIST') {
            const t = await prisma.therapist.findUnique({ where: { userId }, select: { id: true } });
            return t?.id ?? null;
        }
        return null;
    }
}
