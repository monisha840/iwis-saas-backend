/**
 * F07 · Multi-Agent Orchestration — unit tests.
 *
 * Covers:
 *   1. eventRegistry — register + emit + Promise.allSettled isolation
 *   2. careGapAgent — PatientCriticalFlag upsert + notification
 *   3. pharmacyAgent — active-Rx → stock check → LOW_STOCK notification
 *   4. slotHoldAgent — find free slot → create Appointment OR skip
 *   5. dashboardSummariser — settles after siblings, queries DB, notifies
 *
 * No real Prisma / Redis. The notification queue helper is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── 1. Event registry — pure ──────────────────────────────────────────────
const { registerHandler, emitEvent, _resetHandlersForTest } =
    await import('../../services/eventRegistry.js');

describe('eventRegistry', () => {
    beforeEach(() => _resetHandlersForTest());

    it('registerHandler registers a handler so emitEvent calls it', async () => {
        const fn = vi.fn().mockResolvedValue(undefined);
        registerHandler('test.event', fn, { name: 'h1' });
        const r = await emitEvent('test.event', { ping: true });
        expect(fn).toHaveBeenCalledWith({ ping: true });
        expect(r.fired).toBe(1);
        expect(r.succeeded).toBe(1);
        expect(r.failed).toBe(0);
    });

    it('emitEvent calls all registered handlers in parallel', async () => {
        const started = [];
        const ends = [];
        const slow = (ms, label) => vi.fn(async () => {
            started.push(label);
            await new Promise((r) => setTimeout(r, ms));
            ends.push(label);
        });
        registerHandler('test.event', slow(40, 'a'), { name: 'a' });
        registerHandler('test.event', slow(40, 'b'), { name: 'b' });
        registerHandler('test.event', slow(40, 'c'), { name: 'c' });

        const t0 = Date.now();
        await emitEvent('test.event', {});
        const elapsed = Date.now() - t0;

        // All three started before any finished — parallel, not sequential.
        expect(started).toHaveLength(3);
        // Sequential would be ~120ms; parallel should be ~40-60ms.
        expect(elapsed).toBeLessThan(120);
    });

    it('emitEvent completes when one handler throws', async () => {
        const good = vi.fn().mockResolvedValue('ok');
        const bad  = vi.fn().mockRejectedValue(new Error('boom'));
        registerHandler('test.event', good, { name: 'good' });
        registerHandler('test.event', bad,  { name: 'bad' });
        const r = await emitEvent('test.event', {});
        expect(r.succeeded).toBe(1);
        expect(r.failed).toBe(1);
    });

    it('emitEvent never throws regardless of handler failures', async () => {
        registerHandler('test.event', () => { throw new Error('sync throw'); }, { name: 'sync' });
        registerHandler('test.event', () => Promise.reject(new Error('async throw')), { name: 'async' });
        await expect(emitEvent('test.event', {})).resolves.toBeDefined();
    });

    it('a failed handler does not affect siblings', async () => {
        const sibling = vi.fn().mockResolvedValue('ok');
        registerHandler('test.event', () => { throw new Error('boom'); }, { name: 'bad' });
        registerHandler('test.event', sibling, { name: 'good' });
        await emitEvent('test.event', { x: 1 });
        expect(sibling).toHaveBeenCalledWith({ x: 1 });
    });

    it('emitEvent returns 0/0/0 when no handlers are registered', async () => {
        const r = await emitEvent('unregistered.event', {});
        expect(r).toEqual({ fired: 0, succeeded: 0, failed: 0 });
    });
});

// ── 2-5. Agents — all share the same Prisma mock surface ──────────────────
const prismaMock = {
    patientCriticalFlag: { findUnique: vi.fn(), upsert: vi.fn() },
    patientAssignment: { findFirst: vi.fn() },
    prescription: { findMany: vi.fn(), count: vi.fn() },
    medicineStock: { groupBy: vi.fn() },
    user: { findMany: vi.fn() },
    appointment: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
    triageSession: { findUnique: vi.fn() },
    patient: { findUnique: vi.fn() },
};
vi.mock('../../lib/prisma.js', () => ({ default: prismaMock }));

const enqueueInAppNotification = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/queue.service.js', () => ({ enqueueInAppNotification }));

// pharmacyAgent now delegates to notificationService.sendLowStockAlert so the
// canonical platform vocabulary (type LOW_STOCK_ALERT, audience including
// ADMIN_DOCTOR) is used. Mock that service for the test.
const sendLowStockAlert = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/notification.service.js', () => ({
    notificationService: { sendLowStockAlert },
    default: { sendLowStockAlert },
}));

const { careGapAgent }        = await import('../../services/agents/careGapAgent.js');
const { pharmacyAgent }       = await import('../../services/agents/pharmacyAgent.js');
const { slotHoldAgent }       = await import('../../services/agents/slotHoldAgent.js');
const { dashboardSummariser } = await import('../../services/agents/dashboardSummariser.js');

function resetAll() {
    for (const tbl of Object.values(prismaMock)) for (const fn of Object.values(tbl)) fn.mockReset?.();
    enqueueInAppNotification.mockReset();
    sendLowStockAlert.mockReset();
}

const basePayload = {
    triageSessionId: 'ts-1',
    patientId:       'pt-1',
    patientUserId:   'u-pt-1',
    urgencyLevel:    'CRITICAL',
    hospitalId:      'h-1',
    branchId:        'br-1',
};

// ── careGapAgent ──────────────────────────────────────────────────────────
describe('careGapAgent', () => {
    beforeEach(resetAll);

    it('upserts PatientCriticalFlag with CRITICAL_TRIAGE reason', async () => {
        prismaMock.patientCriticalFlag.findUnique.mockResolvedValue(null);
        prismaMock.patientCriticalFlag.upsert.mockResolvedValue({ id: 'flag-1', severity: 'HIGH', patientId: 'pt-1' });
        prismaMock.patientAssignment.findFirst.mockResolvedValue({ doctor: { userId: 'u-doc', fullName: 'Dr X' } });

        const res = await careGapAgent(basePayload);
        expect(prismaMock.patientCriticalFlag.upsert).toHaveBeenCalledTimes(1);
        const call = prismaMock.patientCriticalFlag.upsert.mock.calls[0][0];
        const reasons = call.create?.reasons ?? call.update?.reasons;
        expect(reasons.some((r) => r.type === 'CRITICAL_TRIAGE' && r.triageSessionId === 'ts-1')).toBe(true);
        expect(res.careGapRaised).toBe(true);
        expect(res.notifiedUserId).toBe('u-doc');
    });

    it('merges reasons without duplicating CRITICAL_TRIAGE when flag already exists', async () => {
        prismaMock.patientCriticalFlag.findUnique.mockResolvedValue({
            id: 'flag-prev',
            severity: 'MEDIUM',
            reasons: [
                { type: 'CRITICAL_TRIAGE', triageSessionId: 'ts-OLD' },
                { type: 'DOSHA_IMBALANCE_FORECAST', forecastId: 'fc-9' },
            ],
        });
        prismaMock.patientCriticalFlag.upsert.mockResolvedValue({ id: 'flag-prev' });
        prismaMock.patientAssignment.findFirst.mockResolvedValue(null);

        await careGapAgent(basePayload);
        const reasons = prismaMock.patientCriticalFlag.upsert.mock.calls[0][0].update.reasons;
        const criticalTriageReasons = reasons.filter((r) => r.type === 'CRITICAL_TRIAGE');
        expect(criticalTriageReasons).toHaveLength(1);
        expect(criticalTriageReasons[0].triageSessionId).toBe('ts-1');
        // Sibling DOSHA reason preserved.
        expect(reasons.some((r) => r.type === 'DOSHA_IMBALANCE_FORECAST')).toBe(true);
    });

    it('never throws when patientId is missing', async () => {
        const res = await careGapAgent({ ...basePayload, patientId: null });
        expect(res.skipped).toBe(true);
        expect(prismaMock.patientCriticalFlag.upsert).not.toHaveBeenCalled();
    });
});

// ── pharmacyAgent ─────────────────────────────────────────────────────────
describe('pharmacyAgent', () => {
    beforeEach(resetAll);

    it('flags medicines whose summed stock <= minStock and notifies pharmacists', async () => {
        prismaMock.prescription.findMany.mockResolvedValue([
            { id: 'rx-1', medicineId: 'med-a', medicationName: 'Adathodai' },
            { id: 'rx-2', medicineId: 'med-b', medicationName: 'Triphala' },
        ]);
        prismaMock.medicineStock.groupBy.mockResolvedValue([
            // Below threshold — must be flagged.
            { medicineId: 'med-a', _sum: { quantity: 5  }, _max: { minStock: 10 } },
            // Healthy stock — must NOT be flagged.
            { medicineId: 'med-b', _sum: { quantity: 50 }, _max: { minStock: 10 } },
        ]);
        const out = await pharmacyAgent(basePayload);
        expect(out.medicinesChecked).toBe(2);
        expect(out.lowStockFlagged).toBe(1);
        expect(out.flagged[0].medicationName).toBe('Adathodai');
        // Agent now delegates to the platform service so the alert audience
        // (pharmacists + admin-doctors) and canonical type 'LOW_STOCK_ALERT'
        // come from one source of truth.
        expect(sendLowStockAlert).toHaveBeenCalledWith('Adathodai', 5, 'br-1');
    });

    it('never throws when patient has no active prescriptions', async () => {
        prismaMock.prescription.findMany.mockResolvedValue([]);
        const out = await pharmacyAgent(basePayload);
        expect(out.medicinesChecked).toBe(0);
        expect(out.lowStockFlagged).toBe(0);
        expect(out.flagged).toEqual([]);
    });

    it('skips cleanly when branchId is missing (stock is branch-scoped)', async () => {
        const out = await pharmacyAgent({ ...basePayload, branchId: null });
        expect(out.skipped).toBe(true);
        expect(out.medicinesChecked).toBe(0);
    });
});

// ── slotHoldAgent ─────────────────────────────────────────────────────────
describe('slotHoldAgent', () => {
    beforeEach(resetAll);

    it('creates a PENDING_DOCTOR_APPROVAL appointment when a free slot exists', async () => {
        prismaMock.patientAssignment.findFirst.mockResolvedValue({
            doctor: { id: 'doc-1', fullName: 'Dr Y' },
        });
        prismaMock.appointment.findMany.mockResolvedValue([]); // no clashes
        prismaMock.appointment.create.mockImplementation(({ data }) =>
            Promise.resolve({ id: 'appt-new', date: data.date, doctorId: data.doctorId }),
        );

        const out = await slotHoldAgent(basePayload);
        expect(out.slotHeld).toBe(true);
        expect(out.appointmentId).toBe('appt-new');
        // Verify status / consultationType per spec.
        const created = prismaMock.appointment.create.mock.calls[0][0].data;
        expect(created.status).toBe('PENDING_DOCTOR_APPROVAL');
        expect(created.consultationType).toBe('DOCTOR');
        expect(created.notes).toMatch(/Auto-held from critical triage/);
        expect(created.triageSessionId).toBe('ts-1');
    });

    it('returns gracefully when assignment is missing — does not throw', async () => {
        prismaMock.patientAssignment.findFirst.mockResolvedValue(null);
        const out = await slotHoldAgent(basePayload);
        expect(out.slotHeld).toBe(false);
        expect(out.reason).toBe('no_assigned_doctor');
        expect(prismaMock.appointment.create).not.toHaveBeenCalled();
    });

    it('does not throw when create fails (e.g. unique constraint on triageSessionId)', async () => {
        prismaMock.patientAssignment.findFirst.mockResolvedValue({ doctor: { id: 'doc-1' } });
        prismaMock.appointment.findMany.mockResolvedValue([]);
        prismaMock.appointment.create.mockRejectedValue(new Error('Unique constraint failed'));
        const out = await slotHoldAgent(basePayload);
        expect(out.slotHeld).toBe(false);
        expect(out.reason).toBe('create_failed');
    });
});

// ── dashboardSummariser ───────────────────────────────────────────────────
describe('dashboardSummariser', () => {
    beforeEach(resetAll);

    it('composes autoActions correctly and notifies the assigned doctor', async () => {
        prismaMock.triageSession.findUnique.mockResolvedValue({
            redFlagsMatched: ['vitals_critical'], compositeScore: 2.3, urgencyLevel: 'CRITICAL',
        });
        prismaMock.patient.findUnique.mockResolvedValue({ id: 'pt-1', fullName: 'Ranjan' });
        prismaMock.patientCriticalFlag.findUnique.mockResolvedValue({
            id: 'flag-1', severity: 'HIGH',
            reasons: [{ type: 'CRITICAL_TRIAGE', triageSessionId: 'ts-1' }],
            status: 'ACTIVE',
        });
        prismaMock.appointment.findUnique.mockResolvedValue({
            id: 'appt-1', date: new Date(), status: 'PENDING_DOCTOR_APPROVAL', doctorId: 'doc-1',
        });
        prismaMock.patientAssignment.findFirst.mockResolvedValue({
            doctor: { id: 'doc-1', userId: 'u-doc', fullName: 'Dr X' },
        });
        prismaMock.prescription.count.mockResolvedValue(2);

        const out = await dashboardSummariser(basePayload);
        expect(out.notificationSent).toBe(true);
        expect(out.summary.autoActions.careGapRaised).toBe(true);
        expect(out.summary.autoActions.slotHeld).toBe(true);
        expect(out.summary.autoActions.medicinesChecked).toBe(2);
        expect(enqueueInAppNotification).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'u-doc', type: 'CRITICAL_TRIAGE_SUMMARY',
        }));
    });

    it('does not throw when no sibling writes exist yet (graceful partial summary)', async () => {
        prismaMock.triageSession.findUnique.mockResolvedValue(null);
        prismaMock.patient.findUnique.mockResolvedValue(null);
        prismaMock.patientCriticalFlag.findUnique.mockResolvedValue(null);
        prismaMock.appointment.findUnique.mockResolvedValue(null);
        prismaMock.patientAssignment.findFirst.mockResolvedValue(null);
        prismaMock.prescription.count.mockResolvedValue(0);

        const out = await dashboardSummariser(basePayload);
        // No assigned doctor → notification not sent, but no throw.
        expect(out.notificationSent).toBe(false);
        expect(out.summary.autoActions.careGapRaised).toBe(false);
        expect(out.summary.autoActions.slotHeld).toBe(false);
    });
});
