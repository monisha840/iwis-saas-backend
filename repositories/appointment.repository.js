/**
 * AppointmentRepository — all DB access for the Appointment model.
 *
 * Services call repository methods; they never call prisma.appointment directly.
 * This keeps the data-access layer swappable and testable.
 */

import prisma from '../lib/prisma.js';
import { BaseRepository } from './base.repository.js';

const APPOINTMENT_INCLUDE = {
  doctor: { include: { user: { select: { email: true } } } },
  therapist: { include: { user: { select: { email: true } } } },
  patient: { include: { user: { select: { email: true } } } },
  triageSession: true,
  branch: { select: { id: true, name: true, address: true } },
};

export class AppointmentRepository extends BaseRepository {
  get model() {
    return prisma.appointment;
  }

  /** Full appointment with all relations */
  async findByIdWithDetails(id) {
    return prisma.appointment.findUnique({
      where: { id },
      include: {
        ...APPOINTMENT_INCLUDE,
        branch: true,
      },
    });
  }

  /**
   * Paginated list with role-based filtering.
   *
   * @param {object} where  - Pre-built Prisma where clause
   * @param {object} opts   - { page, limit }
   */
  async listWithDetails(where, { page = 1, limit = 20 } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (safePage - 1) * safeLimit;

    const [appointments, total] = await prisma.$transaction([
      prisma.appointment.findMany({
        where,
        include: APPOINTMENT_INCLUDE,
        orderBy: { date: 'desc' },
        skip,
        take: safeLimit,
      }),
      prisma.appointment.count({ where }),
    ]);

    return {
      appointments,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /** Get appointments for a specific date range — used by availability checks */
  async findForDateRange(clinicianId, clinicianField, startDate, endDate) {
    return prisma.appointment.findMany({
      where: {
        [clinicianField]: clinicianId,
        date: { gte: startDate, lt: endDate },
        status: { notIn: ['CANCELLED'] },
      },
      select: { id: true, date: true, status: true },
    });
  }

  /** Mark notification as sent (idempotency) */
  async markNotificationSent(id) {
    return prisma.appointment.update({
      where: { id },
      data: { notificationSent: true },
    });
  }

  /** Status counts for reporting */
  async getStatusCounts(where = {}) {
    return prisma.appointment.groupBy({
      by: ['status'],
      where,
      _count: { status: true },
    });
  }

  /** Completed appointment count for gamification */
  async countCompleted({ clinicianId, clinicianField, since }) {
    return prisma.appointment.count({
      where: {
        [clinicianField]: clinicianId,
        status: 'COMPLETED',
        date: { gte: since },
      },
    });
  }
}

export const appointmentRepository = new AppointmentRepository();
