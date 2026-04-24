import { describe, it, expect } from 'vitest';
import { renderTemplate, extractPlaceholders, buildAppointmentContext, STANDARD_PLACEHOLDERS } from '../../lib/templateRenderer.js';

describe('templateRenderer.renderTemplate', () => {
    it('substitutes a single placeholder', () => {
        expect(renderTemplate('Hi {{patientName}}!', { patientName: 'Chellakannu' }))
            .toBe('Hi Chellakannu!');
    });

    it('substitutes multiple placeholders', () => {
        const body = 'Dear {{patientName}}, your appt with {{doctorName}} is on {{appointmentDate}}.';
        const out = renderTemplate(body, {
            patientName: 'Asha', doctorName: 'Dr. Saleem', appointmentDate: 'Thu, 24 Apr',
        });
        expect(out).toBe('Dear Asha, your appt with Dr. Saleem is on Thu, 24 Apr.');
    });

    it('tolerates whitespace inside placeholders', () => {
        expect(renderTemplate('Hi {{ patientName }}!', { patientName: 'Ravi' })).toBe('Hi Ravi!');
    });

    it('renders missing keys as empty string (not the literal token)', () => {
        expect(renderTemplate('Hi {{unknownKey}}!', { patientName: 'X' })).toBe('Hi !');
    });

    it('handles null/undefined body gracefully', () => {
        expect(renderTemplate(null, { any: 'thing' })).toBe('');
        expect(renderTemplate(undefined, { any: 'thing' })).toBe('');
    });

    it('coerces non-string values', () => {
        expect(renderTemplate('Level {{level}}', { level: 7 })).toBe('Level 7');
        expect(renderTemplate('Flag {{flag}}', { flag: true })).toBe('Flag true');
    });

    it('leaves unknown syntax (single-brace) intact', () => {
        expect(renderTemplate('Hi {name}', { name: 'X' })).toBe('Hi {name}');
    });
});

describe('templateRenderer.extractPlaceholders', () => {
    it('returns unique placeholder keys', () => {
        const keys = extractPlaceholders('Dear {{patientName}}, {{patientName}} — your {{doctorName}} appt.');
        expect(keys.sort()).toEqual(['doctorName', 'patientName']);
    });

    it('returns [] for empty body', () => {
        expect(extractPlaceholders('')).toEqual([]);
        expect(extractPlaceholders(null)).toEqual([]);
    });
});

describe('templateRenderer.buildAppointmentContext', () => {
    it('composes patient + clinician + date strings', () => {
        const appointment = {
            date: new Date('2026-04-24T05:00:00Z'), // 10:30 IST
            consultationType: 'DOCTOR',
            meetingLink: 'https://meet.jit.si/test',
        };
        const ctx = buildAppointmentContext({
            appointment,
            hospital: { name: 'Al-Shifa', timezone: 'Asia/Kolkata' },
            patient: { fullName: 'Chellakannu' },
            doctor: { fullName: 'Dr. Saleem' },
            branch: { name: 'Trichy' },
        });
        expect(ctx.patientName).toBe('Chellakannu');
        expect(ctx.doctorName).toBe('Dr. Saleem');
        expect(ctx.clinicianName).toBe('Dr. Saleem');
        expect(ctx.hospitalName).toBe('Al-Shifa');
        expect(ctx.branchName).toBe('Trichy');
        expect(ctx.meetingLink).toBe('https://meet.jit.si/test');
        expect(ctx.appointmentDate).toContain('April');
        expect(ctx.appointmentTime).toMatch(/\d{1,2}:\d{2}/);
        expect(ctx.appointmentDateTime).toContain('at');
    });

    it('falls back to therapist name for THERAPIST appointments', () => {
        const ctx = buildAppointmentContext({
            appointment: { consultationType: 'THERAPIST' },
            therapist: { fullName: 'Ms. Devi' },
            patient: { fullName: 'X' },
        });
        expect(ctx.clinicianName).toBe('Ms. Devi');
    });

    it('leaves date fields blank when appointment has no date', () => {
        const ctx = buildAppointmentContext({ appointment: {}, patient: { fullName: 'X' } });
        expect(ctx.appointmentDate).toBe('');
        expect(ctx.appointmentTime).toBe('');
        expect(ctx.appointmentDateTime).toBe('');
    });
});

describe('STANDARD_PLACEHOLDERS', () => {
    it('is a non-empty array of {key, description, example}', () => {
        expect(Array.isArray(STANDARD_PLACEHOLDERS)).toBe(true);
        expect(STANDARD_PLACEHOLDERS.length).toBeGreaterThan(5);
        for (const p of STANDARD_PLACEHOLDERS) {
            expect(typeof p.key).toBe('string');
            expect(typeof p.description).toBe('string');
        }
    });
});
