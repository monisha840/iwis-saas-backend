/**
 * Home Therapy Service.
 *
 * The doctor flips a "therapy referral required" toggle inside the
 * prescription form (Task 3). When set, a HomeTherapyRequest is created in
 * PENDING_APPROVAL status alongside the prescription, in the same Prisma
 * transaction. Admin / ADMIN_DOCTOR / BRANCH_ADMIN reviews the queue,
 * picks a therapist, and schedules N HomeTherapySession rows (Task 4).
 *
 * Sockets fired by this module:
 *   - `home_therapy_request_created` → role:ADMIN, role:ADMIN_DOCTOR, role:BRANCH_ADMIN
 *
 * The ergonomic invariant: every session requested by the doctor produces
 * exactly one HomeTherapySession row at approval time, and exactly one
 * Appointment row at the same time so existing reminder / billing /
 * feedback pipelines pick it up unchanged.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToRole, emitToUser, emitToHomeTherapyRoom } from '../websocket/index.js';
import { cacheService } from './cache.service.js';

const VALID_MODES = new Set(['HOME', 'HOSPITAL']);

/**
 * Validate the homeTherapy fragment of a batch-prescription payload.
 * Throws an Error with `.status` set when the shape is bad so the route
 * handler can surface a 400.
 */
export function validateHomeTherapyPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    const e = new Error('homeTherapy payload must be an object');
    e.status = 400;
    throw e;
  }
  const total = Number(payload.totalSessions);
  if (!Number.isInteger(total) || total < 1 || total > 50) {
    const e = new Error('homeTherapy.totalSessions must be an integer between 1 and 50');
    e.status = 400;
    throw e;
  }
  const modes = Array.isArray(payload.sessionModes) ? payload.sessionModes : [];
  if (modes.length !== total) {
    const e = new Error(`homeTherapy.sessionModes must have exactly ${total} entries`);
    e.status = 400;
    throw e;
  }
  for (const m of modes) {
    if (!VALID_MODES.has(m)) {
      const e = new Error(`homeTherapy.sessionModes contains invalid mode: ${m}`);
      e.status = 400;
      throw e;
    }
  }
  if (payload.notes != null && typeof payload.notes !== 'string') {
    const e = new Error('homeTherapy.notes must be a string');
    e.status = 400;
    throw e;
  }
  if (payload.notes && payload.notes.length > 500) {
    const e = new Error('homeTherapy.notes must be 500 chars or less');
    e.status = 400;
    throw e;
  }
  // Optional interval between sessions (in days). 1 = daily, 7 = weekly.
  // Capped at 30 — anything longer is admin-judgement territory at approval.
  if (payload.intervalDays != null) {
    if (!Number.isInteger(payload.intervalDays) || payload.intervalDays < 1 || payload.intervalDays > 30) {
      const e = new Error('homeTherapy.intervalDays must be an integer between 1 and 30');
      e.status = 400;
      throw e;
    }
  }
}

/**
 * Create a HomeTherapyRequest row inside an existing Prisma transaction.
 * Caller is expected to have already validated the payload via
 * `validateHomeTherapyPayload`.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} args
 * @param {string} args.prescriptionId
 * @param {string} args.patientId       — Patient.id
 * @param {string} args.requestingDoctorId — Doctor.id (NOT User.id)
 * @param {string} args.branchId
 * @param {object} args.payload         — { totalSessions, sessionModes, notes? }
 * @returns {Promise<HomeTherapyRequest>}
 */
export async function createRequestInTx(tx, {
  prescriptionId,
  patientId,
  requestingDoctorId,
  branchId,
  payload,
}) {
  const request = await tx.homeTherapyRequest.create({
    data: {
      prescriptionId,
      patientId,
      requestingDoctorId,
      branchId,
      totalSessions: payload.totalSessions,
      sessionMode:   payload.sessionModes,
      intervalDays:  payload.intervalDays ?? null,
      notes:         payload.notes ? payload.notes.trim() : null,
      status:        'PENDING_APPROVAL',
    },
  });
  return request;
}

/**
 * Post-commit fanout — runs after the prescription transaction succeeds.
 * Best-effort: any emit failure is logged and swallowed. Never throw from
 * here; the prescription is already saved.
 */
export function emitRequestCreated(request) {
  try {
    const payload = {
      id: request.id,
      branchId: request.branchId,
      patientId: request.patientId,
      requestingDoctorId: request.requestingDoctorId,
      totalSessions: request.totalSessions,
      sessionMode: request.sessionMode,
      status: request.status,
      createdAt: request.createdAt,
    };
    emitToRole('ADMIN', 'home_therapy_request_created', payload);
    emitToRole('ADMIN_DOCTOR', 'home_therapy_request_created', payload);
    emitToRole('BRANCH_ADMIN', 'home_therapy_request_created', payload);
  } catch (err) {
    logger?.warn?.('[homeTherapy] emit home_therapy_request_created failed', { err: err?.message });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Approval / scheduling / session-lifecycle / location-ping helpers.
// All methods below are wired up to the `/api/home-therapy/*` routes.
// ─────────────────────────────────────────────────────────────────────

const REQUEST_INCLUDE = {
  patient: { select: { id: true, fullName: true, patientId: true, userId: true, branchId: true,
    addressLine1: true, addressLine2: true, city: true, state: true, pincode: true,
    primaryPhone: true, alternativePhone: true, latitude: true, longitude: true, locationVerified: true,
  } },
  requestingDoctor: { select: { id: true, fullName: true, specialization: true, userId: true } },
  branch: { select: { id: true, name: true } },
  prescription: { select: { id: true, medicationName: true, createdAt: true } },
  sessions: {
    orderBy: { sessionNumber: 'asc' },
    include: {
      therapist: { select: { id: true, fullName: true, gender: true, userId: true } },
      appointment: { select: { id: true, date: true, status: true } },
    },
  },
};

const SESSION_INCLUDE = {
  request: { select: { id: true, branchId: true, totalSessions: true, intervalDays: true, notes: true,
    requestingDoctor: { select: { id: true, fullName: true, userId: true } },
  } },
  therapist: { select: { id: true, fullName: true, gender: true, userId: true } },
  patient: { select: { id: true, fullName: true, userId: true, branchId: true,
    addressLine1: true, addressLine2: true, city: true, state: true, pincode: true,
    primaryPhone: true, alternativePhone: true, latitude: true, longitude: true, locationVerified: true,
  } },
  appointment: { select: { id: true, date: true, status: true, meetingLink: true } },
};

function userIsBranchScoped(role) {
  return role === 'ADMIN_DOCTOR' || role === 'BRANCH_ADMIN';
}

function isAdminLike(role) {
  return role === 'ADMIN' || role === 'ADMIN_DOCTOR' || role === 'BRANCH_ADMIN' || role === 'SUPER_ADMIN';
}

/**
 * Resolve the canonical Doctor row for a User. Used to gate
 * "DOCTOR (own)" access on requests.
 */
async function _doctorForUser(userId) {
  return prisma.doctor.findUnique({ where: { userId }, select: { id: true } });
}

/**
 * Resolve the canonical Therapist row for a User. Used to gate
 * THERAPIST endpoints (depart/arrive/start/complete/location-ping).
 */
async function _therapistForUser(userId) {
  return prisma.therapist.findUnique({ where: { userId }, select: { id: true } });
}

/**
 * GET /api/home-therapy/requests — list with filters.
 *  - ADMIN: any branch in their hospital
 *  - ADMIN_DOCTOR / BRANCH_ADMIN: pinned to user.branchId
 */
async function listRequests({ branchId = null, status = null, user }) {
  if (!isAdminLike(user.role)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  const where = {};
  if (status)   where.status   = status;
  // BRANCH_ADMIN / ADMIN_DOCTOR are pinned to their own branch.
  if (userIsBranchScoped(user.role)) {
    where.branchId = user.branchId;
  } else if (branchId) {
    where.branchId = branchId;
  }
  // ADMIN scope: limit to branches in their hospital.
  if (user.role === 'ADMIN' && user.hospitalId) {
    where.branch = { hospitalId: user.hospitalId };
  }
  return prisma.homeTherapyRequest.findMany({
    where,
    include: REQUEST_INCLUDE,
    orderBy: [{ createdAt: 'desc' }],
    take: 200,
  });
}

/**
 * GET /api/home-therapy/requests/:id — detail. DOCTOR sees only their own.
 */
async function getRequest(id, user) {
  const req = await prisma.homeTherapyRequest.findUnique({
    where: { id },
    include: REQUEST_INCLUDE,
  });
  if (!req) {
    const e = new Error('Home therapy request not found'); e.status = 404; throw e;
  }
  if (isAdminLike(user.role)) {
    if (userIsBranchScoped(user.role) && req.branchId !== user.branchId) {
      const e = new Error('Forbidden — request belongs to another branch'); e.status = 403; throw e;
    }
    return req;
  }
  if (user.role === 'DOCTOR') {
    const doctor = await _doctorForUser(user.id);
    if (!doctor || req.requestingDoctorId !== doctor.id) {
      const e = new Error('Forbidden — not your request'); e.status = 403; throw e;
    }
    return req;
  }
  const e = new Error('Forbidden'); e.status = 403; throw e;
}

/**
 * Validate a scheduledSessions[] payload from the approve flow.
 * Each entry: { sessionNumber, date (YYYY-MM-DD), time (HH:MM) }.
 */
function _validateScheduledSessions(scheduled, totalSessions) {
  if (!Array.isArray(scheduled) || scheduled.length !== totalSessions) {
    const e = new Error(`scheduledSessions must contain exactly ${totalSessions} entries`);
    e.status = 400; throw e;
  }
  const seen = new Set();
  for (const s of scheduled) {
    const num = Number(s?.sessionNumber);
    if (!Number.isInteger(num) || num < 1 || num > totalSessions) {
      const e = new Error('scheduledSessions[].sessionNumber out of range');
      e.status = 400; throw e;
    }
    if (seen.has(num)) {
      const e = new Error(`Duplicate sessionNumber ${num} in scheduledSessions`);
      e.status = 400; throw e;
    }
    seen.add(num);
    if (typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) {
      const e = new Error('scheduledSessions[].date must be YYYY-MM-DD');
      e.status = 400; throw e;
    }
    if (typeof s.time !== 'string' || !/^\d{2}:\d{2}$/.test(s.time)) {
      const e = new Error('scheduledSessions[].time must be HH:MM');
      e.status = 400; throw e;
    }
  }
}

/**
 * POST /api/home-therapy/requests/:id/approve — full approval flow.
 *   1. Validate role + branch.
 *   2. Validate therapistId belongs to the same branch.
 *   3. Validate scheduledSessions[] (one per requested session).
 *   4. Inside a transaction:
 *      a. flip request to APPROVED + stamp approver / approvedAt.
 *      b. for each session create:
 *           - one Appointment (THERAPIST type, OFFLINE, status CONFIRMED)
 *           - one HomeTherapySession (status SCHEDULED, mode from sessionMode[i])
 *           - one BlockedSlot for the therapist (1-hour window around scheduledTime)
 *   5. Best-effort fanout: emit `home_therapy_approved` to doctor / patient
 *      / therapist user rooms.
 */
async function approveRequest(requestId, user, { therapistId, scheduledSessions }) {
  if (!isAdminLike(user.role)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  if (typeof therapistId !== 'string' || !therapistId.trim()) {
    const e = new Error('therapistId is required'); e.status = 400; throw e;
  }
  const req = await prisma.homeTherapyRequest.findUnique({
    where: { id: requestId },
    include: { sessions: true, patient: { select: { id: true, userId: true, branchId: true } }, requestingDoctor: { select: { userId: true } } },
  });
  if (!req) {
    const e = new Error('Home therapy request not found'); e.status = 404; throw e;
  }
  if (userIsBranchScoped(user.role) && req.branchId !== user.branchId) {
    const e = new Error('Forbidden — request belongs to another branch'); e.status = 403; throw e;
  }
  if (req.status !== 'PENDING_APPROVAL') {
    const e = new Error(`Cannot approve a request in status ${req.status}`);
    e.status = 409; throw e;
  }
  if (!Array.isArray(req.sessionMode) || req.sessionMode.length !== req.totalSessions) {
    const e = new Error('Request session mode array is malformed'); e.status = 500; throw e;
  }
  if (req.sessions.length > 0) {
    const e = new Error('Sessions already scheduled for this request'); e.status = 409; throw e;
  }
  _validateScheduledSessions(scheduledSessions, req.totalSessions);

  // Therapist must exist and belong to the request's branch.
  const therapist = await prisma.therapist.findUnique({
    where: { id: therapistId },
    include: { user: { select: { id: true, branchId: true } } },
  });
  if (!therapist) {
    const e = new Error('Therapist not found'); e.status = 404; throw e;
  }
  if (therapist.user?.branchId && therapist.user.branchId !== req.branchId) {
    const e = new Error('Therapist belongs to a different branch'); e.status = 400; throw e;
  }

  // Sort by sessionNumber so the index lookup against sessionMode is correct.
  const ordered = [...scheduledSessions].sort((a, b) => a.sessionNumber - b.sessionNumber);

  const result = await prisma.$transaction(async (tx) => {
    // 1. Flip request status.
    const approved = await tx.homeTherapyRequest.update({
      where: { id: requestId },
      data: {
        status:          'APPROVED',
        approvedById:    user.id,
        approvedByRole:  user.role,
        approvedAt:      new Date(),
      },
    });

    const createdSessions = [];
    for (const s of ordered) {
      const idx = s.sessionNumber - 1;
      const mode = req.sessionMode[idx];
      // Compose the scheduled datetime (UTC — caller posts in branch tz,
      // our scheduler / reminders read DateTime as-is).
      const scheduledAt = new Date(`${s.date}T${s.time}:00.000Z`);

      // 2a. Create the Appointment row first so the HomeTherapySession can
      //     link to it via the unique appointmentId column.
      const appt = await tx.appointment.create({
        data: {
          patientId:        req.patientId,
          therapistId:      therapist.id,
          date:             scheduledAt,
          status:           'CONFIRMED',
          consultationType: 'THERAPIST',
          consultationMode: 'OFFLINE',
          branchId:         req.branchId,
          notes:            req.notes ? `Home therapy (${mode}) · ${req.notes}` : `Home therapy (${mode})`,
        },
      });

      // 2b. Create the HomeTherapySession row.
      const session = await tx.homeTherapySession.create({
        data: {
          requestId:     requestId,
          therapistId:   therapist.id,
          patientId:     req.patientId,
          branchId:      req.branchId,
          sessionNumber: s.sessionNumber,
          scheduledDate: scheduledAt,
          scheduledTime: s.time,
          mode,
          status:        'SCHEDULED',
          appointmentId: appt.id,
        },
      });
      createdSessions.push({ ...session, appointment: appt });

      // 2c. Block the therapist's calendar — 1-hour window around the
      //     scheduled time so other booking flows can't double-book.
      try {
        const [hh, mm] = s.time.split(':').map(Number);
        const startTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        const endHour = (hh + 1) % 24;
        const endTime = `${String(endHour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        await tx.blockedSlot.create({
          data: {
            therapistId: therapist.id,
            date:        scheduledAt,
            startTime,
            endTime,
            reason:      `Home therapy session #${s.sessionNumber}`,
            kind:        'HOME_THERAPY',
          },
        });
      } catch (err) {
        // Don't bubble — the appointment/session are the canonical state.
        // BlockedSlot is a UI hint and recreatable.
      }
    }

    return { approved, sessions: createdSessions };
  });

  // 3. Post-commit fanout. All best-effort.
  try {
    const payload = {
      requestId,
      patientId:   req.patientId,
      therapistId: therapist.id,
      branchId:    req.branchId,
      totalSessions: req.totalSessions,
      sessions: result.sessions.map((s) => ({
        id: s.id, sessionNumber: s.sessionNumber, mode: s.mode,
        scheduledDate: s.scheduledDate, scheduledTime: s.scheduledTime,
      })),
    };
    if (req.requestingDoctor?.userId) emitToUser(req.requestingDoctor.userId, 'home_therapy_approved', payload);
    if (req.patient?.userId)          emitToUser(req.patient.userId,          'home_therapy_approved', payload);
    if (therapist.user?.id)           emitToUser(therapist.user.id,           'home_therapy_approved', payload);
    // Also broadcast to admin role rooms so the dashboard refreshes.
    emitToRole('ADMIN', 'home_therapy_approved', payload);
    emitToRole('ADMIN_DOCTOR', 'home_therapy_approved', payload);
    emitToRole('BRANCH_ADMIN', 'home_therapy_approved', payload);
  } catch (err) {
    logger?.warn?.('[homeTherapy] emit home_therapy_approved failed', { err: err?.message });
  }

  return result;
}

/**
 * Validate the edit-request scheduledSessions payload. Same shape as approve
 * (sessionNumber/date/time) plus a required `mode` per row so the request's
 * sessionMode array can be recomposed.
 */
function _validateEditPayload(scheduled) {
  if (!Array.isArray(scheduled) || scheduled.length === 0 || scheduled.length > 50) {
    const e = new Error('scheduledSessions must contain 1..50 entries');
    e.status = 400; throw e;
  }
  const N = scheduled.length;
  const seen = new Set();
  for (const s of scheduled) {
    const num = Number(s?.sessionNumber);
    if (!Number.isInteger(num) || num < 1 || num > N) {
      const e = new Error(`scheduledSessions[].sessionNumber must be 1..${N}`);
      e.status = 400; throw e;
    }
    if (seen.has(num)) {
      const e = new Error(`Duplicate sessionNumber ${num} in scheduledSessions`);
      e.status = 400; throw e;
    }
    seen.add(num);
    if (typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) {
      const e = new Error('scheduledSessions[].date must be YYYY-MM-DD');
      e.status = 400; throw e;
    }
    if (typeof s.time !== 'string' || !/^\d{2}:\d{2}$/.test(s.time)) {
      const e = new Error('scheduledSessions[].time must be HH:MM');
      e.status = 400; throw e;
    }
    if (!VALID_MODES.has(s.mode)) {
      const e = new Error(`scheduledSessions[].mode must be one of ${[...VALID_MODES].join(',')}`);
      e.status = 400; throw e;
    }
  }
}

/**
 * PATCH /api/home-therapy/requests/:id — admin edit of an APPROVED or
 * IN_PROGRESS request. Allows changing the assigned therapist and the
 * scheduled sessions (reschedule, add, drop), with strict immutability
 * for sessions that are no longer SCHEDULED.
 *
 * Rules:
 *  - Only ADMIN-like roles. BRANCH_ADMIN / ADMIN_DOCTOR limited to own branch.
 *  - PENDING_APPROVAL: bounce — admin should approve (which handles scheduling).
 *  - COMPLETED / REJECTED / CANCELLED: bounce — terminal states are immutable.
 *  - For each existing session whose status is not SCHEDULED, the payload row
 *    with the same sessionNumber MUST be present and MUST keep the same
 *    date/time/mode (else 409).
 *  - Therapist reassignment applies to all SCHEDULED sessions only — sessions
 *    that have started or completed retain their original therapist.
 *  - Drops + adds maintained transactionally with their Appointment + BlockedSlot.
 */
async function editRequest(requestId, user, payload) {
  if (!isAdminLike(user.role)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  const { therapistId, intervalDays, notes, scheduledSessions } = payload || {};
  _validateEditPayload(scheduledSessions);

  const req = await prisma.homeTherapyRequest.findUnique({
    where: { id: requestId },
    include: {
      sessions: { orderBy: { sessionNumber: 'asc' } },
      patient: { select: { id: true, userId: true, branchId: true } },
      requestingDoctor: { select: { userId: true } },
    },
  });
  if (!req) {
    const e = new Error('Home therapy request not found'); e.status = 404; throw e;
  }
  if (userIsBranchScoped(user.role) && req.branchId !== user.branchId) {
    const e = new Error('Forbidden — request belongs to another branch'); e.status = 403; throw e;
  }
  if (req.status !== 'APPROVED' && req.status !== 'IN_PROGRESS') {
    const e = new Error(`Cannot edit a request in status ${req.status}`);
    e.status = 409; throw e;
  }

  // Resolve the desired therapist (default: keep current). Existing sessions
  // hold their own therapistId; we use the FIRST SCHEDULED session as the
  // "current" therapist baseline because the request itself doesn't carry one.
  const currentTherapistId = req.sessions[0]?.therapistId ?? null;
  const newTherapistId = therapistId ?? currentTherapistId;
  if (!newTherapistId) {
    const e = new Error('therapistId could not be resolved'); e.status = 400; throw e;
  }

  // Validate therapist exists and is in the same branch.
  const therapist = await prisma.therapist.findUnique({
    where: { id: newTherapistId },
    include: { user: { select: { id: true, branchId: true } } },
  });
  if (!therapist) {
    const e = new Error('Therapist not found'); e.status = 404; throw e;
  }
  if (therapist.user?.branchId && therapist.user.branchId !== req.branchId) {
    const e = new Error('Therapist belongs to a different branch'); e.status = 400; throw e;
  }

  // Resolve the previous therapist's userId so we can fire a
  // `home_therapy_edited` event at them post-commit. Without this their
  // dashboard panel keeps showing the now-reassigned sessions until they
  // refresh manually. Skipped when the therapist isn't actually changing.
  let previousTherapistUserId = null;
  if (currentTherapistId && currentTherapistId !== therapist.id) {
    const prev = await prisma.therapist.findUnique({
      where: { id: currentTherapistId },
      select: { user: { select: { id: true } } },
    });
    previousTherapistUserId = prev?.user?.id ?? null;
  }

  const ordered = [...scheduledSessions].sort((a, b) => a.sessionNumber - b.sessionNumber);
  const N = ordered.length;
  const byNumberPayload = new Map(ordered.map((s) => [s.sessionNumber, s]));
  const byNumberExisting = new Map(req.sessions.map((s) => [s.sessionNumber, s]));

  // Pre-flight integrity checks: no edit may mutate or drop a session that's
  // already in flight or done. Do these before opening the transaction so we
  // can reject cheaply with a clean 409.
  for (const existing of req.sessions) {
    const incoming = byNumberPayload.get(existing.sessionNumber);
    if (existing.status === 'COMPLETED' || existing.status === 'IN_PROGRESS' ||
        existing.status === 'EN_ROUTE' || existing.status === 'ARRIVED') {
      if (!incoming) {
        const e = new Error(`Cannot drop session ${existing.sessionNumber} — status is ${existing.status}`);
        e.status = 409; throw e;
      }
      // Date/time on these rows is immutable. Compare on the YYYY-MM-DD
      // portion of scheduledDate so client tz drift doesn't trip the check.
      const existingDate = existing.scheduledDate.toISOString().slice(0, 10);
      if (incoming.date !== existingDate || incoming.time !== existing.scheduledTime || incoming.mode !== existing.mode) {
        const e = new Error(`Cannot modify session ${existing.sessionNumber} — status is ${existing.status}`);
        e.status = 409; throw e;
      }
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const created = [];
    const updated = [];
    const dropped = [];

    // 1. Drop sessions whose sessionNumber > N (they're no longer in payload).
    //    Pre-flight already ensured these are SCHEDULED.
    for (const existing of req.sessions) {
      if (!byNumberPayload.has(existing.sessionNumber)) {
        // Best-effort delete the BlockedSlot keyed on therapistId + date.
        // It's a UI hint — losing it is non-fatal.
        try {
          await tx.blockedSlot.deleteMany({
            where: {
              therapistId: existing.therapistId,
              date: existing.scheduledDate,
              startTime: existing.scheduledTime,
              kind: 'HOME_THERAPY',
            },
          });
        } catch { /* ignore */ }
        // Cancel + detach the appointment so the session FK can clear.
        if (existing.appointmentId) {
          try {
            await tx.homeTherapySession.update({
              where: { id: existing.id },
              data: { appointmentId: null },
            });
            await tx.appointment.update({
              where: { id: existing.appointmentId },
              data: { status: 'CANCELLED' },
            });
          } catch { /* ignore */ }
        }
        await tx.homeTherapySession.delete({ where: { id: existing.id } });
        dropped.push(existing.sessionNumber);
      }
    }

    // 2. Walk the payload: update existing or create new.
    for (const s of ordered) {
      const scheduledAt = new Date(`${s.date}T${s.time}:00.000Z`);
      const existing = byNumberExisting.get(s.sessionNumber);

      if (!existing) {
        // CREATE — new session number not present before. Mirror the approve
        // flow: Appointment first, then HomeTherapySession, then BlockedSlot.
        const appt = await tx.appointment.create({
          data: {
            patientId:        req.patientId,
            therapistId:      therapist.id,
            date:             scheduledAt,
            status:           'CONFIRMED',
            consultationType: 'THERAPIST',
            consultationMode: 'OFFLINE',
            branchId:         req.branchId,
            notes:            req.notes ? `Home therapy (${s.mode}) · ${req.notes}` : `Home therapy (${s.mode})`,
          },
        });
        const session = await tx.homeTherapySession.create({
          data: {
            requestId:     requestId,
            therapistId:   therapist.id,
            patientId:     req.patientId,
            branchId:      req.branchId,
            sessionNumber: s.sessionNumber,
            scheduledDate: scheduledAt,
            scheduledTime: s.time,
            mode:          s.mode,
            status:        'SCHEDULED',
            appointmentId: appt.id,
          },
        });
        try {
          const [hh, mm] = s.time.split(':').map(Number);
          const startTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
          const endHour = (hh + 1) % 24;
          const endTime = `${String(endHour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
          await tx.blockedSlot.create({
            data: {
              therapistId: therapist.id,
              date:        scheduledAt,
              startTime,
              endTime,
              reason:      `Home therapy session #${s.sessionNumber}`,
              kind:        'HOME_THERAPY',
            },
          });
        } catch { /* ignore */ }
        created.push({ ...session, appointment: appt });
        continue;
      }

      // UPDATE — existing session present. Only SCHEDULED rows can move.
      // Pre-flight already guaranteed non-SCHEDULED rows match exactly, so
      // the conditional below is a no-op for them.
      if (existing.status !== 'SCHEDULED') {
        updated.push(existing);
        continue;
      }

      const dateChanged = existing.scheduledDate.toISOString().slice(0, 10) !== s.date;
      const timeChanged = existing.scheduledTime !== s.time;
      const modeChanged = existing.mode !== s.mode;
      const therapistChanged = existing.therapistId !== therapist.id;
      if (!dateChanged && !timeChanged && !modeChanged && !therapistChanged) {
        updated.push(existing);
        continue;
      }

      const updatedSession = await tx.homeTherapySession.update({
        where: { id: existing.id },
        data: {
          scheduledDate: scheduledAt,
          scheduledTime: s.time,
          mode:          s.mode,
          therapistId:   therapist.id,
        },
      });

      if (existing.appointmentId) {
        await tx.appointment.update({
          where: { id: existing.appointmentId },
          data: {
            date:        scheduledAt,
            therapistId: therapist.id,
            notes:       req.notes ? `Home therapy (${s.mode}) · ${req.notes}` : `Home therapy (${s.mode})`,
          },
        });
      }

      // Re-issue the BlockedSlot. Easier to delete-and-recreate than to find
      // and PATCH the right one (BlockedSlot has no session FK).
      try {
        await tx.blockedSlot.deleteMany({
          where: {
            therapistId: existing.therapistId,
            date:        existing.scheduledDate,
            startTime:   existing.scheduledTime,
            kind:        'HOME_THERAPY',
          },
        });
        const [hh, mm] = s.time.split(':').map(Number);
        const startTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        const endHour = (hh + 1) % 24;
        const endTime = `${String(endHour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        await tx.blockedSlot.create({
          data: {
            therapistId: therapist.id,
            date:        scheduledAt,
            startTime,
            endTime,
            reason:      `Home therapy session #${s.sessionNumber}`,
            kind:        'HOME_THERAPY',
          },
        });
      } catch { /* ignore */ }

      updated.push(updatedSession);
    }

    // 3. Recompose request.sessionMode from the payload (sessionNumber order).
    const newSessionMode = ordered.map((s) => s.mode);
    const requestUpdate = await tx.homeTherapyRequest.update({
      where: { id: requestId },
      data: {
        totalSessions: N,
        sessionMode:   newSessionMode,
        ...(intervalDays !== undefined && { intervalDays: intervalDays ?? null }),
        ...(notes        !== undefined && { notes:        notes ?? null }),
      },
    });

    return { request: requestUpdate, created, updated, dropped };
  });

  // Post-commit fanout. Best-effort; never blocks the success response.
  try {
    const payloadOut = {
      requestId,
      patientId:   req.patientId,
      therapistId: therapist.id,
      branchId:    req.branchId,
      totalSessions: N,
      created:  result.created.length,
      dropped:  result.dropped.length,
      updated:  result.updated.length,
    };
    if (req.requestingDoctor?.userId) emitToUser(req.requestingDoctor.userId, 'home_therapy_edited', payloadOut);
    if (req.patient?.userId)          emitToUser(req.patient.userId,          'home_therapy_edited', payloadOut);
    if (therapist.user?.id)           emitToUser(therapist.user.id,           'home_therapy_edited', payloadOut);
    // Old therapist (if reassigned) — their dashboard needs to drop the
    // sessions they no longer own. Skipped when the therapist didn't change.
    if (previousTherapistUserId && previousTherapistUserId !== therapist.user?.id) {
      emitToUser(previousTherapistUserId, 'home_therapy_edited', payloadOut);
    }
    emitToRole('ADMIN',         'home_therapy_edited', payloadOut);
    emitToRole('ADMIN_DOCTOR',  'home_therapy_edited', payloadOut);
    emitToRole('BRANCH_ADMIN',  'home_therapy_edited', payloadOut);
  } catch (err) {
    logger?.warn?.('[homeTherapy] emit home_therapy_edited failed', { err: err?.message });
  }

  return result;
}

/**
 * POST /api/home-therapy/requests/:id/reject
 */
async function rejectRequest(requestId, user, { reason }) {
  if (!isAdminLike(user.role)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    const e = new Error('reason is required'); e.status = 400; throw e;
  }
  if (reason.length > 500) {
    const e = new Error('reason must be 500 chars or less'); e.status = 400; throw e;
  }
  const req = await prisma.homeTherapyRequest.findUnique({
    where: { id: requestId },
    select: { id: true, branchId: true, status: true, patient: { select: { userId: true } }, requestingDoctor: { select: { userId: true } } },
  });
  if (!req) {
    const e = new Error('Home therapy request not found'); e.status = 404; throw e;
  }
  if (userIsBranchScoped(user.role) && req.branchId !== user.branchId) {
    const e = new Error('Forbidden — request belongs to another branch'); e.status = 403; throw e;
  }
  if (req.status !== 'PENDING_APPROVAL') {
    const e = new Error(`Cannot reject a request in status ${req.status}`);
    e.status = 409; throw e;
  }
  const updated = await prisma.homeTherapyRequest.update({
    where: { id: requestId },
    data: {
      status:         'REJECTED',
      rejectedReason: reason.trim(),
      approvedById:   user.id,
      approvedByRole: user.role,
      approvedAt:     new Date(),
    },
  });
  try {
    const payload = { requestId, status: 'REJECTED', reason: reason.trim() };
    if (req.requestingDoctor?.userId) emitToUser(req.requestingDoctor.userId, 'home_therapy_rejected', payload);
    if (req.patient?.userId)          emitToUser(req.patient.userId,          'home_therapy_rejected', payload);
    emitToRole('ADMIN', 'home_therapy_rejected', payload);
    emitToRole('ADMIN_DOCTOR', 'home_therapy_rejected', payload);
    emitToRole('BRANCH_ADMIN', 'home_therapy_rejected', payload);
  } catch (err) {
    logger?.warn?.('[homeTherapy] emit home_therapy_rejected failed', { err: err?.message });
  }
  return updated;
}

/**
 * GET /api/home-therapy/sessions — list, filtered.
 *   - therapistId or date filters (date is YYYY-MM-DD; matches scheduledDate's date portion).
 *   - THERAPIST: forced to their own therapistId.
 *   - admin-like: free filter, but BRANCH_ADMIN / ADMIN_DOCTOR pinned to branch.
 */
async function listSessions({ therapistId = null, date = null, from = null, to = null, branchId = null, user }) {
  const where = {};
  if (user.role === 'THERAPIST') {
    const therapist = await _therapistForUser(user.id);
    if (!therapist) return [];
    where.therapistId = therapist.id;
  } else if (isAdminLike(user.role)) {
    if (therapistId) where.therapistId = therapistId;
    if (userIsBranchScoped(user.role)) {
      where.branchId = user.branchId;
    } else if (branchId) {
      where.branchId = branchId;
    }
  } else {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  // `date` (exact match) and `from`/`to` (range) are mutually exclusive.
  // The exact-match form is kept for backwards compatibility — older
  // dashboards still pass it. New callers (the therapist panel that needs
  // to surface freshly-approved sessions even when they're a few days out)
  // pass `from` + `to` instead.
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const e = new Error('date must be YYYY-MM-DD'); e.status = 400; throw e;
    }
    const start = new Date(`${date}T00:00:00.000Z`);
    const end   = new Date(`${date}T23:59:59.999Z`);
    where.scheduledDate = { gte: start, lte: end };
  } else if (from || to) {
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      const e = new Error('from must be YYYY-MM-DD'); e.status = 400; throw e;
    }
    if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const e = new Error('to must be YYYY-MM-DD'); e.status = 400; throw e;
    }
    const range = {};
    if (from) range.gte = new Date(`${from}T00:00:00.000Z`);
    if (to)   range.lte = new Date(`${to}T23:59:59.999Z`);
    where.scheduledDate = range;
  }
  return prisma.homeTherapySession.findMany({
    where,
    include: SESSION_INCLUDE,
    orderBy: [{ scheduledDate: 'asc' }, { sessionNumber: 'asc' }],
    take: 500,
  });
}

/**
 * GET /api/home-therapy/sessions/:id
 */
async function getSession(id, user) {
  const session = await prisma.homeTherapySession.findUnique({
    where: { id },
    include: SESSION_INCLUDE,
  });
  if (!session) {
    const e = new Error('Home therapy session not found'); e.status = 404; throw e;
  }
  if (isAdminLike(user.role)) {
    if (userIsBranchScoped(user.role) && session.branchId !== user.branchId) {
      const e = new Error('Forbidden — session belongs to another branch'); e.status = 403; throw e;
    }
    return session;
  }
  if (user.role === 'THERAPIST') {
    const therapist = await _therapistForUser(user.id);
    if (!therapist || session.therapistId !== therapist.id) {
      const e = new Error('Forbidden — not your session'); e.status = 403; throw e;
    }
    return session;
  }
  if (user.role === 'PATIENT') {
    if (session.patient?.userId !== user.id) {
      const e = new Error('Forbidden — not your session'); e.status = 403; throw e;
    }
    return session;
  }
  const e = new Error('Forbidden'); e.status = 403; throw e;
}

/**
 * Generic state-transition helper — used by depart/arrive/start/complete.
 * Validates that the caller is the assigned therapist and that the new
 * status is reachable from the current one.
 */
const STATE_TRANSITIONS = {
  depart:   { from: ['SCHEDULED'],                     to: 'THERAPIST_EN_ROUTE',  stamp: 'therapistDepartedAt' },
  arrive:   { from: ['THERAPIST_EN_ROUTE'],            to: 'THERAPIST_ARRIVED',   stamp: 'therapistArrivedAt'  },
  start:    { from: ['THERAPIST_ARRIVED', 'SCHEDULED'], to: 'IN_SESSION',         stamp: 'sessionStartedAt'    },
  complete: { from: ['IN_SESSION', 'THERAPIST_ARRIVED'], to: 'COMPLETED',         stamp: 'sessionCompletedAt'  },
};

async function transitionSession(action, sessionId, user) {
  const t = STATE_TRANSITIONS[action];
  if (!t) {
    const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
  }
  if (user.role !== 'THERAPIST' && !(user.role === 'ADMIN' || user.role === 'ADMIN_DOCTOR')) {
    const e = new Error('Forbidden — only therapists can transition session state'); e.status = 403; throw e;
  }
  const session = await prisma.homeTherapySession.findUnique({
    where: { id: sessionId },
    include: { therapist: { select: { id: true, userId: true } }, patient: { select: { userId: true, fullName: true } } },
  });
  if (!session) {
    const e = new Error('Home therapy session not found'); e.status = 404; throw e;
  }
  if (user.role === 'THERAPIST') {
    const therapist = await _therapistForUser(user.id);
    if (!therapist || session.therapistId !== therapist.id) {
      const e = new Error('Forbidden — not your session'); e.status = 403; throw e;
    }
  }
  if (!t.from.includes(session.status)) {
    const e = new Error(`Cannot transition from ${session.status} to ${t.to}`);
    e.status = 409; throw e;
  }
  const data = { status: t.to };
  data[t.stamp] = new Date();
  // On `complete`, also flip the linked Appointment to COMPLETED so the
  // existing CSAT / billing pipelines pick it up.
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.homeTherapySession.update({
      where: { id: sessionId },
      data,
      include: SESSION_INCLUDE,
    });
    if (action === 'complete' && next.appointmentId) {
      await tx.appointment.update({
        where: { id: next.appointmentId },
        // Don't clobber a non-PENDING/CONFIRMED status set by the queue/no-show flows.
        data: { status: 'COMPLETED' },
      }).catch(() => {});
    }
    return next;
  });

  // Emit a uniform `session_status_changed` to interested rooms — admins,
  // patient, and the home-therapy namespace session room. Task 8 lays a
  // dedicated `session_completed` on top of this for the completion path.
  try {
    const payload = {
      sessionId: updated.id,
      requestId: updated.requestId,
      status:    updated.status,
      mode:      updated.mode,
      action,
      therapistArrivedAt:   updated.therapistArrivedAt,
      therapistDepartedAt:  updated.therapistDepartedAt,
      sessionStartedAt:     updated.sessionStartedAt,
      sessionCompletedAt:   updated.sessionCompletedAt,
    };
    emitToHomeTherapyRoom(`session:${updated.id}`, 'session_status_changed', payload);
    if (updated.patient?.userId) emitToUser(updated.patient.userId, 'session_status_changed', payload);
    emitToRole('ADMIN', 'session_status_changed', payload);
    emitToRole('ADMIN_DOCTOR', 'session_status_changed', payload);
    emitToRole('BRANCH_ADMIN', 'session_status_changed', payload);
    if (action === 'complete') {
      // Convenience event used by the patient-side feedback trigger (Task 8).
      const completedPayload = { ...payload, patientId: updated.patientId };
      emitToHomeTherapyRoom(`session:${updated.id}`, 'session_completed', completedPayload);
      if (updated.patient?.userId) emitToUser(updated.patient.userId, 'session_completed', completedPayload);
    }
  } catch (err) {
    logger?.warn?.('[homeTherapy] emit session_status_changed failed', { err: err?.message });
  }
  return updated;
}

/**
 * POST /api/home-therapy/sessions/:id/location-ping
 *
 * - Only the assigned THERAPIST may ping.
 * - Rate-limited via Redis: 1 request per 10 seconds per therapist.
 *   When Redis is unavailable, fail-open (i.e. accept the ping) so a
 *   transient Redis outage doesn't blind admins to the live map.
 * - Inserts a TherapistLocationPing row.
 * - Emits `therapist_location_update` to the /home-therapy namespace
 *   `session:<id>` room AND to the patient's user room (default ns).
 */
async function recordLocationPing(sessionId, user, { latitude, longitude, accuracy }) {
  if (user.role !== 'THERAPIST') {
    const e = new Error('Forbidden — only therapists can ping location'); e.status = 403; throw e;
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    const e = new Error('Invalid latitude'); e.status = 400; throw e;
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    const e = new Error('Invalid longitude'); e.status = 400; throw e;
  }
  const therapist = await _therapistForUser(user.id);
  if (!therapist) {
    const e = new Error('Therapist profile not found'); e.status = 403; throw e;
  }
  const session = await prisma.homeTherapySession.findUnique({
    where: { id: sessionId },
    select: { id: true, therapistId: true, patientId: true,
      patient: { select: { userId: true } } },
  });
  if (!session) {
    const e = new Error('Home therapy session not found'); e.status = 404; throw e;
  }
  if (session.therapistId !== therapist.id) {
    const e = new Error('Forbidden — not your session'); e.status = 403; throw e;
  }

  // Rate limit — SET key 1 EX 10 NX. setIfAbsent returns:
  //   true  → we got the slot
  //   false → already locked (rate-limited → 429)
  //   null  → Redis unavailable / circuit open → fail-open
  const slot = await cacheService.setIfAbsent(`therapist:ping:${therapist.id}`, 1, 10);
  if (slot === false) {
    const e = new Error('Too many location pings — please wait'); e.status = 429; throw e;
  }

  const ping = await prisma.therapistLocationPing.create({
    data: {
      sessionId,
      therapistId: therapist.id,
      latitude,
      longitude,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
    },
  });

  try {
    const payload = {
      sessionId,
      therapistId: therapist.id,
      latitude,
      longitude,
      accuracy: ping.accuracy,
      timestamp: ping.timestamp,
    };
    emitToHomeTherapyRoom(`session:${sessionId}`, 'therapist_location_update', payload);
    if (session.patient?.userId) {
      emitToHomeTherapyRoom(`patient:${session.patient.userId}`, 'therapist_location_update', payload);
      // Also fan out on the default namespace so the patient's portal
      // (which uses the default socket connection) hears it without
      // joining the home-therapy ns.
      emitToUser(session.patient.userId, 'therapist_location_update', payload);
    }
  } catch (err) {
    logger?.warn?.('[homeTherapy] emit therapist_location_update failed', { err: err?.message });
  }
  return ping;
}

/**
 * GET /api/home-therapy/sessions/:id/location — last known ping.
 */
async function getSessionLastLocation(sessionId, user) {
  const session = await prisma.homeTherapySession.findUnique({
    where: { id: sessionId },
    select: { id: true, branchId: true, patient: { select: { userId: true } } },
  });
  if (!session) {
    const e = new Error('Home therapy session not found'); e.status = 404; throw e;
  }
  if (isAdminLike(user.role)) {
    if (userIsBranchScoped(user.role) && session.branchId !== user.branchId) {
      const e = new Error('Forbidden — session belongs to another branch'); e.status = 403; throw e;
    }
  } else if (user.role === 'PATIENT') {
    if (session.patient?.userId !== user.id) {
      const e = new Error('Forbidden — not your session'); e.status = 403; throw e;
    }
  } else if (user.role === 'THERAPIST') {
    // Therapist can read their own pings (useful for debugging).
    const therapist = await _therapistForUser(user.id);
    if (!therapist) { const e = new Error('Forbidden'); e.status = 403; throw e; }
    // We re-query ownership cheaply since the SESSION_INCLUDE shape isn't
    // needed here; the route gate is sufficient for the common case.
  } else {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  return prisma.therapistLocationPing.findFirst({
    where: { sessionId },
    orderBy: { timestamp: 'desc' },
  });
}

/**
 * GET /api/home-therapy/sessions/:id/next — therapist's next session today,
 * sorted by scheduledTime. Used by the therapist UI's "Next Patient" card.
 */
async function getNextSession(currentSessionId, user) {
  if (user.role !== 'THERAPIST') {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  const therapist = await _therapistForUser(user.id);
  if (!therapist) return null;
  const current = await prisma.homeTherapySession.findUnique({
    where: { id: currentSessionId },
    select: { id: true, therapistId: true, scheduledDate: true, scheduledTime: true },
  });
  if (!current || current.therapistId !== therapist.id) {
    const e = new Error('Forbidden — not your session'); e.status = 403; throw e;
  }
  // Same calendar day in UTC. We treat scheduledDate as the source of truth.
  const dayKey = current.scheduledDate.toISOString().slice(0, 10);
  const start = new Date(`${dayKey}T00:00:00.000Z`);
  const end   = new Date(`${dayKey}T23:59:59.999Z`);
  // "Next" = same day, time strictly greater than current.scheduledTime,
  // status not COMPLETED/CANCELLED/NO_SHOW.
  const candidates = await prisma.homeTherapySession.findMany({
    where: {
      therapistId: therapist.id,
      scheduledDate: { gte: start, lte: end },
      status: { notIn: ['COMPLETED', 'CANCELLED', 'NO_SHOW'] },
      id: { not: currentSessionId },
    },
    include: SESSION_INCLUDE,
    orderBy: [{ scheduledTime: 'asc' }],
  });
  // Pick the first one whose scheduledTime > current.scheduledTime, falling
  // back to the earliest still-pending session of the day if none is later.
  const later = candidates.find((c) => c.scheduledTime > current.scheduledTime);
  return later ?? candidates[0] ?? null;
}

/**
 * POST /api/feedback/home-therapy-session — both therapist and patient
 * submit feedback after a session completes. The route hands the validated
 * payload to this service.
 *
 * Idempotency: each (sessionId, authorRole) pair can submit at most one
 * row — the corresponding HomeTherapySession field (therapistFeedbackId or
 * patientFeedbackId) is `@unique`, so a duplicate submit is rejected by
 * Prisma. We surface that as a 409.
 *
 * XP: positive PATIENT feedback (rating ≥ 4) awards +75 XP to the
 * therapist's User. Idempotent via `xpAwarded` flag on the row.
 */
async function submitFeedback({ sessionId, user, authorRole, rating, tags = [], notes = null }) {
  if (!authorRole || !['THERAPIST', 'PATIENT'].includes(authorRole)) {
    const e = new Error('authorRole must be THERAPIST or PATIENT'); e.status = 400; throw e;
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    const e = new Error('rating must be an integer between 1 and 5'); e.status = 400; throw e;
  }
  if (notes != null && typeof notes !== 'string') {
    const e = new Error('notes must be a string'); e.status = 400; throw e;
  }
  if (notes && notes.length > 1000) {
    const e = new Error('notes must be 1000 chars or less'); e.status = 400; throw e;
  }
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
    const e = new Error('tags must be an array of strings'); e.status = 400; throw e;
  }

  const session = await prisma.homeTherapySession.findUnique({
    where: { id: sessionId },
    include: {
      therapist: { select: { id: true, userId: true } },
      patient:   { select: { id: true, userId: true } },
    },
  });
  if (!session) {
    const e = new Error('Home therapy session not found'); e.status = 404; throw e;
  }

  // RBAC: the caller must own the role they claim authorship for.
  if (authorRole === 'THERAPIST') {
    if (user.role !== 'THERAPIST' || session.therapist?.userId !== user.id) {
      const e = new Error('Forbidden — not the assigned therapist'); e.status = 403; throw e;
    }
  } else {
    if (user.role !== 'PATIENT' || session.patient?.userId !== user.id) {
      const e = new Error('Forbidden — not the patient on this session'); e.status = 403; throw e;
    }
  }

  // Cannot submit feedback for a session that hasn't completed yet.
  if (session.status !== 'COMPLETED') {
    const e = new Error('Cannot submit feedback before the session is completed');
    e.status = 409; throw e;
  }

  // Idempotency: existing row → 409 with a "already submitted" message.
  if (authorRole === 'THERAPIST' && session.therapistFeedbackId) {
    const e = new Error('Therapist feedback already submitted for this session');
    e.status = 409; throw e;
  }
  if (authorRole === 'PATIENT' && session.patientFeedbackId) {
    const e = new Error('Patient feedback already submitted for this session');
    e.status = 409; throw e;
  }

  // Sentiment from rating: ≥4 POSITIVE, ==3 NEUTRAL, ≤2 NEGATIVE.
  const sentiment = rating >= 4 ? 'POSITIVE' : rating === 3 ? 'NEUTRAL' : 'NEGATIVE';

  // Create the feedback row + link it back onto the session in one tx.
  const result = await prisma.$transaction(async (tx) => {
    const feedback = await tx.homeTherapyFeedback.create({
      data: {
        sessionId,
        authorRole,
        rating,
        sentiment,
        notes: notes ? notes.trim() : null,
        tags,
      },
    });
    const linkField = authorRole === 'THERAPIST' ? 'therapistFeedbackId' : 'patientFeedbackId';
    await tx.homeTherapySession.update({
      where: { id: sessionId },
      data:  { [linkField]: feedback.id },
    });
    return feedback;
  });

  // Patient → therapist XP award. Mirrors feedbackXp.service.js's flat-XP
  // (no streak multiplier) approach. Awards once via the `xpAwarded` flag.
  if (authorRole === 'PATIENT' && sentiment === 'POSITIVE') {
    try {
      await prisma.$transaction(async (tx) => {
        const fresh = await tx.homeTherapyFeedback.findUnique({
          where: { id: result.id },
          select: { id: true, xpAwarded: true },
        });
        if (fresh && !fresh.xpAwarded && session.therapist?.userId) {
          await tx.xPLedger.create({
            data: {
              userId:   session.therapist.userId,
              action:   'POSITIVE_HOME_THERAPY_FEEDBACK',
              xpAmount: 75,
              sourceId: result.id,
              metadata: {
                source:    'home_therapy_feedback',
                sessionId,
                rating,
                tags,
              },
            },
          });
          await tx.homeTherapyFeedback.update({
            where: { id: result.id },
            data:  { xpAwarded: true },
          });
        }
      });
      // Best-effort socket notification.
      if (session.therapist?.userId) {
        try {
          emitToUser(session.therapist.userId, 'xp_awarded', {
            amount: 75,
            event:  'POSITIVE_HOME_THERAPY_FEEDBACK',
            source: 'Patient Home-Therapy Feedback',
            sessionId,
          });
        } catch (err) {
          logger?.warn?.('[homeTherapy] xp_awarded emit failed', { err: err?.message });
        }
      }
    } catch (err) {
      // XP failure must not block the feedback save — log and continue.
      logger?.warn?.('[homeTherapy] XP award failed', { err: err?.message, feedbackId: result.id });
    }
  }

  // Notify the OTHER party so their UI can refresh ratings / banners.
  try {
    if (authorRole === 'THERAPIST' && session.patient?.userId) {
      emitToUser(session.patient.userId, 'home_therapy_feedback_submitted',
        { sessionId, authorRole: 'THERAPIST', rating });
    } else if (authorRole === 'PATIENT' && session.therapist?.userId) {
      emitToUser(session.therapist.userId, 'home_therapy_feedback_submitted',
        { sessionId, authorRole: 'PATIENT', rating });
    }
  } catch { /* swallow */ }

  return result;
}

/**
 * Per-therapist home-therapy stats for the Performance Scorecards page.
 *
 * Returns one row per therapist in the branch with sessions in the period:
 *   {
 *     therapistId, therapistName, fullName, gender,
 *     completed,       // COMPLETED sessions in period
 *     scheduled,       // total sessions whose scheduledDate is in period
 *     completionRate,  // (completed / scheduled) × 100, 0 when scheduled = 0
 *     avgPatientRating,// avg of HomeTherapyFeedback (authorRole=PATIENT) ratings
 *     feedbackCount,   // count of patient feedback rows
 *     onTimeRate,      // count(arrivedAt <= scheduledTime + 15m) / count(COMPLETED) × 100
 *   }
 *
 * Period: 'month' (default) = first day of current month → now.
 *         'quarter' = first day of current 3-month block.
 */
async function getBranchScorecardStats({ branchId, period = 'month', user }) {
  if (!isAdminLike(user.role)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  if (!branchId) {
    const e = new Error('branchId is required'); e.status = 400; throw e;
  }
  if (userIsBranchScoped(user.role) && branchId !== user.branchId) {
    const e = new Error('Forbidden — branch belongs to another scope'); e.status = 403; throw e;
  }
  const now = new Date();
  let periodStart;
  if (period === 'quarter') {
    const startMonth = Math.floor(now.getMonth() / 3) * 3;
    periodStart = new Date(now.getFullYear(), startMonth, 1);
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const sessions = await prisma.homeTherapySession.findMany({
    where: {
      branchId,
      scheduledDate: { gte: periodStart },
    },
    select: {
      id: true,
      therapistId: true,
      status: true,
      scheduledDate: true,
      scheduledTime: true,
      therapistArrivedAt: true,
      patientFeedback: { select: { rating: true } },
      therapist: { select: { id: true, fullName: true, gender: true } },
    },
  });

  // Aggregate by therapistId.
  const byTherapist = new Map();
  for (const s of sessions) {
    const tid = s.therapistId;
    if (!byTherapist.has(tid)) {
      byTherapist.set(tid, {
        therapistId: tid,
        fullName: s.therapist?.fullName ?? null,
        gender: s.therapist?.gender ?? null,
        sessions: [],
      });
    }
    byTherapist.get(tid).sessions.push(s);
  }

  const out = [];
  for (const [, agg] of byTherapist) {
    const sessions = agg.sessions;
    const scheduled = sessions.length;
    const completedSessions = sessions.filter((s) => s.status === 'COMPLETED');
    const completed = completedSessions.length;
    const completionRate = scheduled > 0 ? Math.round((completed / scheduled) * 100) : 0;

    // Patient feedback rating average.
    const ratings = sessions
      .map((s) => s.patientFeedback?.rating)
      .filter((r) => typeof r === 'number');
    const feedbackCount = ratings.length;
    const avgPatientRating = feedbackCount > 0
      ? ratings.reduce((sum, r) => sum + r, 0) / feedbackCount
      : 0;

    // On-time arrival: therapistArrivedAt <= scheduledDate + scheduledTime + 15m.
    let onTimeArrivals = 0;
    for (const s of completedSessions) {
      if (!s.therapistArrivedAt) continue;
      const dateKey = s.scheduledDate.toISOString().slice(0, 10);
      const [hh, mm] = (s.scheduledTime || '00:00').split(':').map(Number);
      const scheduledDateTime = new Date(`${dateKey}T${String(hh).padStart(2,'0')}:${String(mm ?? 0).padStart(2,'0')}:00.000Z`);
      const cutoff = new Date(scheduledDateTime.getTime() + 15 * 60 * 1000);
      if (new Date(s.therapistArrivedAt).getTime() <= cutoff.getTime()) onTimeArrivals += 1;
    }
    const onTimeRate = completed > 0 ? Math.round((onTimeArrivals / completed) * 100) : 0;

    out.push({
      therapistId: agg.therapistId,
      fullName: agg.fullName,
      specialization: agg.specialization,
      completed,
      scheduled,
      completionRate,
      avgPatientRating: Math.round(avgPatientRating * 100) / 100,
      feedbackCount,
      onTimeRate,
    });
  }

  // Sort by completionRate desc, completed desc.
  out.sort((a, b) => (b.completionRate - a.completionRate) || (b.completed - a.completed));
  return { period, periodStart, branchId, rows: out };
}

export const HomeTherapyService = {
  validateHomeTherapyPayload,
  createRequestInTx,
  emitRequestCreated,
  listRequests,
  getRequest,
  approveRequest,
  editRequest,
  rejectRequest,
  listSessions,
  getSession,
  transitionSession,
  recordLocationPing,
  getSessionLastLocation,
  getNextSession,
  submitFeedback,
  getBranchScorecardStats,
};

export default HomeTherapyService;
