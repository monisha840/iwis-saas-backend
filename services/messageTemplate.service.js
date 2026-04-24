/**
 * MessageTemplate Service — CRUD + preview for the hospital-scoped template library.
 *
 * RBAC (enforced here, not in the router):
 *   - List / preview  : any authenticated staff role
 *   - Create / Update : ADMIN, ADMIN_DOCTOR, DOCTOR (doctors can only edit their own)
 *   - Delete          : ADMIN, ADMIN_DOCTOR (doctors cannot delete — soft-disable via isActive)
 *
 * Hospital scope: every operation is implicitly filtered by `user.hospitalId`;
 * SUPER_ADMIN can pass an explicit `hospitalId` override.
 */

import prisma from '../lib/prisma.js';
import { renderTemplate, extractPlaceholders, buildAppointmentContext, STANDARD_PLACEHOLDERS } from '../lib/templateRenderer.js';

const WRITE_ROLES = new Set(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']);
const ADMIN_ROLES = new Set(['ADMIN', 'ADMIN_DOCTOR']);

export class MessageTemplateService {
    static async list(user, { category, isActive, search, hospitalId } = {}) {
        const scope = resolveHospitalScope(user, hospitalId);
        const where = { hospitalId: scope };
        if (category) where.category = category;
        if (typeof isActive === 'boolean') where.isActive = isActive;
        if (search) where.name = { contains: search, mode: 'insensitive' };

        return prisma.messageTemplate.findMany({
            where,
            orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
            include: {
                createdBy: { select: { id: true, email: true } },
                updatedBy: { select: { id: true, email: true } },
            },
        });
    }

    static async getById(user, id) {
        const row = await prisma.messageTemplate.findUnique({
            where: { id },
            include: {
                createdBy: { select: { id: true, email: true } },
                updatedBy: { select: { id: true, email: true } },
            },
        });
        if (!row) throw notFound('Template not found');
        if (row.hospitalId !== user.hospitalId && user.role !== 'SUPER_ADMIN') {
            throw forbidden('Template belongs to another hospital');
        }
        return row;
    }

    static async create(user, data) {
        if (!WRITE_ROLES.has(user.role) && user.role !== 'SUPER_ADMIN') {
            throw forbidden('Role cannot create templates');
        }
        const scope = resolveHospitalScope(user, data.hospitalId);
        const payload = sanitizeInput(data);
        assertRequired(payload);

        if (payload.isDefault) {
            await clearDefaultsFor(scope, payload.category);
        }

        return prisma.messageTemplate.create({
            data: {
                hospitalId: scope,
                name: payload.name,
                category: payload.category,
                body: payload.body,
                subject: payload.subject || null,
                channels: payload.channels && payload.channels.length ? payload.channels : ['WHATSAPP'],
                placeholders: extractPlaceholders(payload.body),
                isDefault: payload.isDefault || false,
                isActive: payload.isActive ?? true,
                createdByUserId: user.id,
                updatedByUserId: user.id,
            },
        });
    }

    static async update(user, id, data) {
        const existing = await prisma.messageTemplate.findUnique({ where: { id } });
        if (!existing) throw notFound('Template not found');
        assertEditable(user, existing);

        const payload = sanitizeInput(data, { partial: true });

        if (payload.isDefault === true) {
            await clearDefaultsFor(existing.hospitalId, payload.category || existing.category, id);
        }

        return prisma.messageTemplate.update({
            where: { id },
            data: {
                ...(payload.name !== undefined && { name: payload.name }),
                ...(payload.category !== undefined && { category: payload.category }),
                ...(payload.body !== undefined && {
                    body: payload.body,
                    placeholders: extractPlaceholders(payload.body),
                }),
                ...(payload.subject !== undefined && { subject: payload.subject }),
                ...(payload.channels !== undefined && { channels: payload.channels }),
                ...(payload.isDefault !== undefined && { isDefault: payload.isDefault }),
                ...(payload.isActive !== undefined && { isActive: payload.isActive }),
                updatedByUserId: user.id,
            },
        });
    }

    static async remove(user, id) {
        const existing = await prisma.messageTemplate.findUnique({ where: { id } });
        if (!existing) throw notFound('Template not found');

        if (!ADMIN_ROLES.has(user.role) && user.role !== 'SUPER_ADMIN') {
            throw forbidden('Only admins can delete templates. Doctors can toggle isActive instead.');
        }
        if (existing.hospitalId !== user.hospitalId && user.role !== 'SUPER_ADMIN') {
            throw forbidden('Template belongs to another hospital');
        }

        await prisma.messageTemplate.delete({ where: { id } });
        return { success: true };
    }

    /**
     * Render a template against a sample context. Accepts either `{ body }` directly
     * or `{ templateId, appointmentId }` to pull a stored template and build a real context.
     */
    static async preview(user, { body, subject, templateId, appointmentId, context }) {
        let templateBody = body;
        let templateSubject = subject;
        if (templateId) {
            const t = await this.getById(user, templateId);
            templateBody = t.body;
            templateSubject = t.subject;
        }
        if (!templateBody) throw badRequest('Provide `body` or a valid `templateId`');

        let ctx = context || sampleContext();
        if (appointmentId) {
            ctx = await buildContextFromAppointment(user, appointmentId);
        }

        return {
            subject: templateSubject ? renderTemplate(templateSubject, ctx) : null,
            body: renderTemplate(templateBody, ctx),
            placeholders: extractPlaceholders(templateBody),
            contextUsed: ctx,
        };
    }

    static listStandardPlaceholders() {
        return STANDARD_PLACEHOLDERS;
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveHospitalScope(user, requestedHospitalId) {
    if (user.role === 'SUPER_ADMIN') {
        if (!requestedHospitalId) throw badRequest('SUPER_ADMIN must pass hospitalId');
        return requestedHospitalId;
    }
    if (!user.hospitalId) throw badRequest('User has no hospital context');
    return user.hospitalId;
}

function sanitizeInput(data, { partial = false } = {}) {
    const out = {};
    if (data.name !== undefined) out.name = String(data.name).trim();
    if (data.category !== undefined) out.category = String(data.category);
    if (data.body !== undefined) out.body = String(data.body);
    if (data.subject !== undefined) out.subject = data.subject ? String(data.subject) : null;
    if (data.channels !== undefined) {
        out.channels = Array.isArray(data.channels) ? data.channels.map((c) => String(c).toUpperCase()) : [];
    }
    if (data.isDefault !== undefined) out.isDefault = !!data.isDefault;
    if (data.isActive !== undefined) out.isActive = !!data.isActive;

    if (!partial) {
        if (!out.name) throw badRequest('name is required');
        if (!out.category) throw badRequest('category is required');
        if (!out.body || !out.body.trim()) throw badRequest('body is required');
    }

    if (out.category && !['DAILY_CHECKIN', 'APPOINTMENT_CONFIRMATION', 'APPOINTMENT_REMINDER', 'CUSTOM'].includes(out.category)) {
        throw badRequest(`category must be one of DAILY_CHECKIN|APPOINTMENT_CONFIRMATION|APPOINTMENT_REMINDER|CUSTOM`);
    }
    if (out.channels) {
        for (const c of out.channels) {
            if (!['WHATSAPP', 'SMS', 'EMAIL', 'IN_APP'].includes(c)) {
                throw badRequest(`channel "${c}" is not supported`);
            }
        }
    }

    return out;
}

function assertRequired(payload) {
    if (!payload.name) throw badRequest('name is required');
    if (!payload.category) throw badRequest('category is required');
    if (!payload.body) throw badRequest('body is required');
}

function assertEditable(user, template) {
    if (user.role === 'SUPER_ADMIN') return;
    if (template.hospitalId !== user.hospitalId) throw forbidden('Template belongs to another hospital');
    if (ADMIN_ROLES.has(user.role)) return;
    if (user.role === 'DOCTOR' && template.createdByUserId !== user.id) {
        throw forbidden('Doctors can only edit templates they authored');
    }
    if (!WRITE_ROLES.has(user.role)) throw forbidden('Role cannot edit templates');
}

async function clearDefaultsFor(hospitalId, category, exceptId = null) {
    await prisma.messageTemplate.updateMany({
        where: {
            hospitalId,
            category,
            isDefault: true,
            ...(exceptId ? { NOT: { id: exceptId } } : {}),
        },
        data: { isDefault: false },
    });
}

async function buildContextFromAppointment(user, appointmentId) {
    const appt = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
            doctor: true,
            therapist: true,
            patient: true,
            branch: { include: { hospital: true } },
        },
    });
    if (!appt) throw notFound('Appointment not found');
    const hospital = appt.branch?.hospital || null;
    if (hospital && hospital.id !== user.hospitalId && user.role !== 'SUPER_ADMIN') {
        throw forbidden('Appointment belongs to another hospital');
    }
    return buildAppointmentContext({
        appointment: appt,
        hospital,
        patient: appt.patient,
        doctor: appt.doctor,
        therapist: appt.therapist,
        branch: appt.branch,
    });
}

function sampleContext() {
    return {
        patientName: 'Chellakannu',
        doctorName: 'Dr. Saleem',
        therapistName: 'Ms. Devi',
        clinicianName: 'Dr. Saleem',
        appointmentDate: 'Thursday, 24 April 2026',
        appointmentTime: '10:30 AM',
        appointmentDateTime: 'Thursday, 24 April 2026 at 10:30 AM',
        branchName: 'Al-Shifa Trichy',
        hospitalName: 'Al-Shifa Group of Hospitals',
        meetingLink: 'https://meet.jit.si/al-shifa-sample',
        estimatedTime: '30 minutes',
        checkInLink: 'https://app.alshifa.health/patient',
    };
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function forbidden(msg)  { const e = new Error(msg); e.status = 403; return e; }
function notFound(msg)   { const e = new Error(msg); e.status = 404; return e; }
