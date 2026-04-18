import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * AntiGamingService — detects and flags suspicious scoring patterns.
 *
 * Protections:
 * 1. Score spike detection: flags if new score deviates >2σ from rolling average
 * 2. Rate limiting: caps score-eligible actions per type per day
 * 3. Anomaly logging: persists flagged events for admin review
 */
export class AntiGamingService {
    // Max score-eligible actions per clinician per day
    static RATE_LIMITS = {
        appointments: 20,  // Max 20 completed appointments counted per day
        messages: 100,     // Max 100 messages counted for response time
        prescriptions: 30, // Max 30 prescriptions per day
    };

    /**
     * Check if a clinician's new score is anomalous.
     * Returns { flagged: boolean, reason?: string } .
     */
    static async checkScoreAnomaly(participantId, role, newScore) {
        // Get last 10 audit records to compute rolling stats
        const history = await prisma.leaderboardAudit.findMany({
            where: { participantId },
            orderBy: { calculationDate: 'desc' },
            take: 10,
            select: { score: true }
        });

        // Need at least 5 data points for meaningful anomaly detection
        if (history.length < 5) return { flagged: false };

        const scores = history.map(h => h.score);
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
        const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length;
        const stdDev = Math.sqrt(variance);

        // Flag if deviation is > 2σ AND > 15 absolute points
        const deviation = Math.abs(newScore - mean);
        if (stdDev > 0 && deviation > 2 * stdDev && deviation > 15) {
            const anomaly = await prisma.gamificationAnomaly.create({
                data: {
                    participantId,
                    participantRole: role,
                    anomalyType: 'SCORE_SPIKE',
                    details: {
                        newScore,
                        rollingMean: Math.round(mean * 100) / 100,
                        stdDeviation: Math.round(stdDev * 100) / 100,
                        deviation: Math.round(deviation * 100) / 100,
                        historicalScores: scores
                    }
                }
            });

            logger.warn(`[AntiGaming] Score spike detected for ${participantId}: ${newScore} vs mean ${mean.toFixed(1)} (σ=${stdDev.toFixed(1)})`);

            return {
                flagged: true,
                anomalyId: anomaly.id,
                reason: `Score jumped ${deviation.toFixed(0)} points from rolling average (2σ threshold: ${(2 * stdDev).toFixed(0)})`
            };
        }

        return { flagged: false };
    }

    /**
     * Rate-limit check: count today's actions for a clinician.
     * Returns { withinLimits: boolean, violations: string[] }
     */
    static async checkRateLimits(participantId) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const [appointmentCount, messageCount, prescriptionCount] = await Promise.all([
            prisma.appointment.count({
                where: {
                    OR: [{ doctorId: participantId }, { therapistId: participantId }],
                    status: 'COMPLETED',
                    date: { gte: todayStart }
                }
            }),
            prisma.message.count({
                where: {
                    senderId: participantId,
                    createdAt: { gte: todayStart }
                }
            }),
            prisma.prescription.count({
                where: {
                    OR: [{ doctorId: participantId }, { therapistId: participantId }],
                    createdAt: { gte: todayStart }
                }
            })
        ]);

        const violations = [];
        if (appointmentCount > this.RATE_LIMITS.appointments) {
            violations.push(`appointments: ${appointmentCount} > ${this.RATE_LIMITS.appointments}`);
        }
        if (messageCount > this.RATE_LIMITS.messages) {
            violations.push(`messages: ${messageCount} > ${this.RATE_LIMITS.messages}`);
        }
        if (prescriptionCount > this.RATE_LIMITS.prescriptions) {
            violations.push(`prescriptions: ${prescriptionCount} > ${this.RATE_LIMITS.prescriptions}`);
        }

        if (violations.length > 0) {
            await prisma.gamificationAnomaly.create({
                data: {
                    participantId,
                    participantRole: 'DOCTOR', // Will be overridden by caller
                    anomalyType: 'RATE_LIMIT_EXCEEDED',
                    details: { violations, appointmentCount, messageCount, prescriptionCount }
                }
            });
            logger.warn(`[AntiGaming] Rate limit exceeded for ${participantId}: ${violations.join(', ')}`);
        }

        return { withinLimits: violations.length === 0, violations };
    }

    /**
     * Get all unresolved anomalies (for admin dashboard).
     */
    static async getUnresolvedAnomalies({ limit = 50, offset = 0 } = {}) {
        const [anomalies, total] = await Promise.all([
            prisma.gamificationAnomaly.findMany({
                where: { resolved: false },
                orderBy: { createdAt: 'desc' },
                skip: offset,
                take: limit
            }),
            prisma.gamificationAnomaly.count({ where: { resolved: false } })
        ]);
        return { anomalies, total };
    }

    /**
     * Resolve an anomaly (admin action).
     */
    static async resolveAnomaly(anomalyId, resolvedBy) {
        return prisma.gamificationAnomaly.update({
            where: { id: anomalyId },
            data: { resolved: true, resolvedBy }
        });
    }

    /**
     * Patient Zen Points rate limiter — caps points per action type per day.
     */
    static PATIENT_RATE_LIMITS = {
        TASK_COMPLETION: { maxPerDay: 10, pointsPer: 10 },
        VITAL_LOG: { maxPerDay: 5, pointsPer: 5 },
        APPOINTMENT_ATTENDANCE: { maxPerDay: 3, pointsPer: 25 },
        STREAK_BONUS: { maxPerDay: 1, pointsPer: 50 },
        MILESTONE: { maxPerDay: 5, pointsPer: 100 },
        CHALLENGE: { maxPerDay: 3, pointsPer: 15 },
    };

    /**
     * Check if a patient can still earn points for a given action today.
     */
    static async canEarnPoints(patientId, action) {
        const limit = this.PATIENT_RATE_LIMITS[action];
        if (!limit) return { allowed: false, reason: 'Unknown action type' };

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const todayCount = await prisma.zenPointsLedger.count({
            where: {
                patientId,
                action,
                createdAt: { gte: todayStart }
            }
        });

        return {
            allowed: todayCount < limit.maxPerDay,
            remaining: Math.max(0, limit.maxPerDay - todayCount),
            points: limit.pointsPer
        };
    }
}
