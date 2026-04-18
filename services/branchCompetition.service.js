import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { cacheService } from './cache.service.js';

/**
 * BranchCompetitionService — manages team/branch-level competitions.
 *
 * Supports:
 * - Time-boxed competitions between branches
 * - Automatic score aggregation from individual clinician scores
 * - Branch leaderboard (aggregate average scores)
 */
export class BranchCompetitionService {
    /**
     * Create a new branch competition.
     */
    static async createCompetition({ title, description, metric, startDate, endDate, createdById }) {
        const competition = await prisma.branchCompetition.create({
            data: {
                title,
                description,
                metric,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                createdById
            }
        });

        // Auto-enroll all active branches
        const branches = await prisma.branch.findMany({ where: { isActive: true } });
        await prisma.branchCompetitionEntry.createMany({
            data: branches.map(b => ({
                competitionId: competition.id,
                branchId: b.id,
                score: 0
            }))
        });

        logger.info(`[BranchCompetition] Created competition "${title}" with ${branches.length} branches`);
        return competition;
    }

    /**
     * Recalculate scores for all active competitions.
     * Called by the daily scheduler after individual score recalculation.
     */
    static async recalculateActiveCompetitions() {
        const activeComps = await prisma.branchCompetition.findMany({
            where: { isActive: true, endDate: { gte: new Date() } },
            include: { entries: { include: { branch: true } } }
        });

        for (const comp of activeComps) {
            try {
                await this._recalculateCompetition(comp);
            } catch (err) {
                logger.error(`[BranchCompetition] Failed to recalculate ${comp.id}:`, err.message);
            }
        }

        // Auto-close expired competitions
        await prisma.branchCompetition.updateMany({
            where: { isActive: true, endDate: { lt: new Date() } },
            data: { isActive: false }
        });

        return activeComps.length;
    }

    /**
     * Recalculate a single competition based on its metric.
     */
    static async _recalculateCompetition(competition) {
        const { metric, startDate, endDate } = competition;
        const branches = await prisma.branch.findMany({ where: { isActive: true } });

        const branchScores = [];
        for (const branch of branches) {
            const score = await this._computeBranchMetric(branch.id, metric, startDate, endDate);
            branchScores.push({ branchId: branch.id, score });
        }

        // Sort and assign ranks
        branchScores.sort((a, b) => b.score - a.score);
        for (let i = 0; i < branchScores.length; i++) {
            branchScores[i].rank = i + 1;
        }

        // Upsert entries
        for (const bs of branchScores) {
            await prisma.branchCompetitionEntry.upsert({
                where: {
                    competitionId_branchId: {
                        competitionId: competition.id,
                        branchId: bs.branchId
                    }
                },
                update: { score: bs.score, rank: bs.rank },
                create: {
                    competitionId: competition.id,
                    branchId: bs.branchId,
                    score: bs.score,
                    rank: bs.rank
                }
            });
        }
    }

    /**
     * Compute a branch's aggregate metric.
     */
    static async _computeBranchMetric(branchId, metric, startDate, endDate) {
        switch (metric) {
            case 'avgScore': {
                // Average leaderboard audit score for clinicians in this branch
                const audits = await prisma.leaderboardAudit.findMany({
                    where: {
                        calculationDate: { gte: startDate, lte: endDate },
                        participantRole: { in: ['DOCTOR', 'THERAPIST'] }
                    },
                    select: { participantId: true, score: true }
                });

                // Get clinicians belonging to this branch
                const [doctors, therapists] = await Promise.all([
                    prisma.doctor.findMany({
                        where: { user: { branchId } },
                        select: { id: true }
                    }),
                    prisma.therapist.findMany({
                        where: { user: { branchId } },
                        select: { id: true }
                    })
                ]);
                const branchIds = new Set([...doctors.map(d => d.id), ...therapists.map(t => t.id)]);
                const branchAudits = audits.filter(a => branchIds.has(a.participantId));

                if (branchAudits.length === 0) return 0;
                return Math.round(branchAudits.reduce((s, a) => s + a.score, 0) / branchAudits.length * 100) / 100;
            }

            case 'avgResponseTime': {
                const branchAppointments = await prisma.appointment.findMany({
                    where: {
                        branchId,
                        status: 'COMPLETED',
                        date: { gte: startDate, lte: endDate },
                        triageSessionId: { not: null }
                    },
                    include: { triageSession: true }
                });

                if (branchAppointments.length === 0) return 0;
                let totalMins = 0;
                let count = 0;
                for (const apt of branchAppointments) {
                    if (apt.triageSession) {
                        const diff = (apt.createdAt.getTime() - apt.triageSession.createdAt.getTime()) / 60000;
                        if (diff > 0) { totalMins += diff; count++; }
                    }
                }
                // Lower is better — invert so higher score = better
                const avg = count > 0 ? totalMins / count : 999;
                return Math.round(Math.max(0, 100 - avg) * 100) / 100;
            }

            case 'totalAppointments': {
                return prisma.appointment.count({
                    where: {
                        branchId,
                        status: 'COMPLETED',
                        date: { gte: startDate, lte: endDate }
                    }
                });
            }

            default:
                return 0;
        }
    }

    /**
     * Get the branch-level leaderboard (non-competition aggregate).
     */
    static async getBranchLeaderboard() {
        const cacheKey = 'branch-leaderboard';
        const cached = await cacheService.get(cacheKey).catch(() => null);
        if (cached) return cached;

        const branches = await prisma.branch.findMany({
            where: { isActive: true },
            select: { id: true, name: true }
        });

        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const result = [];

        for (const branch of branches) {
            const [doctors, therapists] = await Promise.all([
                prisma.doctor.findMany({ where: { user: { branchId: branch.id } }, select: { id: true } }),
                prisma.therapist.findMany({ where: { user: { branchId: branch.id } }, select: { id: true } })
            ]);

            const clinicianIds = [...doctors.map(d => d.id), ...therapists.map(t => t.id)];
            if (clinicianIds.length === 0) continue;

            // Get latest audit scores for each clinician
            const latestAudits = await prisma.leaderboardAudit.findMany({
                where: {
                    participantId: { in: clinicianIds },
                    calculationDate: { gte: thirtyDaysAgo }
                },
                orderBy: { calculationDate: 'desc' },
                distinct: ['participantId'],
                select: { participantId: true, score: true }
            });

            const avgScore = latestAudits.length > 0
                ? Math.round(latestAudits.reduce((s, a) => s + a.score, 0) / latestAudits.length)
                : 0;

            const totalAppointments = await prisma.appointment.count({
                where: {
                    branchId: branch.id,
                    status: 'COMPLETED',
                    date: { gte: thirtyDaysAgo }
                }
            });

            result.push({
                branchId: branch.id,
                branchName: branch.name,
                clinicianCount: clinicianIds.length,
                avgScore,
                totalAppointments,
                auditCount: latestAudits.length
            });
        }

        result.sort((a, b) => b.avgScore - a.avgScore);
        result.forEach((r, i) => r.rank = i + 1);

        await cacheService.set(cacheKey, result, 1800).catch(() => { });
        return result;
    }

    /**
     * Get active competitions with their entries.
     */
    static async getActiveCompetitions() {
        return prisma.branchCompetition.findMany({
            where: { isActive: true },
            include: {
                entries: {
                    include: { branch: { select: { id: true, name: true } } },
                    orderBy: { rank: 'asc' }
                }
            },
            orderBy: { endDate: 'asc' }
        });
    }

    /**
     * Get competition history (completed).
     */
    static async getCompetitionHistory({ limit = 10 } = {}) {
        return prisma.branchCompetition.findMany({
            where: { isActive: false },
            include: {
                entries: {
                    include: { branch: { select: { id: true, name: true } } },
                    orderBy: { rank: 'asc' }
                }
            },
            orderBy: { endDate: 'desc' },
            take: limit
        });
    }
}
