import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * StaffSkillService — skill matrix management, certification tracking, and skill-based search.
 */
export class StaffSkillService {
    /**
     * Add or update a skill for a user.
     */
    static async addSkill(userId, skillType, skillName, proficiency, certifiedAt, expiresAt) {
        const skill = await prisma.staffSkill.upsert({
            where: {
                userId_skillType_skillName: { userId, skillType, skillName },
            },
            create: {
                userId,
                skillType,
                skillName,
                proficiency: proficiency || 'INTERMEDIATE',
                certifiedAt: certifiedAt ? new Date(certifiedAt) : null,
                expiresAt: expiresAt ? new Date(expiresAt) : null,
            },
            update: {
                proficiency: proficiency || undefined,
                certifiedAt: certifiedAt ? new Date(certifiedAt) : undefined,
                expiresAt: expiresAt ? new Date(expiresAt) : undefined,
                updatedAt: new Date(),
            },
        });

        logger.info(`[StaffSkill] Upserted skill ${skillType}/${skillName} for user ${userId}`);
        return skill;
    }

    /**
     * Remove a skill from a user.
     */
    static async removeSkill(userId, skillType, skillName) {
        await prisma.staffSkill.delete({
            where: {
                userId_skillType_skillName: { userId, skillType, skillName },
            },
        });

        logger.info(`[StaffSkill] Removed skill ${skillType}/${skillName} for user ${userId}`);
        return { success: true };
    }

    /**
     * Get all skills for a user.
     */
    static async getUserSkills(userId) {
        return prisma.staffSkill.findMany({
            where: { userId },
            orderBy: [{ skillType: 'asc' }, { skillName: 'asc' }],
        });
    }

    /**
     * Get the skill matrix for a branch — users x skills.
     */
    static async getSkillMatrix(branchId) {
        const users = await prisma.user.findMany({
            where: {
                branchId,
                role: { in: ['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST', 'PHARMACIST'] },
                deletedAt: null,
            },
            select: {
                id: true, email: true, role: true,
                doctor: { select: { fullName: true } },
                therapist: { select: { fullName: true } },
                pharmacist: { select: { fullName: true } },
            },
        });

        const userIds = users.map((u) => u.id);
        if (userIds.length === 0) return [];

        const skills = await prisma.staffSkill.findMany({
            where: { userId: { in: userIds } },
            orderBy: [{ skillType: 'asc' }, { skillName: 'asc' }],
        });

        // Return array of { userId, fullName, role, skills[] } matching SkillMatrixRow type
        return users.map((user) => {
            const profile = user.doctor || user.therapist || user.pharmacist;
            return {
                userId: user.id,
                fullName: profile?.fullName || user.email,
                role: user.role,
                skills: skills.filter((s) => s.userId === user.id),
            };
        });
    }

    /**
     * Find all staff who have a specific skill, optionally filtered by branch.
     */
    static async findStaffBySkill(skillName, branchId) {
        const where = { skillName };

        const skills = await prisma.staffSkill.findMany({
            where,
            include: {
                user: {
                    select: { id: true, email: true, role: true, branchId: true },
                },
            },
            orderBy: { proficiency: 'desc' },
        });

        // Filter by branch if specified
        let results = skills;
        if (branchId) {
            results = skills.filter((s) => s.user.branchId === branchId);
        }

        return results;
    }

    /**
     * Get certifications expiring within N days.
     */
    static async getExpiringCertifications(daysAhead = 30) {
        const now = new Date();
        const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

        return prisma.staffSkill.findMany({
            where: {
                expiresAt: {
                    gte: now,
                    lte: cutoff,
                },
            },
            include: {
                user: { select: { id: true, email: true, role: true, branchId: true } },
            },
            orderBy: { expiresAt: 'asc' },
        });
    }
}
