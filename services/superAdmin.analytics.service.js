/**
 * SUPER_ADMIN analytics — aggregate-only (spec §4.4, §6.3).
 * Any query in this file must NOT join through to Patient, Prescription,
 * TriageSession, Message, DailyCheckIn — aggregate counts only.
 */
import prisma from '../lib/prisma.js';

const MAU_WINDOW_DAYS = 30;

export class SuperAdminAnalyticsService {
  static async platformOverview() {
    const since = new Date(Date.now() - MAU_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [hospitals, hospitalsByStatus, hospitalsByPlan, branches, branchesActive, users, patients, mau, appointments] = await Promise.all([
      prisma.hospital.count(),
      prisma.hospital.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.hospital.groupBy({ by: ['plan'], _count: { _all: true } }),
      prisma.branch.count(),
      prisma.branch.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: { not: 'PATIENT' } } }),
      prisma.user.count({ where: { role: 'PATIENT' } }),
      // MAU proxy: users with a refresh token issued in the last 30 days
      prisma.refreshToken.findMany({
        where: { createdAt: { gte: since } },
        select: { userId: true },
        distinct: ['userId'],
      }).then((rows) => rows.length),
      prisma.appointment.count({ where: { createdAt: { gte: since } } }),
    ]);

    return {
      totals: {
        hospitals,
        branches,
        branchesActive,
        staffUsers: users,
        patients,
        monthlyActiveUsers: mau,
        appointmentsLast30d: appointments,
      },
      hospitalsByStatus: Object.fromEntries(hospitalsByStatus.map((r) => [r.status, r._count._all])),
      hospitalsByPlan: Object.fromEntries(hospitalsByPlan.map((r) => [r.plan, r._count._all])),
    };
  }

  static async hospitalUsage(hospitalId) {
    const hospital = await prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { id: true, name: true, slug: true, plan: true, status: true, createdAt: true },
    });
    if (!hospital) {
      const e = new Error('Hospital not found');
      e.status = 404;
      throw e;
    }
    const since = new Date(Date.now() - MAU_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [branches, staffUsers, patients, appointments30d, prescriptions30d] = await Promise.all([
      prisma.branch.count({ where: { hospitalId } }),
      prisma.user.count({ where: { hospitalId, role: { not: 'PATIENT' } } }),
      prisma.user.count({ where: { hospitalId, role: 'PATIENT' } }),
      prisma.appointment.count({
        where: { createdAt: { gte: since }, branch: { hospitalId } },
      }),
      prisma.prescription.count({
        where: { createdAt: { gte: since }, branch: { hospitalId } },
      }),
    ]);

    return {
      hospital,
      totals: {
        branches,
        staffUsers,
        patients,
        appointmentsLast30d: appointments30d,
        prescriptionsLast30d: prescriptions30d,
      },
    };
  }
}
