import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';

/**
 * FamilyLeaderboardService — patients can create or join families and
 * compete on a family leaderboard ranked by zen points.
 */
export class FamilyLeaderboardService {
    /**
     * Create a new family. The creator is added as a CREATOR member.
     */
    static async createFamily(patientId, name) {
        if (!name || name.trim().length < 2) {
            throw new Error('Family name must be at least 2 characters');
        }

        const family = await prisma.patientFamily.create({
            data: {
                name: name.trim(),
                createdById: patientId,
                members: {
                    create: {
                        patientId,
                        role: 'CREATOR'
                    }
                }
            },
            include: { members: { include: { patient: { select: { fullName: true, zenPoints: true } } } } }
        });

        logger.info(`[FamilyLeaderboard] Patient ${patientId} created family "${name}"`);
        return family;
    }

    /**
     * Join an existing family by invite code.
     */
    static async joinFamily(patientId, inviteCode) {
        const family = await prisma.patientFamily.findUnique({
            where: { inviteCode },
            include: { members: true }
        });

        if (!family) throw new Error('Invalid invite code');

        // Check if already a member
        const alreadyMember = family.members.find(m => m.patientId === patientId);
        if (alreadyMember) throw new Error('You are already a member of this family');

        await prisma.patientFamilyMember.create({
            data: {
                familyId: family.id,
                patientId,
                role: 'MEMBER'
            }
        });

        // Notify family creator
        const creator = await prisma.patient.findUnique({
            where: { id: family.createdById },
            select: { userId: true }
        });
        const joiner = await prisma.patient.findUnique({
            where: { id: patientId },
            select: { fullName: true, userId: true }
        });

        if (creator) {
            emitToUser(creator.userId, 'achievement_unlocked', {
                type: 'FAMILY_MEMBER_JOINED',
                title: `${joiner?.fullName || 'Someone'} joined your family "${family.name}"!`
            });

            await prisma.notification.create({
                data: {
                    userId: creator.userId,
                    type: 'ACHIEVEMENT',
                    title: 'New Family Member!',
                    message: `${joiner?.fullName || 'A new member'} joined your family "${family.name}".`,
                    priority: 'LOW',
                    data: { familyId: family.id, familyName: family.name }
                }
            });
        }

        logger.info(`[FamilyLeaderboard] Patient ${patientId} joined family "${family.name}"`);

        return prisma.patientFamily.findUnique({
            where: { id: family.id },
            include: { members: { include: { patient: { select: { fullName: true, zenPoints: true } } } } }
        });
    }

    /**
     * Leave a family. Creators cannot leave (they must delete).
     */
    static async leaveFamily(patientId, familyId) {
        const membership = await prisma.patientFamilyMember.findUnique({
            where: { familyId_patientId: { familyId, patientId } }
        });

        if (!membership) throw new Error('You are not a member of this family');
        if (membership.role === 'CREATOR') throw new Error('Family creators cannot leave. Delete the family instead.');

        await prisma.patientFamilyMember.delete({
            where: { familyId_patientId: { familyId, patientId } }
        });

        logger.info(`[FamilyLeaderboard] Patient ${patientId} left family ${familyId}`);
        return { success: true };
    }

    /**
     * Get family leaderboard — members sorted by zenPoints descending.
     */
    static async getFamilyLeaderboard(familyId) {
        const family = await prisma.patientFamily.findUnique({
            where: { id: familyId },
            include: {
                members: {
                    include: {
                        patient: {
                            select: {
                                id: true,
                                fullName: true,
                                zenPoints: true,
                                patientStreak: { select: { currentStreak: true, longestStreak: true } },
                                healthAvatar: { select: { level: true, avatarType: true, name: true } }
                            }
                        }
                    }
                }
            }
        });

        if (!family) throw new Error('Family not found');

        const members = family.members
            .map(m => ({
                patientId: m.patientId,
                name: m.patient.fullName || 'Anonymous',
                role: m.role,
                zenPoints: m.patient.zenPoints,
                streak: m.patient.patientStreak?.currentStreak || 0,
                longestStreak: m.patient.patientStreak?.longestStreak || 0,
                avatarLevel: m.patient.healthAvatar?.level || 0,
                avatarType: m.patient.healthAvatar?.avatarType || null,
                avatarName: m.patient.healthAvatar?.name || null,
                joinedAt: m.joinedAt
            }))
            .sort((a, b) => b.zenPoints - a.zenPoints);

        return {
            id: family.id,
            name: family.name,
            inviteCode: family.inviteCode,
            totalPoints: members.reduce((sum, m) => sum + m.zenPoints, 0),
            memberCount: members.length,
            members
        };
    }

    /**
     * List all families the patient belongs to.
     */
    static async getMyFamilies(patientId) {
        const memberships = await prisma.patientFamilyMember.findMany({
            where: { patientId },
            include: {
                family: {
                    include: {
                        members: {
                            include: {
                                patient: { select: { zenPoints: true } }
                            }
                        }
                    }
                }
            }
        });

        return memberships.map(m => ({
            id: m.family.id,
            name: m.family.name,
            inviteCode: m.family.inviteCode,
            myRole: m.role,
            memberCount: m.family.members.length,
            totalPoints: m.family.members.reduce((sum, mem) => sum + mem.patient.zenPoints, 0),
            joinedAt: m.joinedAt
        }));
    }

    /**
     * Global family rankings — families ranked by total zen points.
     */
    static async getGlobalFamilyRankings({ page = 1, limit = 20 } = {}) {
        const skip = (page - 1) * limit;

        const families = await prisma.patientFamily.findMany({
            include: {
                members: {
                    include: {
                        patient: { select: { zenPoints: true, fullName: true } }
                    }
                }
            }
        });

        const ranked = families
            .map(f => ({
                id: f.id,
                name: f.name,
                memberCount: f.members.length,
                totalPoints: f.members.reduce((sum, m) => sum + m.patient.zenPoints, 0),
                createdAt: f.createdAt
            }))
            .filter(f => f.memberCount >= 2)
            .sort((a, b) => b.totalPoints - a.totalPoints)
            .map((f, idx) => ({ ...f, rank: idx + 1 }));

        const total = ranked.length;
        const paginated = ranked.slice(skip, skip + limit);

        return {
            rankings: paginated,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        };
    }
}
