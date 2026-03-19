/**
 * UserRepository — DB access for User, Doctor, Therapist, Patient, Pharmacist profiles.
 */

import prisma from '../lib/prisma.js';
import { BaseRepository } from './base.repository.js';

export class UserRepository extends BaseRepository {
  get model() {
    return prisma.user;
  }

  async findByEmail(email) {
    return prisma.user.findUnique({
      where: { email },
      include: {
        doctor: true,
        therapist: true,
        patient: true,
        pharmacist: true,
        branch: true,
      },
    });
  }

  async findByIdWithProfile(userId) {
    return prisma.user.findUnique({
      where: { id: userId },
      include: {
        doctor: true,
        therapist: true,
        patient: true,
        pharmacist: true,
        branch: { select: { id: true, name: true } },
      },
    });
  }

  async findAllWithProfiles({ where = {}, page = 1, limit = 20 } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (safePage - 1) * safeLimit;

    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        include: {
          doctor: { select: { id: true, fullName: true, specialization: true } },
          therapist: { select: { id: true, fullName: true, specialization: true } },
          patient: { select: { id: true, fullName: true, patientId: true } },
          pharmacist: { select: { id: true, fullName: true } },
          branch: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      prisma.user.count({ where }),
    ]);

    return { users, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
  }

  /** Doctor-specific queries */
  async findDoctorByUserId(userId) {
    return prisma.doctor.findUnique({ where: { userId }, include: { user: true } });
  }

  async findDoctorById(doctorId) {
    return prisma.doctor.findUnique({ where: { id: doctorId }, include: { user: true } });
  }

  /** Therapist-specific queries */
  async findTherapistByUserId(userId) {
    return prisma.therapist.findUnique({ where: { userId }, include: { user: true } });
  }

  /** Patient-specific queries */
  async findPatientByUserId(userId) {
    return prisma.patient.findUnique({ where: { userId } });
  }

  async findPatientById(patientId) {
    return prisma.patient.findUnique({
      where: { id: patientId },
      include: { user: { select: { email: true, role: true } }, branch: true },
    });
  }

  /** Soft-delete a user */
  async softDelete(userId) {
    return prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });
  }

  /** Get all active clinicians for availability/booking */
  async findActiveClinicians(branchId = null) {
    const branchFilter = branchId ? { branchId } : {};
    const [doctors, therapists] = await prisma.$transaction([
      prisma.doctor.findMany({
        where: { user: { deletedAt: null, ...branchFilter } },
        include: { user: { select: { id: true, email: true, role: true } } },
      }),
      prisma.therapist.findMany({
        where: { user: { deletedAt: null, ...branchFilter } },
        include: { user: { select: { id: true, email: true, role: true } } },
      }),
    ]);
    return { doctors, therapists };
  }
}

export const userRepository = new UserRepository();
