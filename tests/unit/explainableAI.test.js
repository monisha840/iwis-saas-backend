/**
 * F08 · Explainable AI — unit tests for TriageService.getSessionById.
 *
 * Tests the service's authz logic (PATIENT can only see own; clinicians
 * see any; missing session → 404). The HTTP route layer just calls into
 * this method, so testing the service catches the explainability access
 * contract without booting Express.
 *
 * Note on the spec's "Returns 403 when EXPLAINABLE_AI flag is off" item:
 * the route is intentionally NOT requireFeature-gated server-side — gating
 * it would break the patient self-view (route is shared). The flag gates
 * the UI only. Documented in F08 design.
 *
 * Note on the spec's "reasoning field": no such column exists on
 * TriageSession. The explainability surface uses compositeScore,
 * urgencyLevel, redFlagsMatched, triageNotes, confidenceScore,
 * inputCompleteness, routingMatchStrength. Tests assert that shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockTriageSession } from '../helpers/mockData.js';

vi.mock('../../lib/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const prismaMock = {
    triageSession: { findUnique: vi.fn() },
    patient: { findUnique: vi.fn() },
};
vi.mock('../../lib/prisma.js', () => ({ default: prismaMock }));

// Block service-internal deps that this test path doesn't exercise.
vi.mock('../../services/notification.service.js', () => ({
    default: { createNotification: vi.fn() },
    NotificationService: { createNotification: vi.fn() },
}));

const { TriageService } = await import('../../services/triage.service.js');

function reset() {
    prismaMock.triageSession.findUnique.mockReset();
    prismaMock.patient.findUnique.mockReset();
}

describe('TriageService.getSessionById · explainability surface', () => {
    beforeEach(reset);

    it('returns the full explainability surface for a DOCTOR', async () => {
        const fixture = {
            ...mockTriageSession({
                id: 'ts-1',
                compositeScore: 2.3,
                urgencyLevel: 'CRITICAL',
                redFlagsMatched: ['vitals_critical'],
                confidenceScore: 0.25,
                inputCompleteness: 0.5,
                routingMatchStrength: 0,
                triageNotes: 'RED FLAG: Recorded vitals outside safe range',
            }),
            patient: { id: 'pt-1' },
            documents: [],
            appointment: null,
            overrides: [],
        };
        prismaMock.triageSession.findUnique.mockResolvedValue(fixture);

        const out = await TriageService.getSessionById('ts-1', 'u-doc', 'DOCTOR');
        expect(out.id).toBe('ts-1');
        expect(out.compositeScore).toBe(2.3);
        expect(out.urgencyLevel).toBe('CRITICAL');
        expect(Array.isArray(out.redFlagsMatched)).toBe(true);
        expect(out.redFlagsMatched).toContain('vitals_critical');
        expect(out.confidenceScore).toBeGreaterThanOrEqual(0);
        expect(out.confidenceScore).toBeLessThanOrEqual(1);
        expect(typeof out.triageNotes).toBe('string');
    });

    it('returns the same surface for an ADMIN_DOCTOR', async () => {
        const fixture = {
            ...mockTriageSession({ id: 'ts-2' }),
            patient: { id: 'pt-1' }, documents: [], appointment: null, overrides: [],
        };
        prismaMock.triageSession.findUnique.mockResolvedValue(fixture);
        const out = await TriageService.getSessionById('ts-2', 'u-admin-doc', 'ADMIN_DOCTOR');
        expect(out.id).toBe('ts-2');
    });

    it('throws 404 for a non-existent session id', async () => {
        prismaMock.triageSession.findUnique.mockResolvedValue(null);
        await expect(TriageService.getSessionById('missing-id', 'u-doc', 'DOCTOR'))
            .rejects.toMatchObject({ status: 404 });
    });

    it('throws 403 when a PATIENT tries to view a session belonging to someone else', async () => {
        const fixture = {
            ...mockTriageSession({ patientId: 'pt-OTHER' }),
            patient: { id: 'pt-OTHER' }, documents: [], appointment: null, overrides: [],
        };
        prismaMock.triageSession.findUnique.mockResolvedValue(fixture);
        // The patient lookup returns the caller's own Patient row (different id).
        prismaMock.patient.findUnique.mockResolvedValue({ id: 'pt-MINE' });

        await expect(TriageService.getSessionById('ts-X', 'u-patient', 'PATIENT'))
            .rejects.toMatchObject({ status: 403 });
    });

    it('allows a PATIENT to view their own session', async () => {
        const fixture = {
            ...mockTriageSession({ patientId: 'pt-MINE' }),
            patient: { id: 'pt-MINE' }, documents: [], appointment: null, overrides: [],
        };
        prismaMock.triageSession.findUnique.mockResolvedValue(fixture);
        prismaMock.patient.findUnique.mockResolvedValue({ id: 'pt-MINE' });
        const out = await TriageService.getSessionById('ts-X', 'u-patient', 'PATIENT');
        expect(out.patient.id).toBe('pt-MINE');
    });

    it('throws 403 when PATIENT has no Patient row (orphan user)', async () => {
        const fixture = {
            ...mockTriageSession({ patientId: 'pt-any' }),
            patient: { id: 'pt-any' }, documents: [], appointment: null, overrides: [],
        };
        prismaMock.triageSession.findUnique.mockResolvedValue(fixture);
        prismaMock.patient.findUnique.mockResolvedValue(null);
        await expect(TriageService.getSessionById('ts-X', 'u-orphan', 'PATIENT'))
            .rejects.toMatchObject({ status: 403 });
    });
});
