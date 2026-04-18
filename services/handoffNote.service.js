import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';
import { notificationService } from './notification.service.js';
import { userNameSelect, flattenUserName } from '../lib/userName.js';

export class HandoffNoteService {
  /**
   * Create a handoff note and notify the receiving clinician.
   */
  static async createHandoffNote(fromClinicianId, { patientId, toClinicianId, toBranchId, summary, currentMedications, activeConditions, nextSteps, urgency }) {
    logger.info(`Creating handoff note`, { fromClinicianId, patientId, toClinicianId });

    const fromClinicianRaw = await prisma.user.findUnique({
      where: { id: fromClinicianId },
      select: userNameSelect,
    });

    if (!fromClinicianRaw) {
      throw new Error('Clinician not found');
    }

    const fromClinician = flattenUserName(fromClinicianRaw);

    const handoff = await prisma.handoffNote.create({
      data: {
        patientId,
        fromClinicianId,
        toClinicianId: toClinicianId || null,
        toBranchId: toBranchId || null,
        summary,
        currentMedications: currentMedications || null,
        activeConditions: activeConditions || [],
        nextSteps: nextSteps || null,
        urgency: urgency || 'NORMAL',
      },
      include: {
        patient: { select: { id: true, fullName: true } },
        fromClinician: { select: userNameSelect },
        toClinician: { select: userNameSelect },
        toBranch: { select: { id: true, name: true } },
      },
    });

    handoff.fromClinician = flattenUserName(handoff.fromClinician);
    handoff.toClinician = flattenUserName(handoff.toClinician);

    // Notify receiving clinician
    if (toClinicianId) {
      emitToUser(toClinicianId, 'handoff_received', handoff);

      await notificationService.createNotification({
        userId: toClinicianId,
        type: 'HANDOFF_NOTE',
        title: 'New Handoff Note Received',
        message: `${fromClinician.name} has sent you a handoff note for patient ${handoff.patient.fullName || 'Unknown'}`,
        priority: urgency === 'CRITICAL' ? 'HIGH' : 'INFO',
        data: { handoffId: handoff.id, patientId },
      });
    }

    logger.info(`Handoff note created`, { handoffId: handoff.id });
    return handoff;
  }

  /**
   * Get handoffs received by a clinician.
   */
  static async getReceivedHandoffs(clinicianId, { page = 1, limit = 20, isRead } = {}) {
    const currentPage = Math.max(1, parseInt(page) || 1);
    const take = Math.min(parseInt(limit) || 20, 100);
    const skip = (currentPage - 1) * take;

    const where = { toClinicianId: clinicianId };
    if (isRead !== undefined) {
      where.isRead = isRead === 'true' || isRead === true;
    }

    const [rows, total] = await Promise.all([
      prisma.handoffNote.findMany({
        where,
        include: {
          patient: { select: { id: true, fullName: true } },
          fromClinician: { select: userNameSelect },
          toBranch: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.handoffNote.count({ where }),
    ]);

    const data = rows.map((r) => ({ ...r, fromClinician: flattenUserName(r.fromClinician) }));

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
   * Get handoffs sent by a clinician.
   */
  static async getSentHandoffs(clinicianId, { page = 1, limit = 20 } = {}) {
    const currentPage = Math.max(1, parseInt(page) || 1);
    const take = Math.min(parseInt(limit) || 20, 100);
    const skip = (currentPage - 1) * take;

    const where = { fromClinicianId: clinicianId };

    const [rows, total] = await Promise.all([
      prisma.handoffNote.findMany({
        where,
        include: {
          patient: { select: { id: true, fullName: true } },
          toClinician: { select: userNameSelect },
          toBranch: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.handoffNote.count({ where }),
    ]);

    const data = rows.map((r) => ({ ...r, toClinician: flattenUserName(r.toClinician) }));

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
   * Get all handoffs for a patient (for admin/doctor viewing patient history).
   */
  static async getPatientHandoffs(patientId) {
    const rows = await prisma.handoffNote.findMany({
      where: { patientId },
      include: {
        fromClinician: { select: userNameSelect },
        toClinician: { select: userNameSelect },
        toBranch: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      ...r,
      fromClinician: flattenUserName(r.fromClinician),
      toClinician: flattenUserName(r.toClinician),
    }));
  }

  /**
   * Mark a handoff as read.
   */
  static async markAsRead(handoffId, userId) {
    const handoff = await prisma.handoffNote.findUnique({
      where: { id: handoffId },
    });

    if (!handoff) {
      throw new Error('Handoff note not found');
    }

    if (handoff.toClinicianId !== userId) {
      throw new Error('Not authorized to mark this handoff as read');
    }

    return prisma.handoffNote.update({
      where: { id: handoffId },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  /**
   * Auto-populate handoff note data from the latest appointment/prescription data.
   * Returns a suggested body (not saved).
   */
  static async autoPopulateFromAppointment(appointmentId, fromClinicianId) {
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: { select: { id: true, fullName: true } },
        doctor: { select: { id: true, fullName: true } },
        therapist: { select: { id: true, fullName: true } },
      },
    });

    if (!appointment) {
      throw new Error('Appointment not found');
    }

    // Get recent prescriptions for this patient
    const prescriptions = await prisma.prescription.findMany({
      where: { patientId: appointment.patientId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        medicationName: true,
        dosage: true,
        frequency: true,
        duration: true,
      },
    });

    // Get active treatment journeys
    const journeys = await prisma.treatmentJourney.findMany({
      where: {
        patientId: appointment.patient.userId || appointment.patientId,
        status: 'ACTIVE',
      },
      select: {
        condition: true,
        title: true,
      },
    });

    const currentMedications = prescriptions.map(p => ({
      name: p.medicationName,
      dosage: p.dosage,
      frequency: p.frequency,
    }));

    const activeConditions = journeys.map(j => j.condition);

    return {
      patientId: appointment.patientId,
      summary: appointment.notes || appointment.sessionNotes || '',
      currentMedications,
      activeConditions,
      nextSteps: '',
      urgency: 'NORMAL',
    };
  }
}
