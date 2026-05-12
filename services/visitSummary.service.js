import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';
import { notificationService } from './notification.service.js';

export class VisitSummaryService {
  /**
   * Create a visit summary for an appointment.
   */
  static async createVisitSummary(appointmentId, clinicianId, { diagnosis, treatmentNotes, prescriptions, exercisePlan, dietaryAdvice, nextSteps, followUpDate }) {
    logger.info(`Creating visit summary`, { appointmentId, clinicianId });

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: { select: { id: true, userId: true, fullName: true } },
        doctor: { select: { id: true, userId: true, fullName: true } },
        therapist: { select: { id: true, userId: true, fullName: true } },
      },
    });

    if (!appointment) {
      throw new Error('Appointment not found');
    }

    // Validate clinician belongs to this appointment
    const isDoctorOnAppointment = appointment.doctor?.userId === clinicianId;
    const isTherapistOnAppointment = appointment.therapist?.userId === clinicianId;

    if (!isDoctorOnAppointment && !isTherapistOnAppointment) {
      throw new Error('Clinician is not assigned to this appointment');
    }

    // Resolve clinician name
    const clinicianName = isDoctorOnAppointment
      ? appointment.doctor.fullName
      : appointment.therapist.fullName;

    const summary = await prisma.visitSummary.create({
      data: {
        appointmentId,
        patientId: appointment.patientId,
        clinicianId,
        clinicianName: clinicianName || 'Unknown',
        diagnosis: diagnosis || null,
        treatmentNotes: treatmentNotes || null,
        prescriptions: prescriptions || null,
        exercisePlan: exercisePlan || null,
        dietaryAdvice: dietaryAdvice || null,
        nextSteps: nextSteps || null,
        followUpDate: followUpDate ? new Date(followUpDate) : null,
      },
      include: {
        appointment: { select: { date: true, consultationType: true } },
        patient: { select: { id: true, fullName: true } },
      },
    });

    logger.info(`Visit summary created`, { summaryId: summary.id });
    return summary;
  }

  /**
   * Get visit summary by appointment ID.
   */
  static async getVisitSummary(appointmentId) {
    const summary = await prisma.visitSummary.findUnique({
      where: { appointmentId },
      include: {
        appointment: {
          select: { date: true, consultationType: true, consultationMode: true, notes: true },
        },
        patient: { select: { id: true, fullName: true } },
      },
    });

    if (!summary) {
      throw new Error('Visit summary not found');
    }

    return summary;
  }

  /**
   * Get paginated visit summaries for a patient.
   */
  static async getPatientVisitSummaries(patientId, { page = 1, limit = 20 } = {}) {
    const currentPage = Math.max(1, parseInt(page) || 1);
    const take = Math.min(parseInt(limit) || 20, 100);
    const skip = (currentPage - 1) * take;

    const where = { patientId };

    const [data, total] = await Promise.all([
      prisma.visitSummary.findMany({
        where,
        include: {
          appointment: { select: { id: true, date: true, consultationType: true } },
          patient: { select: { id: true, fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.visitSummary.count({ where }),
    ]);

    // Enrich each row with the authoring clinician's profile so the patient
    // card can show name, specialisation, and photo without an extra
    // round-trip. clinicianId → User.id, the related Doctor record carries
    // the rest. Therapists fall back to fullName + profilePhoto only.
    const clinicianIds = Array.from(new Set(data.map((s) => s.clinicianId).filter(Boolean)));
    const clinicians = clinicianIds.length
      ? await prisma.user.findMany({
          where: { id: { in: clinicianIds } },
          select: {
            id: true,
            doctor: {
              select: {
                id: true,
                fullName: true,
                profilePhoto: true,
                specialization: true,
                qualification: true,
              },
            },
            therapist: {
              // Therapist has no `specialization` column (see schema
              // comment on the Therapist model) — selecting it makes
              // Prisma throw "Unknown field `specialization`". The UI
              // tolerates a missing field on therapist-authored rows.
              select: {
                id: true,
                fullName: true,
                profilePhoto: true,
                qualification: true,
              },
            },
          },
        })
      : [];
    const clinicianMap = new Map(
      clinicians.map((c) => [c.id, c.doctor || c.therapist || null]),
    );

    // Surface the patient's full name on the row itself so the UI can
    // render "Patient: Jane Doe" without a second lookup.
    const summaries = data.map((s) => ({
      ...s,
      patientName: s.patient?.fullName ?? null,
      doctor: clinicianMap.get(s.clinicianId) ?? null,
    }));

    return {
      // Two shapes are intentional: legacy callers consume `summaries`,
      // newer callers consume the paginated `data` envelope.
      summaries,
      data: summaries,
      pagination: {
        page: currentPage,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  /**
   * List visit summaries authored by a given clinician (most recent first).
   * Used by the doctor-side Visit Summary page so the table reflects the
   * current user's drafts/sent records, not just one patient's history.
   */
  static async listClinicianVisitSummaries(clinicianId, { page = 1, limit = 50, startDate, endDate, branchId } = {}) {
    const currentPage = Math.max(1, parseInt(page) || 1);
    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = (currentPage - 1) * take;

    // clinicianId === null is allowed for admin views (ADMIN_DOCTOR oversees
    // every consultation in their branch); the controller passes branchId
    // alongside in that case to keep the result scoped.
    const where = {};
    if (clinicianId) where.clinicianId = clinicianId;
    if (branchId) where.appointment = { branchId };

    // Optional createdAt range — used by the doctor-side patient-card view
    // to filter visit summaries by Today / Week / Month windows.
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [rows, total] = await Promise.all([
      prisma.visitSummary.findMany({
        where,
        include: {
          appointment: { select: { id: true, date: true, consultationType: true, branchId: true } },
          patient: {
            select: {
              id: true,
              fullName: true,
              branchId: true,
              profilePhoto: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.visitSummary.count({ where }),
    ]);

    // Enrich with the authoring clinician (doctor / therapist) so the
    // admin-doctor patient-card view can show who saw each patient.
    const clinicianIds = Array.from(new Set(rows.map((s) => s.clinicianId).filter(Boolean)));
    const clinicians = clinicianIds.length
      ? await prisma.user.findMany({
          where: { id: { in: clinicianIds } },
          select: {
            id: true,
            doctor: {
              select: { id: true, fullName: true, profilePhoto: true, specialization: true, qualification: true },
            },
            therapist: {
              // Therapist model has no `specialization` field — select
              // only fields that actually exist on the schema, otherwise
              // Prisma throws "Unknown field `specialization`".
              select: { id: true, fullName: true, profilePhoto: true, qualification: true },
            },
          },
        })
      : [];
    const clinicianMap = new Map(
      clinicians.map((c) => [c.id, c.doctor || c.therapist || null]),
    );

    const summaries = rows.map((s) => ({
      ...s,
      patientName: s.patient?.fullName ?? null,
      doctor: clinicianMap.get(s.clinicianId) ?? null,
    }));

    return {
      summaries,
      data: summaries,
      pagination: {
        page: currentPage,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  /**
   * Send visit summary to patient — marks as sent, creates notification, emits socket event.
   */
  static async sendToPatient(summaryId) {
    const summary = await prisma.visitSummary.findUnique({
      where: { id: summaryId },
      include: {
        patient: { select: { id: true, userId: true, fullName: true } },
        appointment: { select: { date: true } },
      },
    });

    if (!summary) {
      throw new Error('Visit summary not found');
    }

    const updated = await prisma.visitSummary.update({
      where: { id: summaryId },
      data: {
        sentToPatient: true,
        sentAt: new Date(),
      },
    });

    // Notify the patient
    const patientUserId = summary.patient.userId;

    emitToUser(patientUserId, 'visit_summary', {
      summaryId: summary.id,
      clinicianName: summary.clinicianName,
      diagnosis: summary.diagnosis,
      appointmentDate: summary.appointment.date,
    });

    await notificationService.createNotification({
      userId: patientUserId,
      type: 'VISIT_SUMMARY',
      title: 'Visit Summary Available',
      message: `Your visit summary from ${summary.clinicianName} is now available.`,
      priority: 'INFO',
      data: { summaryId: summary.id, appointmentId: summary.appointmentId },
    });

    logger.info(`Visit summary sent to patient`, { summaryId, patientId: summary.patientId });
    return updated;
  }

  /**
   * Auto-generate a draft visit summary from appointment data (not saved).
   */
  static async autoGenerate(appointmentId) {
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: { select: { id: true, userId: true, fullName: true } },
        doctor: { select: { id: true, fullName: true } },
        therapist: { select: { id: true, fullName: true } },
        // Triage data lets the doctor's auto-populate seed a diagnosis hint
        // (suggested specialty / triage notes) when consultation notes are
        // empty — matches the admin-doctor "auto populate" spec.
        triageSession: {
          select: {
            triageNotes: true,
            suggestedSpecialty: true,
            severity: true,
            urgencyLevel: true,
          },
        },
      },
    });

    if (!appointment) {
      throw new Error('Appointment not found');
    }

    // Prefer prescriptions explicitly linked to this appointment; fall back
    // to a same-day window for legacy rows written before the link existed.
    const appointmentDate = new Date(appointment.date);
    const dayStart = new Date(appointmentDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(appointmentDate);
    dayEnd.setHours(23, 59, 59, 999);

    const [prescriptions, videoPrescriptions] = await Promise.all([
      prisma.prescription.findMany({
        where: {
          patientId: appointment.patientId,
          OR: [
            { appointmentId },
            { appointmentId: null, createdAt: { gte: dayStart, lte: dayEnd } },
          ],
        },
        select: {
          medicationName: true,
          dosage: true,
          frequency: true,
          duration: true,
          notes: true,
        },
      }),
      prisma.videoPrescription.findMany({
        where: {
          patientId: appointment.patientId,
          createdAt: { gte: dayStart, lte: dayEnd },
        },
        include: {
          video: { select: { title: true, description: true } },
        },
      }),
    ]);

    const prescriptionData = prescriptions.map(p => ({
      medication: p.medicationName,
      dosage: p.dosage,
      frequency: p.frequency,
      duration: p.duration,
    }));

    const exercisePlan = videoPrescriptions.map(vp => ({
      exercise: vp.video.title,
      description: vp.video.description,
      notes: vp.notes,
    }));

    // Diagnosis seed — fall back to triage suggestion / notes when the
    // doctor hasn't recorded a chief complaint yet, so the auto-populate
    // never lands the doctor on an empty form.
    const triage = appointment.triageSession;
    const diagnosis = triage?.triageNotes
      || (triage?.suggestedSpecialty ? `Triage suggestion: ${triage.suggestedSpecialty}` : null);

    return {
      appointmentId,
      patientId: appointment.patientId,
      patientName: appointment.patient?.fullName || null,
      clinicianName: appointment.doctor?.fullName || appointment.therapist?.fullName || 'Unknown',
      appointmentDate: appointment.date,
      diagnosis,
      treatmentNotes: appointment.notes || appointment.sessionNotes || null,
      prescriptions: prescriptionData.length > 0 ? prescriptionData : null,
      exercisePlan: exercisePlan.length > 0 ? exercisePlan : null,
      dietaryAdvice: null,
      nextSteps: null,
      followUpDate: null,
    };
  }
}
