import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { cacheService } from './cache.service.js';

const LOOKBACK_DAYS = 30;
const RESPONSE_TIME_TARGET_MINS = 30;
const MSS_IN_A_DAY = 24 * 60 * 60 * 1000;

export class LeaderboardService {
    /**
     * Get the current leaderboard configuration or create default
     */
    static async getConfig() {
        let config = await prisma.leaderboardConfig.findFirst({
            where: { isActive: true },
            orderBy: { createdAt: 'desc' }
        });

        if (!config) {
            config = await prisma.leaderboardConfig.create({
                data: {
                    appointmentWeight: 0.25,
                    adherenceWeight: 0.25,
                    responseTimeWeight: 0.15,
                    successRateWeight: 0.25,
                    consistencyWeight: 0.10,
                    targetAppointments: 50,
                    targetAdherence: 90,
                    targetSuccessRate: 85,
                    targetResponseTime: RESPONSE_TIME_TARGET_MINS
                }
            });
        }
        return config;
    }

    /**
     * Compute metrics for a participant WITHOUT writing to the DB.
     * Used for leaderboard display.
     */
    static async _computeMetrics(participantId, role, prefetchedData, config, skipRoleCheck = false) {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - (LOOKBACK_DAYS * MSS_IN_A_DAY));

        // Verify role only when called from scheduler path (not on every leaderboard request)
        if (!skipRoleCheck) {
            const user = await prisma.user.findFirst({
                where: {
                    OR: [
                        { doctor: { id: participantId } },
                        { therapist: { id: participantId } }
                    ]
                },
                select: { role: true, email: true }
            });

            if (!user || user.role === 'ADMIN' || user.role === 'ADMIN_DOCTOR') {
                return null;
            }
        }

        // 1. Appointment Metric
        const appointments = prefetchedData
            ? prefetchedData.appointments.filter(a => a.status === 'COMPLETED')
            : await prisma.appointment.findMany({
                where: {
                    OR: [{ doctorId: participantId }, { therapistId: participantId }],
                    status: 'COMPLETED',
                    date: { gte: thirtyDaysAgo }
                }
            });
        const appointmentCount = appointments.length;
        const appointmentScore = Math.min((appointmentCount / config.targetAppointments) * 100, 100);

        // 2. Adherence Rate Metric
        const clinician = prefetchedData
            ? null
            : (role === 'THERAPIST'
                ? await prisma.therapist.findUnique({ where: { id: participantId }, include: { journeys: { include: { medications: true } } } })
                : await prisma.doctor.findUnique({ where: { id: participantId }, include: { journeys: { include: { medications: true } } } }));

        let totalLogs = 0;
        let takenLogs = 0;
        const journeys = prefetchedData ? prefetchedData.journeys : (clinician?.journeys || []);

        journeys.forEach(j => {
            j.medications.forEach(m => {
                totalLogs++;
                if (m.taken) takenLogs++;
            });
        });
        const adherenceRate = totalLogs > 0 ? (takenLogs / totalLogs) * 100 : 100;
        const adherenceScore = Math.min((adherenceRate / config.targetAdherence) * 100, 100);

        // 3. Response Time Metric
        const { avgMinutes } = await this._calculateResponseTimeMetric(participantId, thirtyDaysAgo, prefetchedData);
        const responseTimeScore = Math.max(0, 100 - (avgMinutes / config.targetResponseTime * 50));

        // 4. Success Rate Metric
        const totalJourneys = journeys.length;
        const completedJourneys = journeys.filter(j => j.status === 'COMPLETED').length;
        const successRate = totalJourneys > 0 ? (completedJourneys / totalJourneys) * 100 : 0;
        const successScore = Math.min((successRate / config.targetSuccessRate) * 100, 100);

        // 5. Consistency Metric
        const { consistency, activeDaysCount } = await this._calculateConsistencyScore(participantId, thirtyDaysAgo, prefetchedData);
        const consistencyScore = consistency;

        const finalScore = Math.round(
            (appointmentScore * config.appointmentWeight) +
            (adherenceScore * config.adherenceWeight) +
            (responseTimeScore * config.responseTimeWeight) +
            (successScore * config.successRateWeight) +
            (consistencyScore * config.consistencyWeight)
        );

        const metrics = {
            appointments: { value: appointmentCount, score: appointmentScore, target: config.targetAppointments },
            adherence: { value: adherenceRate, score: adherenceScore, target: config.targetAdherence },
            responseTime: { value: avgMinutes, score: responseTimeScore, target: config.targetResponseTime },
            successRate: { value: successRate, score: successScore, target: config.targetSuccessRate },
            consistency: { value: activeDaysCount, score: consistencyScore, target: 15 }
        };

        return { score: finalScore, metrics };
    }

    /**
     * Calculate score AND persist an audit record.
     * Used by the daily scheduler / admin triggered recalculations.
     */
    static async calculateParticipantScore(participantId, role, prefetchedData = null) {
        const config = await this.getConfig();
        const result = await this._computeMetrics(participantId, role, prefetchedData, config);
        if (!result) return null;

        const { score: finalScore, metrics } = result;

        const weights = {
            appointmentWeight: config.appointmentWeight,
            adherenceWeight: config.adherenceWeight,
            responseTimeWeight: config.responseTimeWeight,
            successRateWeight: config.successRateWeight,
            consistencyWeight: config.consistencyWeight
        };

        const integrityHash = this._generateIntegrityHash({
            participantId,
            score: finalScore,
            metrics,
            sourceRecordIds: []
        });

        const audit = await prisma.leaderboardAudit.create({
            data: {
                participantId,
                participantRole: role,
                score: finalScore,
                metrics,
                weights,
                sourceRecordIds: [],
                integrityHash
            }
        });

        return { score: finalScore, metrics, auditId: audit.id, integrityHash };
    }

    /**
     * Get the leaderboard — computes scores on the fly WITHOUT writing audit logs.
     * Returns a structured, paginated array (empty if no participants).
     */
    static async getLeaderboard(branchId = null) {
        const cacheKey = `leaderboard:${branchId || 'global'}`;

        // Gracefully fall back if Redis is unavailable
        const cachedData = await cacheService.get(cacheKey).catch(() => null);
        if (cachedData) return cachedData;

        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - (LOOKBACK_DAYS * MSS_IN_A_DAY));

        const config = await this.getConfig();

        const [doctors, therapists] = await Promise.all([
            prisma.doctor.findMany({
                where: { user: { role: 'DOCTOR', ...(branchId && { branchId }) } },
                include: { user: { select: { role: true } } }
            }),
            prisma.therapist.findMany({
                where: { user: { role: 'THERAPIST', ...(branchId && { branchId }) } },
                include: { user: { select: { role: true } } }
            })
        ]);

        const participants = [
            ...doctors.map(d => ({ id: d.id, fullName: d.fullName, role: 'DOCTOR', specialization: d.specialization, profilePhoto: d.profilePhoto })),
            ...therapists.map(t => ({ id: t.id, fullName: t.fullName, role: 'THERAPIST', specialization: t.specialization, profilePhoto: t.profilePhoto }))
        ];

        if (participants.length === 0) {
            return [];
        }

        const participantIds = participants.map(p => p.id);

        // Bulk-fetch all metrics data to avoid N+1 queries
        const [allAppointments, allJourneys, allPrescriptions, allMessages] = await Promise.all([
            prisma.appointment.findMany({
                where: {
                    OR: [{ doctorId: { in: participantIds } }, { therapistId: { in: participantIds } }],
                    date: { gte: thirtyDaysAgo }
                },
                include: { triageSession: true }
            }),
            prisma.journey.findMany({
                where: {
                    OR: [{ doctorId: { in: participantIds } }, { therapistId: { in: participantIds } }]
                },
                include: { medications: true }
            }),
            prisma.prescription.findMany({
                where: {
                    OR: [{ doctorId: { in: participantIds } }, { therapistId: { in: participantIds } }],
                    createdAt: { gte: thirtyDaysAgo }
                }
            }),
            prisma.message.findMany({
                where: {
                    senderId: { in: participantIds },
                    createdAt: { gte: thirtyDaysAgo }
                }
            })
        ]);

        // Group data by participantId for O(1) lookup
        const dataMap = {};
        participantIds.forEach(id => {
            dataMap[id] = {
                appointments: allAppointments.filter(a => a.doctorId === id || a.therapistId === id),
                journeys: allJourneys.filter(j => j.doctorId === id || j.therapistId === id),
                prescriptions: allPrescriptions.filter(r => r.doctorId === id || r.therapistId === id),
                messages: allMessages.filter(m => m.senderId === id)
            };
        });

        // Fetch previous audit scores for trend calculation (single bulk query)
        const previousAudits = await prisma.leaderboardAudit.findMany({
            where: { participantId: { in: participantIds } },
            orderBy: { calculationDate: 'desc' },
            distinct: ['participantId'],
            select: { participantId: true, score: true }
        });
        const prevScoreMap = {};
        previousAudits.forEach(a => { prevScoreMap[a.participantId] = a.score; });

        const rankedEntries = await Promise.all(participants.map(async (p) => {
            try {
                // skipRoleCheck=true: roles are already guaranteed by the Prisma where clause above
                const result = await this._computeMetrics(p.id, p.role, dataMap[p.id], config, true);
                if (!result) return null;

                const prevScore = prevScoreMap[p.id] ?? result.score;
                const trend = result.score - prevScore;

                return {
                    ...p,
                    score: result.score,
                    trend: trend > 0 ? 'up' : trend < 0 ? 'down' : 'stable',
                    trendValue: Math.abs(trend),
                    metrics: result.metrics
                };
            } catch (err) {
                logger.error(`[LeaderboardService] Score computation failed for ${p.id}:`, err.message);
                return null;
            }
        }));

        const sorted = rankedEntries
            .filter(p => p !== null)
            .sort((a, b) => b.score - a.score);

        // Cache for 30 minutes (fire-and-forget)
        cacheService.set(cacheKey, sorted, 1800).catch(() => { });
        return sorted;
    }

    /**
     * Get detailed breakdown for a participant using the latest audit record.
     */
    static async getParticipantBreakdown(participantId) {
        const latestAudit = await prisma.leaderboardAudit.findFirst({
            where: {
                participantId,
                participantRole: { notIn: ['ADMIN', 'ADMIN_DOCTOR'] }
            },
            orderBy: { calculationDate: 'desc' }
        });

        // If no audit exists yet, compute on the fly and return (without saving)
        if (!latestAudit) {
            const config = await this.getConfig();
            const result = await this._computeMetrics(participantId, null, null, config);
            if (!result) throw new Error('No performance data found for this clinician');
            return {
                participantId,
                currentScore: result.score,
                metrics: result.metrics,
                weights: null,
                history: [],
                calculatedAt: new Date()
            };
        }

        const history = await prisma.leaderboardAudit.findMany({
            where: { participantId },
            orderBy: { calculationDate: 'desc' },
            take: 5
        });

        return {
            participantId,
            currentScore: latestAudit.score,
            metrics: latestAudit.metrics,
            weights: latestAudit.weights,
            history: history.map(h => ({ date: h.calculationDate, score: h.score })),
            calculatedAt: latestAudit.calculationDate
        };
    }

    /**
     * Calculate average response time using primary records
     */
    static async _calculateResponseTimeMetric(participantId, thirtyDaysAgo, prefetchedData = null) {
        const sourceIds = [];
        let totalMinutes = 0;
        let count = 0;

        // Clinical Response: TriageSession to Appointment
        const appointmentsWithTriage = prefetchedData
            ? prefetchedData.appointments.filter(a => a.triageSessionId !== null && a.createdAt >= thirtyDaysAgo)
            : await prisma.appointment.findMany({
                where: {
                    OR: [{ doctorId: participantId }, { therapistId: participantId }],
                    triageSessionId: { not: null },
                    createdAt: { gte: thirtyDaysAgo }
                },
                include: { triageSession: true }
            });

        appointmentsWithTriage.forEach(apt => {
            if (apt.triageSession) {
                const diff = (apt.createdAt.getTime() - apt.triageSession.createdAt.getTime()) / (1000 * 60);
                if (diff > 0) {
                    totalMinutes += diff;
                    count++;
                    sourceIds.push(apt.id, apt.triageSession.id);
                }
            }
        });

        // Chat Response: Patient Message to Clinician reply
        // M-3: Use prefetched conversations if available (was hardcoded to [] when prefetchedData
        //      was truthy, silently skipping chat response time for bulk leaderboard computations)
        const conversations = prefetchedData?.conversations ??
            await prisma.conversation.findMany({
                where: {
                    OR: [{ doctorId: participantId }, { therapistId: participantId }],
                    updatedAt: { gte: thirtyDaysAgo }
                },
                include: {
                    messages: {
                        where: { createdAt: { gte: thirtyDaysAgo } },
                        orderBy: { createdAt: 'asc' },
                        take: 200
                    }
                }
            });

        conversations.forEach(conv => {
            let lastPatientMsgTime = null;
            conv.messages.forEach(msg => {
                const isClinician = msg.senderId === participantId;
                if (!isClinician && !lastPatientMsgTime) {
                    lastPatientMsgTime = msg.createdAt;
                } else if (isClinician && lastPatientMsgTime) {
                    const diff = (msg.createdAt.getTime() - lastPatientMsgTime.getTime()) / (1000 * 60);
                    if (diff > 0 && diff < 1440) {
                        totalMinutes += diff;
                        count++;
                        sourceIds.push(msg.id);
                    }
                    lastPatientMsgTime = null;
                }
            });
        });

        const avgMinutes = count > 0 ? (totalMinutes / count) : RESPONSE_TIME_TARGET_MINS;
        return { avgMinutes, sourceIds: [...new Set(sourceIds)] };
    }

    /**
     * Calculate consistency score based on active days
     */
    static async _calculateConsistencyScore(participantId, thirtyDaysAgo, prefetchedData = null) {
        const sourceIds = [];
        const activeDays = new Set();

        const appointments = prefetchedData
            ? prefetchedData.appointments.filter(a => a.status === 'COMPLETED' && a.date >= thirtyDaysAgo)
            : await prisma.appointment.findMany({
                where: {
                    OR: [{ doctorId: participantId }, { therapistId: participantId }],
                    status: 'COMPLETED',
                    date: { gte: thirtyDaysAgo }
                }
            });
        appointments.forEach(apt => {
            activeDays.add(apt.date.toISOString().split('T')[0]);
            sourceIds.push(apt.id);
        });

        const prescriptions = prefetchedData
            ? prefetchedData.prescriptions
            : await prisma.prescription.findMany({
                where: {
                    OR: [{ doctorId: participantId }, { therapistId: participantId }],
                    createdAt: { gte: thirtyDaysAgo }
                }
            });
        prescriptions.forEach(rx => {
            activeDays.add(rx.createdAt.toISOString().split('T')[0]);
            sourceIds.push(rx.id);
        });

        const messages = prefetchedData
            ? prefetchedData.messages
            : await prisma.message.findMany({
                where: {
                    senderId: participantId,
                    createdAt: { gte: thirtyDaysAgo }
                }
            });
        messages.forEach(msg => {
            activeDays.add(msg.createdAt.toISOString().split('T')[0]);
            sourceIds.push(msg.id);
        });

        const consistency = Math.min((activeDays.size / 15) * 100, 100);
        return { consistency, sourceIds: [...new Set(sourceIds)], activeDaysCount: activeDays.size };
    }

    /**
     * Generate an integrity hash for the calculation record
     */
    static _generateIntegrityHash(data) {
        const sortedData = JSON.stringify(data, Object.keys(data).sort());
        return crypto.createHash('sha256').update(sortedData).digest('hex');
    }
}
