/**
 * AvailabilityRepository — DB access for Availability and BlockedSlot models.
 *
 * High-frequency queries (slot lookups, blocked-slot checks) benefit most
 * from being centralised here with composite-index-aware filtering.
 */

import prisma from '../lib/prisma.js';
import { BaseRepository } from './base.repository.js';

export class AvailabilityRepository extends BaseRepository {
  get model() {
    return prisma.availability;
  }

  /** Recurring availability schedule for a clinician */
  async findByClinician(clinicianId, clinicianField = 'doctorId') {
    return prisma.availability.findMany({
      where: { [clinicianField]: clinicianId },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  /** Check blocked slots for a specific date + clinician */
  async findBlockedSlots({ clinicianId, clinicianField = 'doctorId', date }) {
    const dayOfWeek = date ? new Date(date).getDay() : undefined;
    return prisma.blockedSlot.findMany({
      where: {
        [clinicianField]: clinicianId,
        OR: [
          // Specific date blocked
          ...(date ? [{ date: new Date(date) }] : []),
          // Recurring day-of-week block
          ...(dayOfWeek !== undefined ? [{ dayOfWeek, date: null }] : []),
        ],
      },
    });
  }

  /** Create a blocked slot — used by availability management routes */
  async createBlockedSlot(data) {
    return prisma.blockedSlot.create({ data });
  }

  /** Delete a blocked slot */
  async deleteBlockedSlot(id) {
    return prisma.blockedSlot.delete({ where: { id } });
  }

  /** Find blocked slot by ID */
  async findBlockedSlotById(id) {
    return prisma.blockedSlot.findUnique({ where: { id } });
  }

  /**
   * Get all availability + blocked slots in one query — used by booking modal.
   * Optimised: single $transaction avoids N+1 on slot checks.
   */
  async getFullSchedule(clinicianId, clinicianField = 'doctorId', date = null) {
    const [availability, blockedSlots] = await prisma.$transaction([
      this.findByClinician(clinicianId, clinicianField),
      this.findBlockedSlots({ clinicianId, clinicianField, date }),
    ]);
    return { availability, blockedSlots };
  }

  /** Upsert availability schedule */
  async upsertSchedule(clinicianId, clinicianField, slots) {
    return prisma.$transaction(async (tx) => {
      // Replace all slots for this clinician
      await tx.availability.deleteMany({ where: { [clinicianField]: clinicianId } });
      if (slots.length > 0) {
        await tx.availability.createMany({ data: slots });
      }
      return tx.availability.findMany({ where: { [clinicianField]: clinicianId } });
    });
  }
}

export const availabilityRepository = new AvailabilityRepository();
