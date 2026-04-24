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
          appointment: { select: { date: true, consultationType: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.visitSummary.count({ where }),
    ]);

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

    return {
      appointmentId,
      patientId: appointment.patientId,
      clinicianName: appointment.doctor?.fullName || appointment.therapist?.fullName || 'Unknown',
      diagnosis: null,
      treatmentNotes: appointment.notes || appointment.sessionNotes || null,
      prescriptions: prescriptionData.length > 0 ? prescriptionData : null,
      exercisePlan: exercisePlan.length > 0 ? exercisePlan : null,
      dietaryAdvice: null,
      nextSteps: null,
      followUpDate: null,
    };
  }
}
