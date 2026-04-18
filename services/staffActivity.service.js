import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * StaffActivityService — live staff activity feed and presence tracking.
 */
export class StaffActivityService {
    /**
     * Record a staff activity event.
     */
    static async recordActivity(userId, activityType, branchId, metadata) {
        const record = await prisma.staffActivity.create({
            data: {
                userId,
                activityType,
                branchId,
                metadata: metadata || undefined,
                status: StaffActivityService._deriveStatus(activityType),
            },
            include: {
                user: { select: { id: true, email: true, role: true } },
                branch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[StaffActivity] ${activityType} recorded for user ${userId}`);
        return record;
    }

    /**
     * Update the presence status for a user by creating a STATUS_CHANGE activity.
     */
    static async updatePresenceStatus(userId, status, branchId) {
        const record = await prisma.staffActivity.create({
            data: {
                userId,
                activityType: 'STATUS_CHANGE',
                status,
                branchId,
            },
            include: {
                user: { select: { id: true, email: true, role: true } },
                branch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[StaffActivity] Presence updated for user ${userId}: ${status}`);
        return record;
    }

    /**
     * Get the live staff feed for a specific branch — each staff member's latest activity.
     */
    static async getLiveStaffFeed(branchId) {
        // Get all users — if branchId is provided, filter by it; otherwise get all staff
        const whereClause = {
            role: { in: ['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PHARMACIST'] },
            deletedAt: null,
        };
        if (branchId) whereClause.branchId = branchId;

        const users = await prisma.user.findMany({
            where: whereClause,
            select: {
                id: true, email: true, role: true,
                doctor: { select: { fullName: true, profilePhoto: true } },
                therapist: { select: { fullName: true, profilePhoto: true } },
                pharmacist: { select: { fullName: true, profilePhoto: true } },
                branch: { select: { name: true } },
            },
        });

        const userIds = users.map((u) => u.id);
        if (userIds.length === 0) return [];

        // Get the latest activity for each user
        const latestActivities = await prisma.staffActivity.findMany({
            where: { userId: { in: userIds } },
            orderBy: { startedAt: 'desc' },
            distinct: ['userId'],
        });

        const activityMap = {};
        for (const act of latestActivities) {
            activityMap[act.userId] = act;
        }

        return users.map((user) => {
            const profile = user.doctor || user.therapist || user.pharmacist;
            const activity = activityMap[user.id];
            return {
                userId: user.id,
                fullName: profile?.fullName || user.email,
                role: user.role,
                status: activity?.status || 'OFFLINE',
                currentActivity: activity?.activityType || null,
                branchName: user.branch?.name || 'Unassigned',
                lastSeen: activity?.startedAt?.toISOString() || new Date().toISOString(),
                profilePhoto: profile?.profilePhoto || null,
            };
        });
    }

    /**
     * Get aggregated staff feed across all branches.
     */
    static async getAllBranchesStaffFeed() {
        // Return all staff across all branches as a flat array
        return StaffActivityService.getLiveStaffFeed(null);
    }

    /**
     * Derive presence status from activity type.
     */
    static _deriveStatus(activityType) {
        const map = {
            LOGIN: 'ONLINE',
            LOGOUT: 'OFFLINE',
            CONSULTATION_START: 'IN_CONSULTATION',
            CONSULTATION_END: 'ONLINE',
            BREAK_START: 'ON_BREAK',
            BREAK_END: 'ONLINE',
            STATUS_CHANGE: 'ONLINE',
        };
        return map[activityType] || 'ONLINE';
    }
}
