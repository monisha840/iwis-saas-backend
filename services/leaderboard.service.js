import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { cacheService } from './cache.service.js';

const LOOKBACK_DAYS = 30;
const RESPONSE_TIME_TARGET_MINS = 30;
const MSS_IN_A_DAY = 24 * 60 * 60 * 1000;
const DECAY_RATE = 0.05; // Exponential decay factor — recent days weighted higher

// 2026-04-28: weights spec change — patient-feedback signal added at 0.15 and
// the appointment-volume contribution reduced from 0.25 to 0.10 to keep the
// total at 1.0. LeaderboardConfig in the DB still stores the legacy 0.25 for
// back-compat with prior audit rows; these runtime constants are authoritative.
const APPOINTMENT_WEIGHT_OVERRIDE = 0.10;
const FEEDBACK_WEIGHT             = 0.15;
// 2026-04-28: home-therapy completion rate is a better consistency proxy for
// THERAPIST roles than activeDays, so for therapists we redirect the 0.10
// consistency slot to the homeTherapyScore. Non-therapist roles keep the
// legacy consistency weight.
const HOME_THERAPY_WEIGHT          = 0.10;

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

        // 1. Appointment Metric (time-decay weighted: recent activity counts more)
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
        // Time-decay: weight each appointment by recency (e^(-DECAY_RATE * daysAgo))
        const decayWeightedCount = appointments.reduce((sum, a) => {
            const daysAgo = (now.getTime() - new Date(a.date).getTime()) / MSS_IN_A_DAY;
            return sum + Math.exp(-DECAY_RATE * daysAgo);
        }, 0);
        // Normalize: max possible decay-weighted count for `target` evenly-spaced appointments
        const maxDecayWeight = config.targetAppointments * 0.75; // Adjusted baseline for decay
        const appointmentScore = Math.min((decayWeightedCount / maxDecayWeight) * 100, 100);

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

        // 6. Feedback score — average ConsultationFeedback rating × 20 (5★ → 100).
        //    Looks up by clinicianId (User.id), so we resolve participantId
        //    (Doctor.id / Therapist.id) → user.id once. Returns 0 when there
        //    are no rated feedback rows in the period.
        const userIdRow = role === 'THERAPIST'
            ? await prisma.therapist.findUnique({ where: { id: participantId }, select: { userId: true } })
            : await prisma.doctor.findUnique({    where: { id: participantId }, select: { userId: true } });
        const clinicianUserId = userIdRow?.userId || null;

        let feedbackScore = 0;
        let feedbackCount = 0;
        let avgFeedbackRating = 0;
        if (clinicianUserId) {
            const fb = await prisma.consultationFeedback.findMany({
                where: {
                    clinicianId: clinicianUserId,
                    rating:      { not: null },
                    createdAt:   { gte: thirtyDaysAgo },
                },
                select: { rating: true },
            });
            feedbackCount = fb.length;
            if (feedbackCount > 0) {
                avgFeedbackRating = fb.reduce((s, r) => s + (r.rating || 0), 0) / feedbackCount;
                feedbackScore = Math.max(0, Math.min(100, avgFeedbackRating * 20));
            }
        }

        // Fetch streak multiplier (if clinician has an active streak)
        let streakMultiplier = 1.0;
        let currentStreak = 0;
        try {
            const streak = await prisma.clinicianStreak.findUnique({
                where: { participantId }
            });
            if (streak) {
                streakMultiplier = streak.streakMultiplier;
                currentStreak = streak.currentStreak;
            }
        } catch { /* streak table may not exist yet */ }

        // 7. Home-therapy metric (THERAPIST only). Field therapists earn this
        //    in lieu of the legacy "consistency" signal — the completion rate
        //    of HOME and HOSPITAL therapy sessions in the lookback window is a
        //    cleaner consistency proxy than activeDays for therapists who do
        //    most of their work outside the clinic.
        let homeTherapyScore = 0;
        let homeCompleted = 0;
        let homeScheduled = 0;
        if (role === 'THERAPIST') {
            try {
                const sessions = await prisma.homeTherapySession.findMany({
                    where: {
                        therapistId: participantId,
                        scheduledDate: { gte: thirtyDaysAgo },
                    },
                    select: { status: true },
                });
                homeScheduled = sessions.length;
                homeCompleted = sessions.filter((s) => s.status === 'COMPLETED').length;
                homeTherapyScore = homeScheduled > 0
                    ? Math.max(0, Math.min(100, (homeCompleted / homeScheduled) * 100))
                    : 0;
            } catch { /* table not migrated yet — treat as 0 */ }
        }

        // For THERAPIST roles redirect the 0.10 consistency weight to the
        // home-therapy completion signal. Other roles keep the legacy weights.
        const isTherapist = role === 'THERAPIST';
        const effectiveConsistencyWeight = isTherapist ? 0.0 : config.consistencyWeight;
        const effectiveHomeTherapyWeight = isTherapist ? HOME_THERAPY_WEIGHT : 0.0;

        const baseScore =
            (appointmentScore * APPOINTMENT_WEIGHT_OVERRIDE) +
            (adherenceScore * config.adherenceWeight) +
            (responseTimeScore * config.responseTimeWeight) +
            (successScore * config.successRateWeight) +
            (consistencyScore * effectiveConsistencyWeight) +
            (homeTherapyScore * effectiveHomeTherapyWeight) +
            (feedbackScore * FEEDBACK_WEIGHT);

        // Apply streak multiplier (capped at 110% to prevent runaway scores)
        const finalScore = Math.round(Math.min(baseScore * streakMultiplier, 100));

        const metrics = {
            appointments: { value: appointmentCount, score: appointmentScore, target: config.targetAppointments, decayWeighted: Math.round(decayWeightedCount * 10) / 10 },
            adherence: { value: adherenceRate, score: adherenceScore, target: config.targetAdherence },
            responseTime: { value: avgMinutes, score: responseTimeScore, target: config.targetResponseTime },
            successRate: { value: successRate, score: successScore, target: config.targetSuccessRate },
            consistency: { value: activeDaysCount, score: consistencyScore, target: 15, weightApplied: effectiveConsistencyWeight },
            homeTherapy: {
                value: Math.round(homeTherapyScore),
                score: homeTherapyScore,
                completed: homeCompleted,
                scheduled: homeScheduled,
                target: 100,
                weightApplied: effectiveHomeTherapyWeight,
            },
            feedback: { value: Math.round(avgFeedbackRating * 100) / 100, score: feedbackScore, count: feedbackCount, target: 5 },
            streak: { currentStreak, multiplier: streakMultiplier }
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

        const isTherapist = role === 'THERAPIST';
        const weights = {
            // 2026-04-28: appointmentWeight reduced 0.25 → 0.10 and a new
            // feedbackWeight 0.15 added; the audit snapshot reflects the
            // runtime constants, not the legacy DB config row. For THERAPIST
            // roles the consistency slot (0.10) is redirected into the new
            // homeTherapyWeight so the formula still totals 1.0.
            appointmentWeight:  APPOINTMENT_WEIGHT_OVERRIDE,
            adherenceWeight:    config.adherenceWeight,
            responseTimeWeight: config.responseTimeWeight,
            successRateWeight:  config.successRateWeight,
            consistencyWeight:  isTherapist ? 0 : config.consistencyWeight,
            homeTherapyWeight:  isTherapist ? HOME_THERAPY_WEIGHT : 0,
            feedbackWeight:     FEEDBACK_WEIGHT,
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
            ...therapists.map(t => ({ id: t.id, fullName: t.fullName, role: 'THERAPIST', gender: t.gender, profilePhoto: t.profilePhoto }))
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
     * Recalculate scores for ALL clinicians and persist audit records.
     * Called by the scheduled cron job and by the admin manual trigger.
     */
    static async recalculateAll() {
        const config = await this.getConfig();
        const [doctors, therapists] = await Promise.all([
            prisma.doctor.findMany({ include: { user: { select: { role: true } } } }),
            prisma.therapist.findMany({ include: { user: { select: { role: true } } } })
        ]);

        const participants = [
            ...doctors.map(d => ({ id: d.id, role: 'DOCTOR' })),
            ...therapists.map(t => ({ id: t.id, role: 'THERAPIST' }))
        ];

        let recalculated = 0;
        let errors = 0;

        for (const p of participants) {
            try {
                const result = await this.calculateParticipantScore(p.id, p.role);
                if (result) recalculated++;
            } catch (err) {
                errors++;
                logger.error(`[LeaderboardService] Recalc failed for ${p.id}:`, err.message);
            }
        }

        // Invalidate all cached leaderboards
        await cacheService.deletePattern('leaderboard:*').catch(() => { });

        logger.info(`[LeaderboardService] Recalculation complete: ${recalculated} scored, ${errors} errors`);
        return { recalculated, errors, total: participants.length };
    }

    /**
     * Generate an integrity hash for the calculation record
     */
    static _generateIntegrityHash(data) {
        const sortedData = JSON.stringify(data, Object.keys(data).sort());
        return crypto.createHash('sha256').update(sortedData).digest('hex');
    }
}
