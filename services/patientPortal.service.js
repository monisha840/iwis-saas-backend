import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { userNameSelect, flattenUserName } from '../lib/userName.js';

// Keep legacy `doctor.user.name` shape working while we fix the underlying data model.
const withLegacyUserName = (p) =>
  p ? { ...p, user: { name: p.fullName ?? null } } : null;

export class PatientPortalService {
  // getDashboard() removed — superseded by EnhancedDashboardService.getSummary
  // (`/api/patient/dashboard/summary`). Patient Portal now serves the records
  // archive only: appointments / prescriptions / documents / visit summaries.

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
   * Both lists are paginated independently (same page/limit applied to each).
   */
  static async getMyReports(patientId, { page = 1, limit = 20 } = {}) {
    const currentPage = Math.max(1, parseInt(page) || 1);
    const take = Math.min(parseInt(limit) || 20, 100);
    const skip = (currentPage - 1) * take;

    const [vsRows, vsTotal, docRows, docTotal] = await Promise.all([
      prisma.visitSummary.findMany({
        where: { patientId, sentToPatient: true },
        include: {
          appointment: {
            select: { id: true, date: true, consultationType: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.visitSummary.count({ where: { patientId, sentToPatient: true } }),
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
        skip,
        take,
      }),
      prisma.document.count({ where: { patientId } }),
    ]);

    const buildPagination = (total) => ({
      page: currentPage,
      limit: take,
      total,
      totalPages: Math.ceil(total / take),
    });

    return {
      visitSummaries: { data: vsRows, pagination: buildPagination(vsTotal) },
      documents: { data: docRows, pagination: buildPagination(docTotal) },
    };
  }

  /**
   * Paginated full appointment history for the patient. Optional `status`
   * filter accepts a single status string (e.g. COMPLETED) or one of the
   * synthetic groups: "UPCOMING" (PENDING/SCHEDULED/CONFIRMED) or "PAST"
   * (COMPLETED/NO_SHOW/CANCELLED).
   */
  static async getMyAppointmentHistory(patientId, { page = 1, limit = 20, status } = {}) {
    const currentPage = Math.max(1, parseInt(page) || 1);
    const take = Math.min(parseInt(limit) || 20, 100);
    const skip = (currentPage - 1) * take;

    const where = { patientId };
    if (status) {
      const upper = String(status).toUpperCase();
      if (upper === 'UPCOMING') {
        where.status = { in: ['PENDING', 'SCHEDULED', 'CONFIRMED'] };
      } else if (upper === 'PAST') {
        where.status = { in: ['COMPLETED', 'NO_SHOW', 'CANCELLED'] };
      } else if (upper !== 'ALL') {
        where.status = upper;
      }
    }

    const [rows, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        include: {
          doctor: { select: { id: true, fullName: true } },
          therapist: { select: { id: true, fullName: true } },
          branch: { select: { id: true, name: true } },
          visitSummary: { select: { id: true, sentToPatient: true } },
        },
        orderBy: { date: 'desc' },
        skip,
        take,
      }),
      prisma.appointment.count({ where }),
    ]);

    const data = rows.map((a) => ({
      ...a,
      doctor: withLegacyUserName(a.doctor),
      therapist: withLegacyUserName(a.therapist),
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
