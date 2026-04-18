import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * AdaptiveTargetsService — personalized scoring targets for clinicians.
 *
 * Instead of a single static target for all clinicians, this service adjusts
 * targets based on:
 * 1. Role-based adjustment: part-time vs full-time (availability-based)
 * 2. Progressive targets: as a clinician improves, their personal targets increase
 * 3. Percentile-based scoring: compare against peers in the same branch/specialty
 */
export class AdaptiveTargetsService {
    /**
     * Get or compute adaptive targets for a participant.
     */
    static async getTargets(participantId, role) {
        // Check for existing active targets
        const existing = await prisma.adaptiveTarget.findMany({
            where: {
                participantId,
                effectiveUntil: { gte: new Date() }
            }
        });

        if (existing.length > 0) {
            const targetMap = {};
            for (const t of existing) {
                targetMap[t.metric] = t.personalTarget;
            }
            return targetMap;
        }

        // Compute fresh targets
        return this.recalculateTargets(participantId, role);
    }

    /**
     * Recalculate adaptive targets for a participant.
     * Called after each leaderboard recalculation cycle.
     */
    static async recalculateTargets(participantId, role) {
        const globalConfig = await prisma.leaderboardConfig.findFirst({
            where: { isActive: true },
            orderBy: { createdAt: 'desc' }
        });

        if (!globalConfig) return null;

        const baseTargets = {
            appointments: globalConfig.targetAppointments,
            adherence: globalConfig.targetAdherence,
            responseTime: globalConfig.targetResponseTime,
            successRate: globalConfig.targetSuccessRate
        };

        // 1. Availability-based adjustment (part-time clinicians get lower volume targets)
        const availabilityFactor = await this._getAvailabilityFactor(participantId, role);

        // 2. Progressive adjustment: if clinician consistently exceeds target, raise it
        const progressiveFactor = await this._getProgressiveFactor(participantId);

        // 3. Percentile-based: compare to peers
        const percentileAdjustment = await this._getPercentileAdjustment(participantId, role);

        const personalTargets = {};
        const effectiveFrom = new Date();
        const effectiveUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 1 week

        for (const [metric, baseTarget] of Object.entries(baseTargets)) {
            let adjusted = baseTarget;
            let reason = 'standard';

            if (metric === 'appointments') {
                // Volume metrics scale with availability
                adjusted = Math.round(baseTarget * availabilityFactor * progressiveFactor.appointments);
                reason = `avail_factor:${availabilityFactor.toFixed(2)},prog_factor:${progressiveFactor.appointments.toFixed(2)}`;
            } else if (metric === 'adherence' || metric === 'successRate') {
                // Rate metrics use progressive scaling only (harder to improve at high levels)
                const factor = progressiveFactor[metric] || 1.0;
                adjusted = Math.min(Math.round(baseTarget * factor * 10) / 10, 100); // Cap at 100%
                reason = `progressive:${factor.toFixed(2)}`;
            } else if (metric === 'responseTime') {
                // Lower target = harder — progressive makes it tighter
                adjusted = Math.max(Math.round(baseTarget / progressiveFactor.responseTime), 5); // Min 5 minutes
                reason = `progressive_tighter:${progressiveFactor.responseTime.toFixed(2)}`;
            }

            personalTargets[metric] = adjusted;

            // Upsert the adaptive target record
            await prisma.adaptiveTarget.upsert({
                where: {
                    participantId_metric_effectiveFrom: {
                        participantId,
                        metric,
                        effectiveFrom
                    }
                },
                update: {
                    personalTarget: adjusted,
                    baseTarget,
                    adjustmentReason: reason,
                    effectiveUntil
                },
                create: {
                    participantId,
                    participantRole: role,
                    metric,
                    personalTarget: adjusted,
                    baseTarget,
                    adjustmentReason: reason,
                    effectiveFrom,
                    effectiveUntil
                }
            });
        }

        return personalTargets;
    }

    /**
     * Determine availability factor based on blocked slots.
     * Full-time (~40 hrs/week) = 1.0, part-time scales down proportionally.
     */
    static async _getAvailabilityFactor(participantId, role) {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Count blocked slots in the last week (more blocks = less availability)
        const blockedCount = await prisma.blockedSlot.count({
            where: {
                ...(role === 'DOCTOR' ? { doctorId: participantId } : { therapistId: participantId }),
                OR: [
                    { date: { gte: weekAgo } },
                    { dayOfWeek: { not: null } } // recurring blocks
                ]
            }
        });

        // Assume 30 available slots per week is "full-time"
        // Each blocked slot reduces availability
        const maxSlots = 30;
        const factor = Math.max(0.3, (maxSlots - blockedCount) / maxSlots); // Floor at 0.3
        return Math.round(factor * 100) / 100;
    }

    /**
     * Progressive factor: if a clinician has exceeded their target for 3+ consecutive
     * audit cycles, increase the target by 10%.
     */
    static async _getProgressiveFactor(participantId) {
        const recentAudits = await prisma.leaderboardAudit.findMany({
            where: { participantId },
            orderBy: { calculationDate: 'desc' },
            take: 5,
            select: { metrics: true }
        });

        const factors = {
            appointments: 1.0,
            adherence: 1.0,
            successRate: 1.0,
            responseTime: 1.0,
        };

        if (recentAudits.length < 3) return factors;

        // Check if all recent audits exceeded targets (score > 90 for each metric)
        const metricKeys = ['appointments', 'adherence', 'successRate', 'responseTime'];
        for (const key of metricKeys) {
            const allExceeded = recentAudits.every(a => {
                const m = a.metrics?.[key];
                return m && m.score >= 90;
            });
            if (allExceeded) {
                factors[key] = 1.1; // 10% harder target
            }
        }

        return factors;
    }

    /**
     * Percentile adjustment based on peer performance.
     * Returns adjustment hints — not directly used in targets yet,
     * but included in analytics for admin insight.
     */
    static async _getPercentileAdjustment(participantId, role) {
        // Get latest scores for all clinicians of the same role
        const allAudits = await prisma.leaderboardAudit.findMany({
            where: { participantRole: role },
            orderBy: { calculationDate: 'desc' },
            distinct: ['participantId'],
            select: { participantId: true, score: true }
        });

        if (allAudits.length < 3) return { percentile: 50, adjustment: 0 };

        const scores = allAudits.map(a => a.score).sort((a, b) => a - b);
        const myAudit = allAudits.find(a => a.participantId === participantId);
        const myScore = myAudit?.score || 0;

        const rank = scores.filter(s => s <= myScore).length;
        const percentile = Math.round((rank / scores.length) * 100);

        return { percentile, peerCount: scores.length };
    }
}
