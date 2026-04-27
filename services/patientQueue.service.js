/**
 * PatientQueueService — Live Patient Queue Management.
 *
 * Single source of truth for arrival / consultation state transitions.
 * Every transition writes to both QueueEntry and the mirrored fields on
 * Appointment in the same Prisma transaction so the two cannot drift,
 * then fans out a Socket.IO event to the doctor's queue room and the
 * branch's queue room simultaneously via emitToQueueRooms.
 *
 * QueueEntry rows are created lazily — the first time a doctor's queue is
 * fetched for a given day (or the first state transition for an
 * appointment, if the dashboard hasn't been opened yet). This keeps the
 * system free of cron-based morning seeders and means appointments booked
 * the same morning roll into the queue automatically.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToQueueRooms } from '../websocket/index.js';

export const ARRIVAL_STATUS = Object.freeze({
  NOT_ARRIVED: 'NOT_ARRIVED',
  ARRIVED: 'ARRIVED',
  IN_CONSULTATION: 'IN_CONSULTATION',
  COMPLETED: 'COMPLETED',
  ABSENT: 'ABSENT',
  CONTACTED: 'CONTACTED',
});

const ACTIVE_APPOINTMENT_STATUSES = ['PENDING', 'CONFIRMED', 'ACCEPTED', 'SCHEDULED', 'COMPLETED'];

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Format a JS Date as YYYY-MM-DD in the server timezone — used as the
 *  Socket.IO room date key and for QueueEntry.date filtering. */
export function dateKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class PatientQueueService {
  /**
   * Ensure QueueEntry rows exist for every appointment scheduled for the
   * given doctor + branch + day. queuePosition starts as the scheduled-time
   * order so the queue panel reads sensibly before anyone has arrived.
   * Re-running is safe — existing rows are left alone.
   */
  static async ensureEntriesForDay({ doctorId, branchId, date }) {
    if (!doctorId) return [];
    const dayStart = startOfDay(date);
    const dayEnd = endOfDay(date);

    const where = {
      doctorId,
      date: { gte: dayStart, lte: dayEnd },
      status: { in: ACTIVE_APPOINTMENT_STATUSES },
    };
    if (branchId) where.branchId = branchId;

    const appts = await prisma.appointment.findMany({
      where,
      orderBy: { date: 'asc' },
      select: { id: true, branchId: true, date: true },
    });
    if (appts.length === 0) return [];

    // Find which appointments already have entries — only seed the gaps.
    const existing = await prisma.queueEntry.findMany({
      where: { appointmentId: { in: appts.map((a) => a.id) } },
      select: { appointmentId: true },
    });
    const existingIds = new Set(existing.map((e) => e.appointmentId));
    const missing = appts.filter((a) => !existingIds.has(a.id));

    if (missing.length > 0) {
      // Determine starting queue position — keep existing positions and
      // append new ones at the end so re-seeding mid-day doesn't reshuffle.
      const max = await prisma.queueEntry.aggregate({
        where: { doctorId, date: dayStart },
        _max: { queuePosition: true },
      });
      let nextPos = (max._max.queuePosition || 0) + 1;

      // Sort missing by scheduled time so positions reflect schedule order.
      missing.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      for (const a of missing) {
        if (!a.branchId) continue; // can't queue an appointment with no branch
        await prisma.queueEntry.create({
          data: {
            appointmentId: a.id,
            doctorId,
            branchId: a.branchId,
            date: dayStart,
            queuePosition: nextPos,
            arrivalStatus: ARRIVAL_STATUS.NOT_ARRIVED,
          },
        });
        await prisma.appointment.update({
          where: { id: a.id },
          data: { queuePosition: nextPos },
        }).catch(() => null);
        nextPos += 1;
      }
    }

    return prisma.queueEntry.findMany({
      where: { doctorId, date: dayStart, ...(branchId ? { branchId } : {}) },
      orderBy: { queuePosition: 'asc' },
    });
  }

  /**
   * Read today's queue for a doctor, joined with patient + appointment
   * details ready for the dashboard. Lazily seeds missing entries.
   */
  static async getTodayQueue({ doctorId, branchId, date = new Date() }) {
    await this.ensureEntriesForDay({ doctorId, branchId, date });
    const dayStart = startOfDay(date);

    return prisma.queueEntry.findMany({
      where: {
        doctorId,
        date: dayStart,
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { queuePosition: 'asc' },
      include: {
        appointment: {
          select: {
            id: true, date: true, status: true,
            consultationType: true, consultationMode: true,
            triageSession: { select: { id: true, urgencyLevel: true, severity: true, compositeScore: true } },
            patient: {
              select: {
                id: true, fullName: true, profilePhoto: true, dob: true, gender: true,
                phoneNumber: true,
                user: { select: { id: true, email: true } },
              },
            },
          },
        },
        doctor: { select: { id: true, fullName: true, profilePhoto: true, specialization: true } },
      },
    });
  }

  /**
   * Live board snapshot — every doctor in a branch grouped, with the
   * currently-IN_CONSULTATION patient and the ARRIVED waiting list per
   * doctor. Lazily seeds missing entries for every doctor with at least
   * one appointment today in this branch.
   */
  static async getLiveBoard({ branchId, date = new Date() }) {
    if (!branchId) return { doctors: [], summary: this.emptySummary() };
    const dayStart = startOfDay(date);
    const dayEnd = endOfDay(date);

    // 1. Find every doctor with at least one appointment today in this branch
    const todayAppts = await prisma.appointment.findMany({
      where: {
        branchId,
        date: { gte: dayStart, lte: dayEnd },
        status: { in: ACTIVE_APPOINTMENT_STATUSES },
        doctorId: { not: null },
      },
      select: { doctorId: true },
    });
    const doctorIds = [...new Set(todayAppts.map((a) => a.doctorId).filter(Boolean))];

    // 2. Lazily seed each doctor's queue
    for (const did of doctorIds) {
      await this.ensureEntriesForDay({ doctorId: did, branchId, date });
    }

    // 3. Pull all queue entries for the branch+day
    const entries = await prisma.queueEntry.findMany({
      where: { branchId, date: dayStart },
      orderBy: { queuePosition: 'asc' },
      include: {
        appointment: {
          select: {
            id: true, date: true, status: true,
            consultationType: true, consultationMode: true,
            patient: {
              select: {
                id: true, fullName: true, profilePhoto: true, phoneNumber: true,
                user: { select: { id: true, email: true } },
              },
            },
          },
        },
        doctor: { select: { id: true, fullName: true, profilePhoto: true, specialization: true } },
      },
    });

    // 4. Group by doctor
    const byDoctor = new Map();
    for (const e of entries) {
      if (!byDoctor.has(e.doctorId)) {
        byDoctor.set(e.doctorId, { doctor: e.doctor, entries: [] });
      }
      byDoctor.get(e.doctorId).entries.push(e);
    }

    return {
      doctors: [...byDoctor.values()],
      summary: this.buildSummary(entries),
    };
  }

  static emptySummary() {
    return {
      scheduled: 0, arrived: 0, inConsultation: 0,
      completed: 0, absent: 0, contacted: 0, waiting: 0,
    };
  }

  static buildSummary(entries) {
    const s = this.emptySummary();
    s.scheduled = entries.length;
    for (const e of entries) {
      switch (e.arrivalStatus) {
        case ARRIVAL_STATUS.ARRIVED: s.arrived += 1; s.waiting += 1; break;
        case ARRIVAL_STATUS.IN_CONSULTATION: s.inConsultation += 1; break;
        case ARRIVAL_STATUS.COMPLETED: s.completed += 1; break;
        case ARRIVAL_STATUS.ABSENT: s.absent += 1; break;
        case ARRIVAL_STATUS.CONTACTED: s.contacted += 1; break;
        default: break;
      }
    }
    return s;
  }

  /**
   * Re-rank queue positions for actively-waiting patients so the visible
   * waiting list always reads 1, 2, 3… ARRIVED patients keep their order
   * by arrivedAt; NOT_ARRIVED patients fall back to scheduled-time order.
   * ABSENT / CONTACTED / COMPLETED / IN_CONSULTATION entries are pushed
   * to the end without re-numbering against the waiting list.
   *
   * Runs inside the caller's transaction when one is provided.
   */
  static async rerankPositions({ doctorId, date, tx = prisma }) {
    const dayStart = startOfDay(date);
    const all = await tx.queueEntry.findMany({
      where: { doctorId, date: dayStart },
      orderBy: { queuePosition: 'asc' },
      include: { appointment: { select: { date: true } } },
    });

    const active = all.filter((e) =>
      e.arrivalStatus === ARRIVAL_STATUS.NOT_ARRIVED || e.arrivalStatus === ARRIVAL_STATUS.ARRIVED,
    );
    const inactive = all.filter((e) =>
      e.arrivalStatus !== ARRIVAL_STATUS.NOT_ARRIVED && e.arrivalStatus !== ARRIVAL_STATUS.ARRIVED,
    );

    active.sort((a, b) => {
      // ARRIVED ranks ahead of NOT_ARRIVED so the waiting list shows
      // already-present patients first.
      if (a.arrivalStatus !== b.arrivalStatus) {
        return a.arrivalStatus === ARRIVAL_STATUS.ARRIVED ? -1 : 1;
      }
      if (a.arrivalStatus === ARRIVAL_STATUS.ARRIVED) {
        return new Date(a.arrivedAt || 0).getTime() - new Date(b.arrivedAt || 0).getTime();
      }
      return new Date(a.appointment.date).getTime() - new Date(b.appointment.date).getTime();
    });

    let pos = 1;
    for (const e of active) {
      if (e.queuePosition !== pos) {
        await tx.queueEntry.update({ where: { id: e.id }, data: { queuePosition: pos } });
        await tx.appointment.update({ where: { id: e.appointmentId }, data: { queuePosition: pos } }).catch(() => null);
      }
      pos += 1;
    }
    for (const e of inactive) {
      if (e.queuePosition !== pos) {
        await tx.queueEntry.update({ where: { id: e.id }, data: { queuePosition: pos } });
        await tx.appointment.update({ where: { id: e.appointmentId }, data: { queuePosition: pos } }).catch(() => null);
      }
      pos += 1;
    }
  }

  // ── State transitions ───────────────────────────────────────────────────

  /** Lazily fetch (or create) the QueueEntry for a single appointment. */
  static async ensureEntryForAppointment(appointmentId) {
    const existing = await prisma.queueEntry.findUnique({
      where: { appointmentId },
      include: { appointment: { select: { branchId: true, doctorId: true, date: true } } },
    });
    if (existing) return existing;

    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { id: true, branchId: true, doctorId: true, date: true },
    });
    if (!appt) throw Object.assign(new Error('Appointment not found'), { status: 404 });
    if (!appt.doctorId) throw Object.assign(new Error('Appointment has no doctor'), { status: 400 });
    if (!appt.branchId) throw Object.assign(new Error('Appointment has no branch'), { status: 400 });

    const dayStart = startOfDay(appt.date);
    const max = await prisma.queueEntry.aggregate({
      where: { doctorId: appt.doctorId, date: dayStart },
      _max: { queuePosition: true },
    });
    return prisma.queueEntry.create({
      data: {
        appointmentId: appt.id,
        doctorId: appt.doctorId,
        branchId: appt.branchId,
        date: dayStart,
        queuePosition: (max._max.queuePosition || 0) + 1,
        arrivalStatus: ARRIVAL_STATUS.NOT_ARRIVED,
      },
      include: { appointment: { select: { branchId: true, doctorId: true, date: true } } },
    });
  }

  static async markArrived(appointmentId, { actorUserId } = {}) {
    const entry = await this.ensureEntryForAppointment(appointmentId);
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.queueEntry.update({
        where: { id: entry.id },
        data: {
          arrivalStatus: ARRIVAL_STATUS.ARRIVED,
          arrivedAt: entry.arrivedAt ?? now,
        },
      });
      await tx.appointment.update({
        where: { id: appointmentId },
        data: { arrivalStatus: ARRIVAL_STATUS.ARRIVED, arrivedAt: entry.arrivedAt ?? now },
      });
      await this.rerankPositions({ doctorId: entry.doctorId, date: entry.date, tx });
      return updated;
    });

    logger.info('[Queue] arrived', { appointmentId, by: actorUserId });
    emitToQueueRooms({
      doctorId: entry.doctorId,
      branchId: entry.branchId,
      date: entry.date,
      event: 'patient_arrived',
      data: { appointmentId, doctorId: entry.doctorId, branchId: entry.branchId, arrivalStatus: ARRIVAL_STATUS.ARRIVED },
    });
    return result;
  }

  static async startConsultation(appointmentId, { actorUserId } = {}) {
    const entry = await this.ensureEntryForAppointment(appointmentId);
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.queueEntry.update({
        where: { id: entry.id },
        data: {
          arrivalStatus: ARRIVAL_STATUS.IN_CONSULTATION,
          consultationStartedAt: entry.consultationStartedAt ?? now,
          // If the doctor starts the consultation without explicit arrival,
          // backfill arrivedAt so elapsed-wait reads sensibly.
          arrivedAt: entry.arrivedAt ?? now,
        },
      });
      await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          arrivalStatus: ARRIVAL_STATUS.IN_CONSULTATION,
          consultationStartedAt: entry.consultationStartedAt ?? now,
          arrivedAt: entry.arrivedAt ?? now,
        },
      });
      await this.rerankPositions({ doctorId: entry.doctorId, date: entry.date, tx });
      return updated;
    });

    logger.info('[Queue] consultation_started', { appointmentId, by: actorUserId });
    emitToQueueRooms({
      doctorId: entry.doctorId,
      branchId: entry.branchId,
      date: entry.date,
      event: 'consultation_started',
      data: { appointmentId, doctorId: entry.doctorId, branchId: entry.branchId, arrivalStatus: ARRIVAL_STATUS.IN_CONSULTATION },
    });
    return result;
  }

  static async endConsultation(appointmentId, { actorUserId } = {}) {
    const entry = await this.ensureEntryForAppointment(appointmentId);
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.queueEntry.update({
        where: { id: entry.id },
        data: {
          arrivalStatus: ARRIVAL_STATUS.COMPLETED,
          consultationEndedAt: now,
        },
      });
      await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          arrivalStatus: ARRIVAL_STATUS.COMPLETED,
          consultationEndedAt: now,
        },
      });
      await this.rerankPositions({ doctorId: entry.doctorId, date: entry.date, tx });
      return updated;
    });

    logger.info('[Queue] consultation_ended', { appointmentId, by: actorUserId });
    emitToQueueRooms({
      doctorId: entry.doctorId,
      branchId: entry.branchId,
      date: entry.date,
      event: 'consultation_ended',
      data: { appointmentId, doctorId: entry.doctorId, branchId: entry.branchId, arrivalStatus: ARRIVAL_STATUS.COMPLETED },
    });
    return result;
  }

  static async markAbsent(appointmentId, { actorUserId } = {}) {
    const entry = await this.ensureEntryForAppointment(appointmentId);

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.queueEntry.update({
        where: { id: entry.id },
        data: { arrivalStatus: ARRIVAL_STATUS.ABSENT },
      });
      await tx.appointment.update({
        where: { id: appointmentId },
        data: { arrivalStatus: ARRIVAL_STATUS.ABSENT },
      });
      await this.rerankPositions({ doctorId: entry.doctorId, date: entry.date, tx });
      return updated;
    });

    logger.info('[Queue] patient_absent', { appointmentId, by: actorUserId });
    emitToQueueRooms({
      doctorId: entry.doctorId,
      branchId: entry.branchId,
      date: entry.date,
      event: 'patient_absent',
      data: { appointmentId, doctorId: entry.doctorId, branchId: entry.branchId, arrivalStatus: ARRIVAL_STATUS.ABSENT },
    });
    return result;
  }

  static async contactAbsent(appointmentId, { actorUserId, contactNote }) {
    const entry = await this.ensureEntryForAppointment(appointmentId);
    const now = new Date();
    const note = (typeof contactNote === 'string' ? contactNote.trim() : '').slice(0, 500);
    if (!note) {
      throw Object.assign(new Error('contactNote is required'), { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.queueEntry.update({
        where: { id: entry.id },
        data: {
          arrivalStatus: ARRIVAL_STATUS.CONTACTED,
          absentContactedAt: now,
          contactNote: note,
          contactedById: actorUserId || null,
        },
      });
      await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          arrivalStatus: ARRIVAL_STATUS.CONTACTED,
          absentContactedAt: now,
        },
      });

      try {
        await tx.auditLog.create({
          data: {
            userId: actorUserId,
            action: 'QUEUE_ABSENT_CONTACTED',
            entityType: 'Appointment',
            entityId: appointmentId,
            newData: { contactNote: note, queueEntryId: updated.id },
          },
        });
      } catch (err) {
        logger.warn('[Queue] audit insert failed', { err: err.message });
      }

      await this.rerankPositions({ doctorId: entry.doctorId, date: entry.date, tx });
      return updated;
    });

    logger.info('[Queue] patient_contacted', { appointmentId, by: actorUserId });
    emitToQueueRooms({
      doctorId: entry.doctorId,
      branchId: entry.branchId,
      date: entry.date,
      event: 'patient_contacted',
      data: { appointmentId, doctorId: entry.doctorId, branchId: entry.branchId, arrivalStatus: ARRIVAL_STATUS.CONTACTED, contactNote: note },
    });
    return result;
  }

  // ── Branch-scoping helper for the route layer ───────────────────────────

  /**
   * Returns true if `user` (req.user shape with role + branchId +
   * doctorProfileId) may access the queue of `doctorId` in `branchId`.
   * - SUPER_ADMIN / ADMIN: unrestricted
   * - ADMIN_DOCTOR: branch-scoped via their User.branchId (if set) — when
   *   no branchId is set on the user, treat as cross-branch admin
   * - BRANCH_ADMIN: only their own branch
   * - DOCTOR / THERAPIST: only their own queue (doctorId match)
   */
  static canAccessQueue(user, { doctorId, branchId }) {
    if (!user || !user.role) return false;
    if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') return true;
    if (user.role === 'ADMIN_DOCTOR') {
      if (user.branchId && branchId && user.branchId !== branchId) {
        return doctorId && user.doctorProfileId === doctorId;
      }
      return true;
    }
    if (user.role === 'BRANCH_ADMIN') {
      if (!user.branchId) return false;
      return !branchId || user.branchId === branchId;
    }
    if (user.role === 'DOCTOR') {
      return !!doctorId && user.doctorProfileId === doctorId;
    }
    return false;
  }
}

export default PatientQueueService;
