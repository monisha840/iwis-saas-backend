import { describe, it, expect, vi, beforeEach } from 'vitest';

// Silence logger
vi.mock('../../lib/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock prisma with the operations the service actually performs
const prismaMock = {
    messageTemplate: {
        findMany:  vi.fn(),
        findUnique: vi.fn(),
        create:    vi.fn(),
        update:    vi.fn(),
        delete:    vi.fn(),
        updateMany: vi.fn(),
    },
    appointment: {
        findUnique: vi.fn(),
    },
};
vi.mock('../../lib/prisma.js', () => ({ default: prismaMock }));

const { MessageTemplateService } = await import('../../services/messageTemplate.service.js');

const ADMIN_USER  = { id: 'u-admin',  role: 'ADMIN',   hospitalId: 'h1' };
const DOC_USER    = { id: 'u-doc',    role: 'DOCTOR',  hospitalId: 'h1' };
const OTHER_DOC   = { id: 'u-doc2',   role: 'DOCTOR',  hospitalId: 'h1' };
const PATIENT     = { id: 'u-pat',    role: 'PATIENT', hospitalId: 'h1' };

describe('MessageTemplateService.create', () => {
    beforeEach(() => {
        for (const tbl of Object.values(prismaMock)) for (const fn of Object.values(tbl)) fn.mockReset?.();
    });

    it('rejects a patient', async () => {
        await expect(MessageTemplateService.create(PATIENT, { name: 'x', category: 'CUSTOM', body: 'b' }))
            .rejects.toMatchObject({ status: 403 });
    });

    it('requires name/category/body', async () => {
        await expect(MessageTemplateService.create(ADMIN_USER, { body: 'b' }))
            .rejects.toMatchObject({ status: 400 });
        await expect(MessageTemplateService.create(ADMIN_USER, { name: 'x', category: 'CUSTOM' }))
            .rejects.toMatchObject({ status: 400 });
    });

    it('rejects an unknown category', async () => {
        await expect(MessageTemplateService.create(ADMIN_USER, { name: 'x', category: 'BOGUS', body: 'b' }))
            .rejects.toMatchObject({ status: 400, message: /category/ });
    });

    it('extracts placeholders and stores them', async () => {
        prismaMock.messageTemplate.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.messageTemplate.create.mockImplementation(({ data }) => Promise.resolve({ id: 't1', ...data }));

        const row = await MessageTemplateService.create(ADMIN_USER, {
            name: 'Confirmation',
            category: 'APPOINTMENT_CONFIRMATION',
            body: 'Dear {{patientName}}, see {{doctorName}}.',
        });
        expect(row.placeholders).toEqual(expect.arrayContaining(['patientName', 'doctorName']));
        expect(row.hospitalId).toBe('h1');
    });

    it('clears siblings when creating a new isDefault template', async () => {
        prismaMock.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.messageTemplate.create.mockImplementation(({ data }) => Promise.resolve({ id: 't1', ...data }));
        await MessageTemplateService.create(ADMIN_USER, {
            name: 'default-confirm', category: 'APPOINTMENT_CONFIRMATION', body: 'hi', isDefault: true,
        });
        expect(prismaMock.messageTemplate.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ hospitalId: 'h1', category: 'APPOINTMENT_CONFIRMATION', isDefault: true }),
            data: { isDefault: false },
        }));
    });
});

describe('MessageTemplateService.update (RBAC)', () => {
    beforeEach(() => {
        for (const tbl of Object.values(prismaMock)) for (const fn of Object.values(tbl)) fn.mockReset?.();
    });

    it('lets admins edit anyone\'s template in same hospital', async () => {
        prismaMock.messageTemplate.findUnique.mockResolvedValue({ id: 't1', hospitalId: 'h1', category: 'CUSTOM', createdByUserId: OTHER_DOC.id });
        prismaMock.messageTemplate.update.mockResolvedValue({ id: 't1', body: 'new' });

        await expect(MessageTemplateService.update(ADMIN_USER, 't1', { body: 'new' }))
            .resolves.toMatchObject({ id: 't1' });
    });

    it('blocks a doctor editing another doctor\'s template', async () => {
        prismaMock.messageTemplate.findUnique.mockResolvedValue({ id: 't1', hospitalId: 'h1', category: 'CUSTOM', createdByUserId: OTHER_DOC.id });
        await expect(MessageTemplateService.update(DOC_USER, 't1', { body: 'new' }))
            .rejects.toMatchObject({ status: 403 });
    });

    it('blocks cross-hospital edits', async () => {
        prismaMock.messageTemplate.findUnique.mockResolvedValue({ id: 't1', hospitalId: 'other-hosp', category: 'CUSTOM', createdByUserId: ADMIN_USER.id });
        await expect(MessageTemplateService.update(ADMIN_USER, 't1', { body: 'new' }))
            .rejects.toMatchObject({ status: 403 });
    });
});

describe('MessageTemplateService.remove', () => {
    beforeEach(() => {
        for (const tbl of Object.values(prismaMock)) for (const fn of Object.values(tbl)) fn.mockReset?.();
    });

    it('forbids doctors from deleting', async () => {
        prismaMock.messageTemplate.findUnique.mockResolvedValue({ id: 't1', hospitalId: 'h1', createdByUserId: DOC_USER.id });
        await expect(MessageTemplateService.remove(DOC_USER, 't1')).rejects.toMatchObject({ status: 403 });
    });

    it('allows admins', async () => {
        prismaMock.messageTemplate.findUnique.mockResolvedValue({ id: 't1', hospitalId: 'h1', createdByUserId: DOC_USER.id });
        prismaMock.messageTemplate.delete.mockResolvedValue({});
        await expect(MessageTemplateService.remove(ADMIN_USER, 't1')).resolves.toEqual({ success: true });
    });
});

describe('MessageTemplateService.preview', () => {
    beforeEach(() => {
        for (const tbl of Object.values(prismaMock)) for (const fn of Object.values(tbl)) fn.mockReset?.();
    });

    it('renders the sample context when no appointmentId is provided', async () => {
        const result = await MessageTemplateService.preview(ADMIN_USER, {
            body: 'Dear {{patientName}}, your appt on {{appointmentDate}}.',
        });
        expect(result.body).toContain('Dear Chellakannu');
        expect(result.placeholders.sort()).toEqual(['appointmentDate', 'patientName']);
    });

    it('loads stored template body when templateId is given', async () => {
        prismaMock.messageTemplate.findUnique.mockResolvedValue({ id: 't1', hospitalId: 'h1', body: 'Hi {{patientName}}.' });
        const result = await MessageTemplateService.preview(ADMIN_USER, { templateId: 't1' });
        expect(result.body).toBe('Hi Chellakannu.');
    });

    it('rejects preview with no body and no templateId', async () => {
        await expect(MessageTemplateService.preview(ADMIN_USER, {})).rejects.toMatchObject({ status: 400 });
    });
});
