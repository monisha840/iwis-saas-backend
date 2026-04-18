import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { userNameSelect, flattenUserName } from '../lib/userName.js';

// Keep legacy `doctor.user.name` shape working while we fix the underlying data model.
const withLegacyUserName = (p) =>
  p ? { ...p, user: { name: p.fullName ?? null } } : null;

export class PatientPortalService {
  /**
   * Get the patient dashboard with aggregated data from multiple sources.
   */
  static async getDashboard(patientId, userId) {
    logger.info(`Fetching patient dashboard`, { patientId, userId });

    const now = new Date();

    const [
      upcomingAppointments,
      recentPrescriptions,
      activeJourneys,
      completedJourneys,
      unreadNotifications,
      patient,
      healthAvatar,
      recentDocuments,
    ] = await Promise.all([
      // Next 5 upcoming appointments
      prisma.appointment.findMany({
        where: {
          patientId,
          status: { in: ['PENDING', 'SCHEDULED', 'CONFIRMED'] },
          date: { gte: now },
        },
        include: {
          doctor: { select: { id: true, fullName: true } },
          therapist: { select: { id: true, fullName: true } },
          branch: { select: { id: true, name: true } },
        },
        orderBy: { date: 'asc' },
        take: 5,
      }),

      // Last 10 prescriptions
      prisma.prescription.findMany({
        where: { patientId },
        include: {
          doctor: { select: { id: true, fullName: true } },
          therapist: { select: { id: true, fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),

      // Active treatment journeys
      prisma.treatmentJourney.findMany({
        where: { patientId: userId, status: 'ACTIVE' },
        include: {
          phases: {
            orderBy: { order: 'asc' },
            select: { id: true, name: true, status: true, order: true },
          },
        },
      }),

      // Completed treatment journeys count
      prisma.treatmentJourney.count({
        where: { patientId: userId, status: 'COMPLETED' },
      }),

      // Unread notifications count
      prisma.notification.count({
        where: { userId, isRead: false },
      }),

      // Patient record with zen points and streak
      prisma.patient.findUnique({
        where: { id: patientId },
        select: {
          zenPoints: true,
          patientStreak: {
            select: { currentStreak: true, longestStreak: true },
          },
        },
      }),

      // Health avatar
      prisma.healthAvatar.findUnique({
        where: { patientId },
        select: {
          id: true,
          avatarType: true,
          name: true,
          level: true,
          health: true,
          happiness: true,
          xp: true,
          appearance: true,
        },
      }),

      // Recent documents
      prisma.document.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          fileName: true,
          fileType: true,
          category: true,
          createdAt: true,
        },
      }),
    ]);

    // Calculate wellness score from active journeys
    const avgWellness = activeJourneys.length > 0
      ? activeJourneys.reduce((sum, j) => sum + j.wellnessScore, 0) / activeJourneys.length
      : 0;

    // Determine zen level from points
    const zenPoints = patient?.zenPoints || 0;
    const zenLevel = Math.floor(zenPoints / 100) + 1;

    const appointmentsWithLegacy = upcomingAppointments.map((a) => ({
      ...a,
      doctor: withLegacyUserName(a.doctor),
      therapist: withLegacyUserName(a.therapist),
    }));
    const prescriptionsWithLegacy = recentPrescriptions.map((p) => ({
      ...p,
      doctor: withLegacyUserName(p.doctor),
      therapist: withLegacyUserName(p.therapist),
    }));

    return {
      upcomingAppointments: appointmentsWithLegacy,
      recentPrescriptions: prescriptionsWithLegacy,
      treatmentProgress: {
        activeJourneys: activeJourneys.length,
        completedJourneys,
        wellnessScore: Math.round(avgWellness * 10) / 10,
      },
      unreadNotifications,
      zenProfile: {
        zenPoints,
        level: zenLevel,
        streak: patient?.patientStreak?.currentStreak || 0,
      },
      avatar: healthAvatar,
      recentDocuments,
    };
  }

  /**
   * Get paginated prescription history with doctor info.
   */
  static async getMyPrescriptionHistory(patientId, { page = 1, limit = 20 } = {}) {
    const currentPage = Math.max(1, parseInt(page) || 1);
    const take = Math.min(parseInt(limit) || 20, 100);
    const skip = (currentPage - 1) * take;

    const where = { patientId };

    const [rows, total] = await Promise.all([
      prisma.prescription.findMany({
        where,
        include: {
          doctor: {
            select: {
              id: true,
              fullName: true,
              user: { select: { email: true } },
            },
          },
          therapist: {
            select: {
              id: true,
              fullName: true,
              user: { select: { email: true } },
            },
          },
          medicine: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.prescription.count({ where }),
    ]);

    const data = rows.map((r) => ({
      ...r,
      doctor: r.doctor
        ? { ...r.doctor, user: { name: r.doctor.fullName ?? null, email: r.doctor.user?.email ?? null } }
        : null,
      therapist: r.therapist
        ? { ...r.therapist, user: { name: r.therapist.fullName ?? null, email: r.therapist.user?.email ?? null } }
        : null,
    }));

    return {
      data,
      pagination: {
        page: currentPage,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  /**
   * Get visit summaries and documents for a patient.
   */
  static async getMyReports(patientId) {
    const [visitSummaries, documents] = await Promise.all([
      prisma.visitSummary.findMany({
        where: { patientId, sentToPatient: true },
        include: {
          appointment: {
            select: { date: true, consultationType: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.document.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          fileName: true,
          fileUrl: true,
          fileType: true,
          category: true,
          description: true,
          createdAt: true,
        },
      }),
    ]);

    return { visitSummaries, documents };
  }

  /**
   * Get active treatment journeys with phase progress.
   */
  static async getMyTreatmentProgress(patientId) {
    // TreatmentJourney.patientId references User.id, so we need to look up the userId
    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      select: { userId: true },
    });

    if (!patient) {
      throw new Error('Patient not found');
    }

    const journeys = await prisma.treatmentJourney.findMany({
      where: { patientId: patient.userId, status: 'ACTIVE' },
      include: {
        phases: {
          orderBy: { order: 'asc' },
          include: {
            tasks: {
              include: {
                completions: {
                  orderBy: { completedAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        },
        milestones: {
          orderBy: { targetDate: 'asc' },
        },
        doctor: { select: userNameSelect },
        branch: { select: { id: true, name: true } },
      },
    });

    return journeys.map(j => ({ ...j, doctor: flattenUserName(j.doctor) })).map(journey => {
      const totalPhases = journey.phases.length;
      const completedPhases = journey.phases.filter(p => p.status === 'COMPLETED').length;
      const activePhase = journey.phases.find(p => p.status === 'ACTIVE');

      return {
        id: journey.id,
        title: journey.title,
        condition: journey.condition,
        status: journey.status,
        startDate: journey.startDate,
        targetDate: journey.targetDate,
        wellnessScore: journey.wellnessScore,
        doctor: journey.doctor,
        branch: journey.branch,
        progress: {
          totalPhases,
          completedPhases,
          percentage: totalPhases > 0 ? Math.round((completedPhases / totalPhases) * 100) : 0,
        },
        activePhase: activePhase ? {
          id: activePhase.id,
          name: activePhase.name,
          tasks: activePhase.tasks.map(t => ({
            id: t.id,
            title: t.title,
            type: t.type,
            frequency: t.frequency,
            lastCompleted: t.completions[0]?.completedAt || null,
          })),
        } : null,
        milestones: journey.milestones,
      };
    });
  }
}
