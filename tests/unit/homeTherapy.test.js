import { describe, it, expect, vi } from 'vitest';
import {
  validateHomeTherapyPayload,
  createRequestInTx,
  emitRequestCreated,
} from '../../services/homeTherapy.service.js';

describe('homeTherapy.service — validateHomeTherapyPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(() => validateHomeTherapyPayload({
      totalSessions: 5,
      sessionModes: ['HOME', 'HOME', 'HOME', 'HOSPITAL', 'HOSPITAL'],
      notes: 'Focus on lower back',
    })).not.toThrow();
  });

  it('rejects missing payload', () => {
    expect(() => validateHomeTherapyPayload(null)).toThrow(/payload must be an object/);
    expect(() => validateHomeTherapyPayload(undefined)).toThrow(/payload must be an object/);
  });

  it('rejects totalSessions < 1 or > 50', () => {
    expect(() => validateHomeTherapyPayload({ totalSessions: 0, sessionModes: [] })).toThrow(/between 1 and 50/);
    expect(() => validateHomeTherapyPayload({ totalSessions: 51, sessionModes: new Array(51).fill('HOME') })).toThrow(/between 1 and 50/);
    expect(() => validateHomeTherapyPayload({ totalSessions: 'five', sessionModes: [] })).toThrow(/integer/);
  });

  it('rejects when sessionModes length does not match totalSessions', () => {
    expect(() => validateHomeTherapyPayload({
      totalSessions: 3,
      sessionModes: ['HOME', 'HOME'],
    })).toThrow(/exactly 3 entries/);
  });

  it('rejects an invalid mode value', () => {
    expect(() => validateHomeTherapyPayload({
      totalSessions: 1,
      sessionModes: ['CLINIC'],
    })).toThrow(/invalid mode: CLINIC/);
  });

  it('rejects notes longer than 500 chars', () => {
    expect(() => validateHomeTherapyPayload({
      totalSessions: 1,
      sessionModes: ['HOME'],
      notes: 'x'.repeat(501),
    })).toThrow(/500 chars or less/);
  });

  it('accepts notes at the 500-char boundary', () => {
    expect(() => validateHomeTherapyPayload({
      totalSessions: 1,
      sessionModes: ['HOME'],
      notes: 'x'.repeat(500),
    })).not.toThrow();
  });

  it('accepts intervalDays in [1,30] and rejects out-of-range / non-integer values', () => {
    expect(() => validateHomeTherapyPayload({
      totalSessions: 5,
      sessionModes: ['HOME','HOME','HOME','HOME','HOME'],
      intervalDays: 7,
    })).not.toThrow();
    expect(() => validateHomeTherapyPayload({
      totalSessions: 1, sessionModes: ['HOME'], intervalDays: 0,
    })).toThrow(/between 1 and 30/);
    expect(() => validateHomeTherapyPayload({
      totalSessions: 1, sessionModes: ['HOME'], intervalDays: 31,
    })).toThrow(/between 1 and 30/);
    expect(() => validateHomeTherapyPayload({
      totalSessions: 1, sessionModes: ['HOME'], intervalDays: 1.5,
    })).toThrow(/between 1 and 30/);
  });

  it('treats intervalDays = null/undefined as "not specified" and accepts the payload', () => {
    expect(() => validateHomeTherapyPayload({
      totalSessions: 1, sessionModes: ['HOME'], intervalDays: null,
    })).not.toThrow();
    expect(() => validateHomeTherapyPayload({
      totalSessions: 1, sessionModes: ['HOME'],
    })).not.toThrow();
  });
});

describe('homeTherapy.service — createRequestInTx', () => {
  it('creates a row with PENDING_APPROVAL status and the given session modes', async () => {
    const tx = {
      homeTherapyRequest: {
        create: vi.fn(async ({ data }) => ({ id: 'req_1', ...data, createdAt: new Date() })),
      },
    };
    const out = await createRequestInTx(tx, {
      prescriptionId:    'rx_1',
      patientId:         'pat_1',
      requestingDoctorId:'doc_1',
      branchId:          'br_1',
      payload: {
        totalSessions: 5,
        sessionModes: ['HOME', 'HOME', 'HOME', 'HOSPITAL', 'HOSPITAL'],
        notes: '  trim me  ',
      },
    });
    expect(tx.homeTherapyRequest.create).toHaveBeenCalledOnce();
    const args = tx.homeTherapyRequest.create.mock.calls[0][0];
    expect(args.data.status).toBe('PENDING_APPROVAL');
    expect(args.data.totalSessions).toBe(5);
    expect(args.data.sessionMode).toEqual(['HOME', 'HOME', 'HOME', 'HOSPITAL', 'HOSPITAL']);
    expect(args.data.notes).toBe('trim me');
    expect(out.id).toBe('req_1');
  });

  it('persists null notes when payload notes are empty', async () => {
    const tx = {
      homeTherapyRequest: { create: vi.fn(async ({ data }) => ({ id: 'r', ...data })) },
    };
    await createRequestInTx(tx, {
      prescriptionId: 'rx', patientId: 'p', requestingDoctorId: 'd', branchId: 'b',
      payload: { totalSessions: 1, sessionModes: ['HOSPITAL'] },
    });
    const args = tx.homeTherapyRequest.create.mock.calls[0][0];
    expect(args.data.notes).toBeNull();
    expect(args.data.intervalDays).toBeNull();
    expect(args.data.sessionMode).toEqual(['HOSPITAL']);
  });

  it('persists intervalDays when supplied', async () => {
    const tx = {
      homeTherapyRequest: { create: vi.fn(async ({ data }) => ({ id: 'r', ...data })) },
    };
    await createRequestInTx(tx, {
      prescriptionId: 'rx', patientId: 'p', requestingDoctorId: 'd', branchId: 'b',
      payload: {
        totalSessions: 5,
        sessionModes: ['HOME','HOME','HOME','HOSPITAL','HOSPITAL'],
        intervalDays: 7,
      },
    });
    const args = tx.homeTherapyRequest.create.mock.calls[0][0];
    expect(args.data.intervalDays).toBe(7);
    expect(args.data.totalSessions).toBe(5);
  });
});

describe('homeTherapy.service — emitRequestCreated', () => {
  it('does not throw when the websocket layer is uninitialised', () => {
    // emitToRole logs a warning when io is not initialised but never throws.
    // Verify the helper swallows any failure so the prescription save isn't
    // affected by an outage in the realtime layer.
    expect(() => emitRequestCreated({
      id: 'r1', branchId: 'b1', patientId: 'p1', requestingDoctorId: 'd1',
      totalSessions: 1, sessionMode: ['HOME'], status: 'PENDING_APPROVAL',
      createdAt: new Date(),
    })).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// Approval flow — service-level shape assertion. Mocks Prisma so we can
// validate the exact rows produced without touching a real DB.
// ────────────────────────────────────────────────────────────────────
import HomeTherapyService from '../../services/homeTherapy.service.js';
import prisma from '../../lib/prisma.js';
import { cacheService } from '../../services/cache.service.js';

describe('homeTherapy.service — approveRequest', () => {
  it('creates one HomeTherapySession + one Appointment per requested session', async () => {
    const requestRow = {
      id: 'req_1',
      branchId: 'br_1',
      patientId: 'pat_1',
      requestingDoctorId: 'doc_1',
      totalSessions: 3,
      sessionMode: ['HOME', 'HOSPITAL', 'HOME'],
      status: 'PENDING_APPROVAL',
      sessions: [],
      patient: { id: 'pat_1', userId: 'usr_pat', branchId: 'br_1' },
      requestingDoctor: { userId: 'usr_doc' },
      notes: 'Focus on lower back',
    };
    const therapistRow = {
      id: 'ther_1',
      user: { id: 'usr_ther', branchId: 'br_1' },
    };
    const findRequest = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue(therapistRow);

    // $transaction — invoke callback with a tx mock that captures all writes.
    const apptCreate    = vi.fn(async ({ data }) => ({ id: `appt_${data.therapistId}_${data.date.toISOString()}`, ...data }));
    const sessCreate    = vi.fn(async ({ data }) => ({ id: `sess_${data.sessionNumber}`, ...data }));
    const blockedCreate = vi.fn(async ({ data }) => ({ id: 'bl_1', ...data }));
    const reqUpdate     = vi.fn(async ({ data }) => ({ ...requestRow, ...data }));
    const txMock = {
      homeTherapyRequest: { update: reqUpdate },
      appointment:        { create: apptCreate },
      homeTherapySession: { create: sessCreate },
      blockedSlot:        { create: blockedCreate },
    };
    const tx = vi.spyOn(prisma, '$transaction').mockImplementation(async (fn) => fn(txMock));

    const result = await HomeTherapyService.approveRequest('req_1',
      { id: 'admin_user', role: 'ADMIN' },
      {
        therapistId: 'ther_1',
        scheduledSessions: [
          { sessionNumber: 1, date: '2026-05-01', time: '09:00' },
          { sessionNumber: 2, date: '2026-05-03', time: '10:30' },
          { sessionNumber: 3, date: '2026-05-05', time: '14:15' },
        ],
      },
    );

    expect(reqUpdate).toHaveBeenCalledOnce();
    const reqArgs = reqUpdate.mock.calls[0][0];
    expect(reqArgs.data.status).toBe('APPROVED');
    expect(reqArgs.data.approvedById).toBe('admin_user');
    expect(reqArgs.data.approvedByRole).toBe('ADMIN');
    expect(reqArgs.data.approvedAt).toBeInstanceOf(Date);

    // 3 sessions → 3 Appointments + 3 HomeTherapySessions + 3 BlockedSlots.
    expect(apptCreate).toHaveBeenCalledTimes(3);
    expect(sessCreate).toHaveBeenCalledTimes(3);
    // BlockedSlot create is best-effort — tests still expect it to fire.
    expect(blockedCreate).toHaveBeenCalledTimes(3);

    // Mode for each session matches the original sessionMode array order.
    expect(sessCreate.mock.calls.map((c) => c[0].data.mode)).toEqual(['HOME', 'HOSPITAL', 'HOME']);
    expect(sessCreate.mock.calls.map((c) => c[0].data.status)).toEqual(['SCHEDULED','SCHEDULED','SCHEDULED']);
    expect(sessCreate.mock.calls.map((c) => c[0].data.sessionNumber)).toEqual([1, 2, 3]);

    // Each Appointment is THERAPIST/OFFLINE/CONFIRMED with the correct branch.
    for (const c of apptCreate.mock.calls) {
      const data = c[0].data;
      expect(data.consultationType).toBe('THERAPIST');
      expect(data.consultationMode).toBe('OFFLINE');
      expect(data.status).toBe('CONFIRMED');
      expect(data.branchId).toBe('br_1');
    }

    expect(result.sessions).toHaveLength(3);
    findRequest.mockRestore(); findTherapist.mockRestore(); tx.mockRestore();
  });

  it('rejects an approval when therapist belongs to a different branch', async () => {
    const requestRow = {
      id: 'req_2', branchId: 'br_1', patientId: 'pat_1', totalSessions: 1,
      sessionMode: ['HOME'], status: 'PENDING_APPROVAL', sessions: [],
      patient: { userId: 'usr_pat', branchId: 'br_1' }, requestingDoctor: { userId: 'usr_doc' },
    };
    const findRequest = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue({
      id: 'ther_x', user: { id: 'u', branchId: 'br_2' },
    });

    await expect(HomeTherapyService.approveRequest('req_2',
      { id: 'admin', role: 'ADMIN' },
      { therapistId: 'ther_x', scheduledSessions: [{ sessionNumber: 1, date: '2026-05-01', time: '09:00' }] },
    )).rejects.toThrow(/different branch/);

    findRequest.mockRestore(); findTherapist.mockRestore();
  });

  it('rejects approval when the request is not PENDING_APPROVAL', async () => {
    const requestRow = {
      id: 'req_3', branchId: 'br_1', patientId: 'pat_1', totalSessions: 1,
      sessionMode: ['HOME'], status: 'APPROVED', sessions: [],
      patient: { userId: 'u' }, requestingDoctor: { userId: 'd' },
    };
    const findRequest = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);
    await expect(HomeTherapyService.approveRequest('req_3',
      { id: 'admin', role: 'ADMIN' },
      { therapistId: 'ther_1', scheduledSessions: [{ sessionNumber: 1, date: '2026-05-01', time: '09:00' }] },
    )).rejects.toThrow(/Cannot approve/);
    findRequest.mockRestore();
  });

  it('rejects scheduledSessions whose length differs from totalSessions', async () => {
    const requestRow = {
      id: 'req_4', branchId: 'br_1', patientId: 'pat_1', totalSessions: 3,
      sessionMode: ['HOME','HOME','HOME'], status: 'PENDING_APPROVAL', sessions: [],
      patient: { userId: 'u' }, requestingDoctor: { userId: 'd' },
    };
    const findRequest = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue({
      id: 'ther_1', user: { id: 'u', branchId: 'br_1' },
    });
    await expect(HomeTherapyService.approveRequest('req_4',
      { id: 'admin', role: 'ADMIN' },
      { therapistId: 'ther_1', scheduledSessions: [{ sessionNumber: 1, date: '2026-05-01', time: '09:00' }] },
    )).rejects.toThrow(/exactly 3 entries/);
    findRequest.mockRestore(); findTherapist.mockRestore();
  });
});

describe('homeTherapy.service — editRequest', () => {
  // Build a richly-populated approved-request fixture once. Each test deep-clones
  // and tweaks the `sessions` array so cross-test mutation can't happen.
  function makeApprovedFixture(overrides = {}) {
    return {
      id: 'req_e1',
      branchId: 'br_1',
      patientId: 'pat_1',
      requestingDoctorId: 'doc_1',
      totalSessions: 3,
      sessionMode: ['HOME', 'HOME', 'HOSPITAL'],
      status: 'APPROVED',
      intervalDays: 2,
      notes: 'Knee rehab',
      patient: { id: 'pat_1', userId: 'usr_pat', branchId: 'br_1' },
      requestingDoctor: { userId: 'usr_doc' },
      sessions: [
        {
          id: 's_1', sessionNumber: 1, status: 'SCHEDULED',
          therapistId: 'ther_old', appointmentId: 'appt_1',
          scheduledDate: new Date('2026-05-01T09:00:00.000Z'),
          scheduledTime: '09:00', mode: 'HOME',
        },
        {
          id: 's_2', sessionNumber: 2, status: 'SCHEDULED',
          therapistId: 'ther_old', appointmentId: 'appt_2',
          scheduledDate: new Date('2026-05-03T10:00:00.000Z'),
          scheduledTime: '10:00', mode: 'HOME',
        },
        {
          id: 's_3', sessionNumber: 3, status: 'SCHEDULED',
          therapistId: 'ther_old', appointmentId: 'appt_3',
          scheduledDate: new Date('2026-05-05T11:00:00.000Z'),
          scheduledTime: '11:00', mode: 'HOSPITAL',
        },
      ],
      ...overrides,
    };
  }

  function buildTxMock() {
    const sessUpdate    = vi.fn(async ({ data, where }) => ({ id: where.id, ...data }));
    const sessCreate    = vi.fn(async ({ data }) => ({ id: `new_sess_${data.sessionNumber}`, ...data }));
    const sessDelete    = vi.fn(async ({ where }) => ({ id: where.id }));
    const apptCreate    = vi.fn(async ({ data }) => ({ id: `new_appt_${data.therapistId}_${data.date.toISOString()}`, ...data }));
    const apptUpdate    = vi.fn(async ({ data, where }) => ({ id: where.id, ...data }));
    const blockedDelete = vi.fn(async () => ({ count: 1 }));
    const blockedCreate = vi.fn(async ({ data }) => ({ id: 'bl_x', ...data }));
    const reqUpdate     = vi.fn(async ({ data, where }) => ({ id: where.id, ...data }));
    const sessUpdateMany = vi.fn(async () => ({ count: 0 }));
    const txMock = {
      homeTherapyRequest: { update: reqUpdate },
      homeTherapySession: { create: sessCreate, update: sessUpdate, delete: sessDelete },
      appointment:        { create: apptCreate, update: apptUpdate },
      blockedSlot:        { deleteMany: blockedDelete, create: blockedCreate },
    };
    return { txMock, sessUpdate, sessCreate, sessDelete, apptCreate, apptUpdate, blockedDelete, blockedCreate, reqUpdate };
  }

  it('reassigns the therapist and reschedules every SCHEDULED session', async () => {
    const requestRow = makeApprovedFixture();
    const therapistRow = { id: 'ther_new', user: { id: 'usr_ther', branchId: 'br_1' } };

    const findRequest   = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue(therapistRow);
    const { txMock, sessUpdate, apptUpdate, sessCreate, sessDelete, reqUpdate } = buildTxMock();
    const tx = vi.spyOn(prisma, '$transaction').mockImplementation(async (fn) => fn(txMock));

    await HomeTherapyService.editRequest('req_e1',
      { id: 'admin', role: 'ADMIN' },
      {
        therapistId: 'ther_new',
        scheduledSessions: [
          { sessionNumber: 1, date: '2026-05-02', time: '08:30', mode: 'HOME' },
          { sessionNumber: 2, date: '2026-05-04', time: '10:30', mode: 'HOME' },
          { sessionNumber: 3, date: '2026-05-06', time: '11:30', mode: 'HOSPITAL' },
        ],
      },
    );

    // Three existing SCHEDULED sessions all get an update — therapist + dt.
    expect(sessUpdate).toHaveBeenCalledTimes(3);
    expect(apptUpdate).toHaveBeenCalledTimes(3);
    // No drops, no creates.
    expect(sessCreate).not.toHaveBeenCalled();
    expect(sessDelete).not.toHaveBeenCalled();

    // Each session-update sets the new therapistId.
    for (const c of sessUpdate.mock.calls) {
      expect(c[0].data.therapistId).toBe('ther_new');
    }
    // Request itself gets totalSessions=3, sessionMode preserved order.
    const reqArgs = reqUpdate.mock.calls[0][0];
    expect(reqArgs.data.totalSessions).toBe(3);
    expect(reqArgs.data.sessionMode).toEqual(['HOME', 'HOME', 'HOSPITAL']);

    findRequest.mockRestore(); findTherapist.mockRestore(); tx.mockRestore();
  });

  it('adds new sessions when the payload count grows', async () => {
    const requestRow = makeApprovedFixture();
    const therapistRow = { id: 'ther_old', user: { id: 'usr_ther', branchId: 'br_1' } };

    const findRequest   = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue(therapistRow);
    const { txMock, sessCreate, apptCreate, sessDelete, reqUpdate } = buildTxMock();
    const tx = vi.spyOn(prisma, '$transaction').mockImplementation(async (fn) => fn(txMock));

    await HomeTherapyService.editRequest('req_e1',
      { id: 'admin', role: 'ADMIN' },
      {
        scheduledSessions: [
          { sessionNumber: 1, date: '2026-05-01', time: '09:00', mode: 'HOME' },
          { sessionNumber: 2, date: '2026-05-03', time: '10:00', mode: 'HOME' },
          { sessionNumber: 3, date: '2026-05-05', time: '11:00', mode: 'HOSPITAL' },
          { sessionNumber: 4, date: '2026-05-07', time: '14:00', mode: 'HOME' },
          { sessionNumber: 5, date: '2026-05-09', time: '15:00', mode: 'HOME' },
        ],
      },
    );

    // Two new sessionNumbers (4 and 5) → two creates.
    expect(sessCreate).toHaveBeenCalledTimes(2);
    expect(apptCreate).toHaveBeenCalledTimes(2);
    expect(sessDelete).not.toHaveBeenCalled();

    const newNumbers = sessCreate.mock.calls.map((c) => c[0].data.sessionNumber).sort();
    expect(newNumbers).toEqual([4, 5]);

    expect(reqUpdate.mock.calls[0][0].data.totalSessions).toBe(5);
    expect(reqUpdate.mock.calls[0][0].data.sessionMode).toEqual(['HOME','HOME','HOSPITAL','HOME','HOME']);

    findRequest.mockRestore(); findTherapist.mockRestore(); tx.mockRestore();
  });

  it('drops trailing sessions when the payload count shrinks', async () => {
    const requestRow = makeApprovedFixture();
    const therapistRow = { id: 'ther_old', user: { id: 'usr_ther', branchId: 'br_1' } };

    const findRequest   = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue(therapistRow);
    const { txMock, sessDelete, sessCreate, apptUpdate, reqUpdate } = buildTxMock();
    const tx = vi.spyOn(prisma, '$transaction').mockImplementation(async (fn) => fn(txMock));

    await HomeTherapyService.editRequest('req_e1',
      { id: 'admin', role: 'ADMIN' },
      {
        scheduledSessions: [
          { sessionNumber: 1, date: '2026-05-01', time: '09:00', mode: 'HOME' },
          { sessionNumber: 2, date: '2026-05-03', time: '10:00', mode: 'HOME' },
        ],
      },
    );

    // Session 3 dropped. Sessions 1+2 unchanged → no Session.update needed.
    expect(sessDelete).toHaveBeenCalledTimes(1);
    expect(sessDelete.mock.calls[0][0].where.id).toBe('s_3');
    expect(sessCreate).not.toHaveBeenCalled();
    // The drop branch detaches the FK and CANCELs the appointment, so
    // exactly one appointment.update fires for the dropped session.
    expect(apptUpdate).toHaveBeenCalledTimes(1);
    expect(apptUpdate.mock.calls[0][0].where.id).toBe('appt_3');
    expect(apptUpdate.mock.calls[0][0].data.status).toBe('CANCELLED');

    expect(reqUpdate.mock.calls[0][0].data.totalSessions).toBe(2);
    expect(reqUpdate.mock.calls[0][0].data.sessionMode).toEqual(['HOME','HOME']);

    findRequest.mockRestore(); findTherapist.mockRestore(); tx.mockRestore();
  });

  it('refuses to drop a session that is already COMPLETED', async () => {
    // Make the LAST session COMPLETED so we can build a contiguous 1..N
    // payload that omits it — that's the only way to trigger the drop guard
    // for a COMPLETED row given the contiguous-numbering rule.
    const requestRow = makeApprovedFixture();
    requestRow.sessions[2].status = 'COMPLETED';
    const therapistRow = { id: 'ther_old', user: { id: 'usr_ther', branchId: 'br_1' } };

    const findRequest   = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue(therapistRow);

    await expect(HomeTherapyService.editRequest('req_e1',
      { id: 'admin', role: 'ADMIN' },
      {
        // Payload omits session 3 — not allowed because it's COMPLETED.
        scheduledSessions: [
          { sessionNumber: 1, date: '2026-05-01', time: '09:00', mode: 'HOME' },
          { sessionNumber: 2, date: '2026-05-03', time: '10:00', mode: 'HOME' },
        ],
      },
    )).rejects.toThrow(/Cannot drop session 3/);

    findRequest.mockRestore(); findTherapist.mockRestore();
  });

  it('refuses to modify the date/time of an IN_PROGRESS session', async () => {
    const requestRow = makeApprovedFixture();
    requestRow.sessions[0].status = 'IN_PROGRESS';
    const therapistRow = { id: 'ther_old', user: { id: 'usr_ther', branchId: 'br_1' } };

    const findRequest   = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue(therapistRow);

    await expect(HomeTherapyService.editRequest('req_e1',
      { id: 'admin', role: 'ADMIN' },
      {
        scheduledSessions: [
          // Session 1 IN_PROGRESS — date moved → must reject.
          { sessionNumber: 1, date: '2026-05-02', time: '09:00', mode: 'HOME' },
          { sessionNumber: 2, date: '2026-05-03', time: '10:00', mode: 'HOME' },
          { sessionNumber: 3, date: '2026-05-05', time: '11:00', mode: 'HOSPITAL' },
        ],
      },
    )).rejects.toThrow(/Cannot modify session 1/);

    findRequest.mockRestore(); findTherapist.mockRestore();
  });

  it('refuses an edit when the request is in a terminal state', async () => {
    const requestRow = makeApprovedFixture({ status: 'COMPLETED' });
    const findRequest = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);

    await expect(HomeTherapyService.editRequest('req_e1',
      { id: 'admin', role: 'ADMIN' },
      {
        scheduledSessions: [
          { sessionNumber: 1, date: '2026-05-01', time: '09:00', mode: 'HOME' },
          { sessionNumber: 2, date: '2026-05-03', time: '10:00', mode: 'HOME' },
          { sessionNumber: 3, date: '2026-05-05', time: '11:00', mode: 'HOSPITAL' },
        ],
      },
    )).rejects.toThrow(/Cannot edit a request in status COMPLETED/);

    findRequest.mockRestore();
  });

  it('rejects therapist reassignment when the new therapist is in another branch', async () => {
    const requestRow = makeApprovedFixture();
    const findRequest = vi.spyOn(prisma.homeTherapyRequest, 'findUnique').mockResolvedValue(requestRow);
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue({
      id: 'ther_other', user: { id: 'u', branchId: 'br_2' },
    });

    await expect(HomeTherapyService.editRequest('req_e1',
      { id: 'admin', role: 'ADMIN' },
      {
        therapistId: 'ther_other',
        scheduledSessions: [
          { sessionNumber: 1, date: '2026-05-01', time: '09:00', mode: 'HOME' },
          { sessionNumber: 2, date: '2026-05-03', time: '10:00', mode: 'HOME' },
          { sessionNumber: 3, date: '2026-05-05', time: '11:00', mode: 'HOSPITAL' },
        ],
      },
    )).rejects.toThrow(/different branch/);

    findRequest.mockRestore(); findTherapist.mockRestore();
  });
});

describe('homeTherapy.service — recordLocationPing rate limit', () => {
  it('returns 429 when Redis already holds the rate-limit slot', async () => {
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue({ id: 'ther_1' });
    const findSession = vi.spyOn(prisma.homeTherapySession, 'findUnique').mockResolvedValue({
      id: 'sess_1', therapistId: 'ther_1', patientId: 'pat_1', patient: { userId: 'usr_p' },
    });
    const setIfAbsent = vi.spyOn(cacheService, 'setIfAbsent').mockResolvedValue(false);

    let caught;
    try {
      await HomeTherapyService.recordLocationPing('sess_1',
        { id: 'usr_t', role: 'THERAPIST' },
        { latitude: 13.0, longitude: 80.2 },
      );
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(429);

    setIfAbsent.mockRestore(); findTherapist.mockRestore(); findSession.mockRestore();
  });

  it('inserts a ping when the slot is acquired', async () => {
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue({ id: 'ther_1' });
    const findSession = vi.spyOn(prisma.homeTherapySession, 'findUnique').mockResolvedValue({
      id: 'sess_1', therapistId: 'ther_1', patientId: 'pat_1', patient: { userId: 'usr_p' },
    });
    const setIfAbsent = vi.spyOn(cacheService, 'setIfAbsent').mockResolvedValue(true);
    const create = vi.spyOn(prisma.therapistLocationPing, 'create').mockResolvedValue({
      id: 'ping_1', sessionId: 'sess_1', therapistId: 'ther_1',
      latitude: 13.0, longitude: 80.2, accuracy: 7.5, timestamp: new Date(),
    });

    const ping = await HomeTherapyService.recordLocationPing('sess_1',
      { id: 'usr_t', role: 'THERAPIST' },
      { latitude: 13.0, longitude: 80.2, accuracy: 7.5 },
    );
    expect(ping.id).toBe('ping_1');
    expect(create).toHaveBeenCalledOnce();

    setIfAbsent.mockRestore(); findTherapist.mockRestore(); findSession.mockRestore(); create.mockRestore();
  });

  it('fails-open when Redis returns null (circuit open / unavailable)', async () => {
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue({ id: 'ther_1' });
    const findSession = vi.spyOn(prisma.homeTherapySession, 'findUnique').mockResolvedValue({
      id: 'sess_1', therapistId: 'ther_1', patientId: 'pat_1', patient: { userId: 'usr_p' },
    });
    const setIfAbsent = vi.spyOn(cacheService, 'setIfAbsent').mockResolvedValue(null);
    const create = vi.spyOn(prisma.therapistLocationPing, 'create').mockResolvedValue({
      id: 'ping_2', sessionId: 'sess_1', therapistId: 'ther_1',
      latitude: 13.0, longitude: 80.2, accuracy: null, timestamp: new Date(),
    });
    const ping = await HomeTherapyService.recordLocationPing('sess_1',
      { id: 'usr_t', role: 'THERAPIST' },
      { latitude: 13.0, longitude: 80.2 },
    );
    expect(ping.id).toBe('ping_2');
    setIfAbsent.mockRestore(); findTherapist.mockRestore(); findSession.mockRestore(); create.mockRestore();
  });
});

describe('homeTherapy.service — submitFeedback', () => {
  it('rejects feedback before the session is COMPLETED', async () => {
    const findSession = vi.spyOn(prisma.homeTherapySession, 'findUnique').mockResolvedValue({
      id: 'sess', status: 'IN_SESSION',
      therapist: { id: 't', userId: 'u_t' },
      patient: { id: 'p', userId: 'u_p' },
      therapistFeedbackId: null, patientFeedbackId: null,
    });
    let caught;
    try {
      await HomeTherapyService.submitFeedback({
        sessionId: 'sess', user: { id: 'u_p', role: 'PATIENT' },
        authorRole: 'PATIENT', rating: 5, tags: ['THERAPIST_ON_TIME'],
      });
    } catch (e) { caught = e; }
    expect(caught?.status).toBe(409);
    findSession.mockRestore();
  });

  it('rejects therapist feedback when caller is not the assigned therapist', async () => {
    const findSession = vi.spyOn(prisma.homeTherapySession, 'findUnique').mockResolvedValue({
      id: 'sess', status: 'COMPLETED',
      therapist: { id: 't1', userId: 'u_t1' },
      patient: { id: 'p', userId: 'u_p' },
      therapistFeedbackId: null, patientFeedbackId: null,
    });
    let caught;
    try {
      await HomeTherapyService.submitFeedback({
        sessionId: 'sess', user: { id: 'u_t2', role: 'THERAPIST' },
        authorRole: 'THERAPIST', rating: 5,
      });
    } catch (e) { caught = e; }
    expect(caught?.status).toBe(403);
    findSession.mockRestore();
  });

  it('rejects duplicate submission for the same authorRole', async () => {
    const findSession = vi.spyOn(prisma.homeTherapySession, 'findUnique').mockResolvedValue({
      id: 'sess', status: 'COMPLETED',
      therapist: { id: 't', userId: 'u_t' },
      patient: { id: 'p', userId: 'u_p' },
      therapistFeedbackId: 'existing', patientFeedbackId: null,
    });
    let caught;
    try {
      await HomeTherapyService.submitFeedback({
        sessionId: 'sess', user: { id: 'u_t', role: 'THERAPIST' },
        authorRole: 'THERAPIST', rating: 5,
      });
    } catch (e) { caught = e; }
    expect(caught?.status).toBe(409);
    expect(String(caught?.message)).toMatch(/already submitted/i);
    findSession.mockRestore();
  });

  it('creates a feedback row + links it back onto the session and awards XP for POSITIVE patient feedback', async () => {
    const findSession = vi.spyOn(prisma.homeTherapySession, 'findUnique').mockResolvedValue({
      id: 'sess', status: 'COMPLETED',
      therapist: { id: 't', userId: 'u_t' },
      patient: { id: 'p', userId: 'u_p' },
      therapistFeedbackId: null, patientFeedbackId: null,
    });
    const fbCreate = vi.fn(async ({ data }) => ({ id: 'fb_1', ...data }));
    const sessUpdate = vi.fn(async () => ({}));
    const fbFind = vi.fn(async () => ({ id: 'fb_1', xpAwarded: false }));
    const xpCreate = vi.fn(async ({ data }) => ({ id: 'xp_1', ...data }));
    const fbUpdate = vi.fn(async () => ({}));
    const tx = vi.spyOn(prisma, '$transaction').mockImplementation(async (fn) => fn({
      homeTherapyFeedback: { create: fbCreate, findUnique: fbFind, update: fbUpdate },
      homeTherapySession:  { update: sessUpdate },
      xPLedger:            { create: xpCreate },
    }));

    const out = await HomeTherapyService.submitFeedback({
      sessionId: 'sess', user: { id: 'u_p', role: 'PATIENT' },
      authorRole: 'PATIENT', rating: 5, tags: ['THERAPIST_ON_TIME', 'PROFESSIONAL'], notes: ' Excellent session ',
    });

    expect(out.id).toBe('fb_1');
    // Feedback row created with the right shape.
    expect(fbCreate).toHaveBeenCalledOnce();
    const fbArgs = fbCreate.mock.calls[0][0];
    expect(fbArgs.data.authorRole).toBe('PATIENT');
    expect(fbArgs.data.sentiment).toBe('POSITIVE');
    expect(fbArgs.data.rating).toBe(5);
    expect(fbArgs.data.tags).toEqual(['THERAPIST_ON_TIME', 'PROFESSIONAL']);
    expect(fbArgs.data.notes).toBe('Excellent session');
    // Linked back onto the session via patientFeedbackId.
    expect(sessUpdate).toHaveBeenCalledOnce();
    expect(sessUpdate.mock.calls[0][0].data.patientFeedbackId).toBe('fb_1');
    // XP awarded once: 75 XP, action POSITIVE_HOME_THERAPY_FEEDBACK.
    expect(xpCreate).toHaveBeenCalledOnce();
    const xp = xpCreate.mock.calls[0][0].data;
    expect(xp.xpAmount).toBe(75);
    expect(xp.action).toBe('POSITIVE_HOME_THERAPY_FEEDBACK');
    expect(xp.userId).toBe('u_t');
    // xpAwarded flag stamped to true on the feedback row.
    expect(fbUpdate).toHaveBeenCalledOnce();
    expect(fbUpdate.mock.calls[0][0].data.xpAwarded).toBe(true);

    tx.mockRestore(); findSession.mockRestore();
  });

  it('does not award XP for NEUTRAL or NEGATIVE patient feedback', async () => {
    const findSession = vi.spyOn(prisma.homeTherapySession, 'findUnique').mockResolvedValue({
      id: 'sess', status: 'COMPLETED',
      therapist: { id: 't', userId: 'u_t' },
      patient: { id: 'p', userId: 'u_p' },
      therapistFeedbackId: null, patientFeedbackId: null,
    });
    const fbCreate = vi.fn(async ({ data }) => ({ id: 'fb_neutral', ...data }));
    const sessUpdate = vi.fn(async () => ({}));
    const xpCreate = vi.fn(async () => ({}));
    const tx = vi.spyOn(prisma, '$transaction').mockImplementation(async (fn) => fn({
      homeTherapyFeedback: { create: fbCreate, findUnique: vi.fn(), update: vi.fn() },
      homeTherapySession:  { update: sessUpdate },
      xPLedger:            { create: xpCreate },
    }));
    await HomeTherapyService.submitFeedback({
      sessionId: 'sess', user: { id: 'u_p', role: 'PATIENT' },
      authorRole: 'PATIENT', rating: 3, tags: [], notes: null,
    });
    expect(xpCreate).not.toHaveBeenCalled();
    tx.mockRestore(); findSession.mockRestore();
  });
});

describe('homeTherapy.service — transitionSession state machine', () => {
  it('cannot complete a session that is still SCHEDULED', async () => {
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue({ id: 'ther_1' });
    const findSession = vi.spyOn(prisma.homeTherapySession, 'findUnique').mockResolvedValue({
      id: 'sess_1', therapistId: 'ther_1', status: 'SCHEDULED',
      therapist: { id: 'ther_1', userId: 'u_t' }, patient: { userId: 'u_p' },
    });
    let caught;
    try {
      await HomeTherapyService.transitionSession('complete', 'sess_1', { id: 'u_t', role: 'THERAPIST' });
    } catch (e) { caught = e; }
    expect(caught?.status).toBe(409);
    expect(String(caught?.message)).toMatch(/Cannot transition from SCHEDULED to COMPLETED/);
    findTherapist.mockRestore(); findSession.mockRestore();
  });

  it('rejects a state transition for a session not assigned to the caller', async () => {
    const findTherapist = vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue({ id: 'ther_other' });
    const findSession = vi.spyOn(prisma.homeTherapySession, 'findUnique').mockResolvedValue({
      id: 'sess_1', therapistId: 'ther_1', status: 'SCHEDULED',
      therapist: { id: 'ther_1', userId: 'u_other' }, patient: { userId: 'u_p' },
    });
    let caught;
    try {
      await HomeTherapyService.transitionSession('depart', 'sess_1', { id: 'u_t', role: 'THERAPIST' });
    } catch (e) { caught = e; }
    expect(caught?.status).toBe(403);
    findTherapist.mockRestore(); findSession.mockRestore();
  });
});
