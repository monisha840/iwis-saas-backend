import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaderboardService } from '../../services/leaderboard.service.js';
import prisma from '../../lib/prisma.js';

// Helper that builds the prefetched data shape `_computeMetrics` accepts so
// we can short-circuit the various per-metric DB lookups.
function emptyPrefetched() {
  return {
    appointments: [],
    journeys: [],
    completedJourneysWithEnd: [],
    journeysWithChat: [],
    chatMessages: [],
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Stub config: legacy weights (consistency = 0.10).
  vi.spyOn(prisma.leaderboardConfig, 'findFirst').mockResolvedValue({
    id: 'cfg', isActive: true,
    appointmentWeight: 0.25,  // unused at runtime — APPOINTMENT_WEIGHT_OVERRIDE wins
    adherenceWeight: 0.25,
    responseTimeWeight: 0.15,
    successRateWeight: 0.25,
    consistencyWeight: 0.10,
    targetAppointments: 50,
    targetAdherence: 90,
    targetSuccessRate: 85,
    targetResponseTime: 5,
    createdAt: new Date(),
  });
  // Stub the consistency lookup so we don't need to mock dozens of writes.
  vi.spyOn(LeaderboardService, '_calculateConsistencyScore').mockResolvedValue({ consistency: 50, activeDaysCount: 8 });
  // Resolve therapist → user shortcut for the feedback lookup (returns no fb).
  vi.spyOn(prisma.therapist, 'findUnique').mockResolvedValue({ userId: 'u_t' });
  vi.spyOn(prisma.consultationFeedback, 'findMany').mockResolvedValue([]);
  vi.spyOn(prisma.clinicianStreak, 'findUnique').mockResolvedValue(null);
});

describe('LeaderboardService — homeTherapyScore for THERAPIST', () => {
  it('emits homeTherapyScore = 80 for 8 completed / 10 scheduled', async () => {
    const sessions = [
      ...Array.from({ length: 8 }, () => ({ status: 'COMPLETED' })),
      ...Array.from({ length: 2 }, () => ({ status: 'SCHEDULED' })),
    ];
    vi.spyOn(prisma.homeTherapySession, 'findMany').mockResolvedValue(sessions);

    const result = await LeaderboardService._computeMetrics(
      'ther_1', 'THERAPIST', emptyPrefetched(), await LeaderboardService.getConfig(), true,
    );
    expect(result).not.toBeNull();
    expect(result.metrics.homeTherapy.completed).toBe(8);
    expect(result.metrics.homeTherapy.scheduled).toBe(10);
    expect(result.metrics.homeTherapy.value).toBe(80);
    // Weight applied for THERAPIST should be 0.10 — consistency goes to 0.
    expect(result.metrics.homeTherapy.weightApplied).toBe(0.1);
    expect(result.metrics.consistency.weightApplied).toBe(0);
  });

  it('clamps homeTherapyScore to 0 when no sessions are scheduled', async () => {
    vi.spyOn(prisma.homeTherapySession, 'findMany').mockResolvedValue([]);
    const result = await LeaderboardService._computeMetrics(
      'ther_2', 'THERAPIST', emptyPrefetched(), await LeaderboardService.getConfig(), true,
    );
    expect(result.metrics.homeTherapy.value).toBe(0);
    expect(result.metrics.homeTherapy.scheduled).toBe(0);
  });

  it('keeps consistency weight (0.10) and zero home-therapy weight for DOCTOR roles', async () => {
    vi.spyOn(prisma.doctor, 'findUnique').mockResolvedValue({ userId: 'u_d' });
    // Doctor lookup paths shouldn't query homeTherapySession at all.
    const findHt = vi.spyOn(prisma.homeTherapySession, 'findMany');
    const result = await LeaderboardService._computeMetrics(
      'doc_1', 'DOCTOR', emptyPrefetched(), await LeaderboardService.getConfig(), true,
    );
    expect(findHt).not.toHaveBeenCalled();
    expect(result.metrics.homeTherapy.value).toBe(0);
    expect(result.metrics.homeTherapy.weightApplied).toBe(0);
    expect(result.metrics.consistency.weightApplied).toBe(0.1);
  });

  it('survives a missing HomeTherapySession table without throwing', async () => {
    vi.spyOn(prisma.homeTherapySession, 'findMany').mockRejectedValue(new Error('relation does not exist'));
    const result = await LeaderboardService._computeMetrics(
      'ther_3', 'THERAPIST', emptyPrefetched(), await LeaderboardService.getConfig(), true,
    );
    expect(result.metrics.homeTherapy.value).toBe(0);
  });
});
