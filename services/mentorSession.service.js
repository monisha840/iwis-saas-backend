import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ClinicianXPService } from './clinicianXP.service.js';
import { emitToUser } from '../websocket/index.js';
import { userNameSelect, flattenUserName } from '../lib/userName.js';

/**
 * MentorSessionService — scheduling and tracking mentor/mentee sessions.
 * Awards XP to the mentor upon session completion and checks for mentor badges.
 */
export class MentorSessionService {
    static MENTOR_BADGES = [
        { code: 'MENTOR_5',  threshold: 5,  name: 'Guiding Hand',     description: 'Completed 5 mentor sessions',  tier: 'BRONZE' },
        { code: 'MENTOR_20', threshold: 20, name: 'Mentor Master',    description: 'Completed 20 mentor sessions', tier: 'SILVER' },
        { code: 'MENTOR_50', threshold: 50, name: 'Legendary Mentor', description: 'Completed 50 mentor sessions', tier: 'GOLD' },
    ];

    /**
     * Schedule a new mentor session.
     */
    static async createSession(mentorId, menteeId, topic, date, durationMins = 30) {
        if (mentorId === menteeId) {
            throw Object.assign(new Error('Mentor and mentee cannot be the same person'), { status: 400 });
        }

        const raw = await prisma.mentorSession.create({
            data: {
                mentorId,
                menteeId,
                topic,
                date: new Date(date),
                durationMins,
                status: 'SCHEDULED',
            },
            include: {
                mentor: { select: userNameSelect },
                mentee: { select: userNameSelect },
            },
        });

        const session = {
            ...raw,
            mentor: flattenUserName(raw.mentor),
            mentee: flattenUserName(raw.mentee),
        };

        // Notify mentee
        emitToUser(menteeId, 'mentor_session_scheduled', {
            sessionId: session.id,
            mentorName: session.mentor.name,
            topic,
            date,
        });

        logger.info(`[MentorSessionService] Session scheduled: ${mentorId} -> ${menteeId}, topic: "${topic}"`);
        return session;
    }

    /**
     * Mark a session as completed and award XP to the mentor.
     */
    static async completeSession(sessionId) {
        const session = await prisma.mentorSession.findUnique({ where: { id: sessionId } });
        if (!session) {
            throw Object.assign(new Error('Session not found'), { status: 404 });
        }
        if (session.status === 'COMPLETED') {
            throw Object.assign(new Error('Session already completed'), { status: 400 });
        }
        if (session.status === 'CANCELLED') {
            throw Object.assign(new Error('Cannot complete a cancelled session'), { status: 400 });
        }

        const updatedRaw = await prisma.mentorSession.update({
            where: { id: sessionId },
            data: { status: 'COMPLETED', xpAwarded: true },
            include: {
                mentor: { select: userNameSelect },
                mentee: { select: userNameSelect },
            },
        });

        const updated = {
            ...updatedRaw,
            mentor: flattenUserName(updatedRaw.mentor),
            mentee: flattenUserName(updatedRaw.mentee),
        };

        // Award XP to mentor
        await ClinicianXPService.awardXP(
            session.mentorId,
            'MENTOR_SESSION',
            ClinicianXPService.XP_ACTIONS.MENTOR_SESSION,
            sessionId,
            { menteeId: session.menteeId, topic: session.topic }
        );

        // Check and award mentor badges
        await this._checkMentorBadges(session.mentorId);

        logger.info(`[MentorSessionService] Session ${sessionId} completed, XP awarded to mentor ${session.mentorId}`);
        return updated;
    }

    /**
     * Cancel a session.
     */
    static async cancelSession(sessionId) {
        const session = await prisma.mentorSession.findUnique({ where: { id: sessionId } });
        if (!session) {
            throw Object.assign(new Error('Session not found'), { status: 404 });
        }
        if (session.status !== 'SCHEDULED') {
            throw Object.assign(new Error(`Cannot cancel a ${session.status.toLowerCase()} session`), { status: 400 });
        }

        const updated = await prisma.mentorSession.update({
            where: { id: sessionId },
            data: { status: 'CANCELLED' },
        });

        logger.info(`[MentorSessionService] Session ${sessionId} cancelled`);
        return updated;
    }

    /**
     * Get sessions for a user as mentor or mentee.
     */
    static async getMySessions(userId, role = 'both') {
        let where = {};
        if (role === 'mentor') {
            where = { mentorId: userId };
        } else if (role === 'mentee') {
            where = { menteeId: userId };
        } else {
            where = { OR: [{ mentorId: userId }, { menteeId: userId }] };
        }

        const rows = await prisma.mentorSession.findMany({
            where,
            orderBy: { date: 'desc' },
            include: {
                mentor: { select: userNameSelect },
                mentee: { select: userNameSelect },
            },
        });
        return rows.map((r) => ({
            ...r,
            mentor: flattenUserName(r.mentor),
            mentee: flattenUserName(r.mentee),
        }));
    }

    /**
     * Get mentor statistics for a user.
     */
    static async getMentorStats(userId) {
        const [totalSessions, completedSessions, uniqueMentees, xpFromMentoring] = await Promise.all([
            prisma.mentorSession.count({ where: { mentorId: userId } }),
            prisma.mentorSession.count({ where: { mentorId: userId, status: 'COMPLETED' } }),
            prisma.mentorSession.findMany({
                where: { mentorId: userId, status: 'COMPLETED' },
                select: { menteeId: true },
                distinct: ['menteeId'],
            }),
            prisma.xPLedger.aggregate({
                where: { userId, action: 'MENTOR_SESSION' },
                _sum: { xpAmount: true },
            }),
        ]);

        const xpEarned = xpFromMentoring._sum.xpAmount || 0;
        return {
            totalSessions,
            completedSessions,
            totalMentees: uniqueMentees.length,
            xpEarned,
            xpEarnedFromMentoring: xpEarned,
        };
    }

    /**
     * Check and award mentor milestone badges.
     */
    static async _checkMentorBadges(userId) {
        const completedCount = await prisma.mentorSession.count({
            where: { mentorId: userId, status: 'COMPLETED' },
        });

        for (const badgeDef of this.MENTOR_BADGES) {
            if (completedCount >= badgeDef.threshold) {
                // Check if badge definition exists, create if not
                let badge = await prisma.badge.findFirst({ where: { code: badgeDef.code } });
                if (!badge) {
                    badge = await prisma.badge.create({
                        data: {
                            code: badgeDef.code,
                            name: badgeDef.name,
                            description: badgeDef.description,
                            icon: 'UserCheck',
                            tier: badgeDef.tier,
                            criteria: { type: 'cumulative', metric: 'mentorSessions', threshold: badgeDef.threshold },
                        },
                    });
                }

                // Check if already awarded
                const existing = await prisma.userBadge.findFirst({
                    where: { userId, badgeId: badge.id },
                });

                if (!existing) {
                    try {
                        await prisma.userBadge.create({
                            data: { userId, badgeId: badge.id },
                        });

                        // Award badge XP
                        await ClinicianXPService.awardXP(
                            userId,
                            'BADGE_EARNED',
                            ClinicianXPService.XP_ACTIONS.BADGE_EARNED,
                            badge.id,
                            { badgeCode: badgeDef.code, badgeName: badgeDef.name }
                        );

                        emitToUser(userId, 'badge_earned', {
                            badge: { code: badge.code, name: badge.name, icon: badge.icon, tier: badge.tier },
                            message: `You earned the "${badge.name}" badge!`,
                        });

                        logger.info(`[MentorSessionService] Awarded badge ${badgeDef.code} to user ${userId}`);
                    } catch (err) {
                        // Unique constraint — already awarded (race condition guard)
                        if (!err.code?.includes('P2002')) {
                            logger.error(`[MentorSessionService] Failed to award badge ${badgeDef.code}:`, err.message);
                        }
                    }
                }
            }
        }
    }
}
