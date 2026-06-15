/**
 * LeaderboardRepository — DB access for LeaderboardAudit, LeaderboardConfig,
 * and the aggregation queries that drive gamification.
 *
 * Separating these heavy read queries from the service keeps the service
 * focused on business rules (weights, scoring) while the repo owns query shapes.
 */

import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { getCurrentTenant } from '../lib/tenantContext.js';
import { BaseRepository } from './base.repository.js';

const LOOKBACK_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class LeaderboardRepository extends BaseRepository {
  get model() {
    return prisma.leaderboardAudit;
  }

  /** Active scoring config */
  async getActiveConfig() {
    return prisma.leaderboardConfig.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Prefetch ALL data needed for a full leaderboard recalculation in one round-trip.
   * Batching avoids N × M queries when iterating over all clinicians.
   *
   * @param {string[]} clinicianIds - doctor/therapist IDs
   */
  async prefetchLeaderboardData(clinicianIds) {
    const since = new Date(Date.now() - LOOKBACK_DAYS * MS_PER_DAY);

    const [appointments, journeys] = await prisma.$transaction([
      prisma.appointment.findMany({
        where: {
          OR: [
            { doctorId: { in: clinicianIds } },
            { therapistId: { in: clinicianIds } },
          ],
          date: { gte: since },
        },
        select: { id: true, doctorId: true, therapistId: true, status: true, date: true, createdAt: true, updatedAt: true },
      }),
      prisma.journey.findMany({
        where: {
          OR: [
            { doctorId: { in: clinicianIds } },
            { therapistId: { in: clinicianIds } },
          ],
          createdAt: { gte: since },
        },
        include: { medications: true },
      }),
    ]);

    return { appointments, journeys };
  }

  /** Save a recalculated snapshot to LeaderboardAudit */
  async saveSnapshot({ participantId, participantRole, score, metrics, weights, sourceRecordIds, integrityHash, rank }) {
    return prisma.leaderboardAudit.create({
      data: { participantId, participantRole, score, metrics, weights, sourceRecordIds, integrityHash, rank },
    });
  }

  /** Get latest snapshot per clinician for display (no recalculation) */
  async getLatestSnapshots(limit = 50) {
    // Phase 1 tenant scope: LeaderboardAudit has hospitalId; never return
    // another hospital's snapshots. Unscoped (null tenant) for SUPER_ADMIN/jobs.
    const tenant = getCurrentTenant();
    const tenantClause = tenant ? Prisma.sql`WHERE "hospitalId" = ${tenant}` : Prisma.empty;
    // Use raw SQL for the lateral/distinct-on pattern (not natively in Prisma)
    return prisma.$queryRaw`
      SELECT DISTINCT ON ("participantId")
        id, "participantId", "participantRole", score, metrics, rank, "calculationDate"
      FROM "LeaderboardAudit"
      ${tenantClause}
      ORDER BY "participantId", "calculationDate" DESC
      LIMIT ${limit}
    `;
  }

  /** Historical trend for a single clinician */
  async getParticipantHistory(participantId, days = 90) {
    const since = new Date(Date.now() - days * MS_PER_DAY);
    return prisma.leaderboardAudit.findMany({
      where: { participantId, calculationDate: { gte: since } },
      orderBy: { calculationDate: 'asc' },
      select: { score: true, rank: true, metrics: true, calculationDate: true },
    });
  }
}

export const leaderboardRepository = new LeaderboardRepository();
