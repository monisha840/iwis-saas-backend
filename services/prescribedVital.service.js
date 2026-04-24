/**
 * PrescribedVitalService — doctor prescribes which vitals a patient must
 * track on their dashboard. Drives the dashboard's vitals tiles instead of
 * a hardcoded list.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

const VALID_FREQUENCIES = ['DAILY', 'TWICE_DAILY', 'WEEKLY', 'AS_NEEDED'];

export class PrescribedVitalService {
  static async list(patientId) {
    const rows = await prisma.prescribedVital.findMany({
      where: { patientId, active: true },
      orderBy: { createdAt: 'asc' },
      include: {
        prescribedBy: {
          select: {
            id: true, email: true,
            doctor: { select: { fullName: true } },
            therapist: { select: { fullName: true } },
          },
        },
      },
    });
    // Flatten to a `name` field the frontend expects.
    return rows.map((r) => ({
      ...r,
      prescribedBy: r.prescribedBy
        ? {
            id: r.prescribedBy.id,
            email: r.prescribedBy.email,
            name:
              r.prescribedBy.doctor?.fullName ||
              r.prescribedBy.therapist?.fullName ||
              r.prescribedBy.email,
          }
        : null,
    }));
  }

  static async create(patientId, prescribedById, body) {
    const { vitalType, frequency = 'DAILY', notes } = body || {};
    if (!vitalType) {
      throw Object.assign(new Error('vitalType required'), { status: 400 });
    }
    if (!VALID_FREQUENCIES.includes(frequency)) {
      throw Object.assign(new Error(`frequency must be one of ${VALID_FREQUENCIES.join(', ')}`), { status: 400 });
    }

    // Upsert — re-prescribing an existing (and possibly inactive) entry just
    // re-activates it and updates the metadata.
    const result = await prisma.prescribedVital.upsert({
      where: { patientId_vitalType: { patientId, vitalType } },
      create: { patientId, vitalType, frequency, notes: notes || null, prescribedById, active: true },
      update: { frequency, notes: notes || null, active: true, prescribedById },
    });

    logger.info('[PrescribedVital] prescribed', { patientId, vitalType, by: prescribedById });
    return result;
  }

  static async remove(patientId, id) {
    const row = await prisma.prescribedVital.findUnique({ where: { id } });
    if (!row || row.patientId !== patientId) {
      throw Object.assign(new Error('Prescribed vital not found'), { status: 404 });
    }
    await prisma.prescribedVital.update({
      where: { id },
      data: { active: false },
    });
    return { removed: true };
  }
}

export default PrescribedVitalService;
