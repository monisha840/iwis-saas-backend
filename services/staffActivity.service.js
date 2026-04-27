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
     *
     * `lastSeen` resolution order — uses the freshest of:
     *   1. Latest StaffActivity row (login/logout/break/etc.)
     *   2. Latest AuditLog row attributed to the user (any action they performed)
     *   3. The user's most recent RefreshToken issuance (i.e. last login)
     * Falls back to `null` so the UI can show "Never" rather than "just now"
     * when a user has truly never been active. Previously the fallback was
     * `new Date()` which made every cold user look like they were online.
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

        // Latest StaffActivity, AuditLog, and RefreshToken per user — fetched
        // in parallel so we can pick the freshest signal as `lastSeen`.
        const [latestActivities, latestAudits, latestRefreshTokens] = await Promise.all([
            prisma.staffActivity.findMany({
                where: { userId: { in: userIds } },
                orderBy: { startedAt: 'desc' },
                distinct: ['userId'],
            }),
            prisma.auditLog.findMany({
                where: { userId: { in: userIds } },
                orderBy: { createdAt: 'desc' },
                distinct: ['userId'],
                select: { userId: true, createdAt: true, action: true },
            }),
            prisma.refreshToken.findMany({
                where: { userId: { in: userIds } },
                orderBy: { createdAt: 'desc' },
                distinct: ['userId'],
                select: { userId: true, createdAt: true },
            }),
        ]);

        const activityMap = {};
        for (const act of latestActivities) activityMap[act.userId] = act;
        const auditMap = {};
        for (const a of latestAudits) auditMap[a.userId] = a;
        const tokenMap = {};
        for (const t of latestRefreshTokens) tokenMap[t.userId] = t;

        return users.map((user) => {
            const profile = user.doctor || user.therapist || user.pharmacist;
            const activity = activityMap[user.id];
            const audit = auditMap[user.id];
            const token = tokenMap[user.id];

            // Pick the freshest timestamp across all three sources.
            const candidates = [
                activity?.startedAt,
                audit?.createdAt,
                token?.createdAt,
            ].filter((d) => d instanceof Date);
            const freshest = candidates.length
                ? new Date(Math.max(...candidates.map((d) => d.getTime())))
                : null;

            // currentActivity surfaces a short label of what the user did
            // most recently. Prefer the StaffActivity activityType, but
            // fall back to the audit action so the feed isn't blank for
            // users that haven't pinged the activity service yet.
            const currentActivity = activity?.activityType
                || (audit ? `${audit.action.replace(/_/g, ' ').toLowerCase()}` : null);

            return {
                userId: user.id,
                fullName: profile?.fullName || user.email,
                role: user.role,
                status: activity?.status || 'OFFLINE',
                currentActivity,
                branchName: user.branch?.name || 'Unassigned',
                lastSeen: freshest ? freshest.toISOString() : null,
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
