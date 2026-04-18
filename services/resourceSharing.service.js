import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * ResourceSharingService — manages cross-branch doctor/staff coverage requests.
 */
export class ResourceSharingService {
    /**
     * Create a new resource-sharing request.
     */
    static async createSharingRequest(userId, fromBranchId, toBranchId, date, startTime, endTime, reason) {
        const record = await prisma.resourceSharing.create({
            data: {
                userId,
                fromBranchId,
                toBranchId,
                date: new Date(date),
                startTime,
                endTime,
                reason,
                status: 'PENDING',
            },
            include: {
                user: { select: { id: true, email: true, role: true } },
                fromBranch: { select: { id: true, name: true } },
                toBranch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[ResourceSharing] Request created: ${record.id} — ${fromBranchId} → ${toBranchId}`);
        return record;
    }

    /**
     * Approve a pending sharing request.
     */
    static async approveSharingRequest(id, approvedBy) {
        const record = await prisma.resourceSharing.update({
            where: { id },
            data: { status: 'APPROVED', approvedBy },
            include: {
                user: { select: { id: true, email: true, role: true } },
                fromBranch: { select: { id: true, name: true } },
                toBranch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[ResourceSharing] Request ${id} approved by ${approvedBy}`);
        return record;
    }

    /**
     * Reject a pending sharing request.
     */
    static async rejectSharingRequest(id, approvedBy) {
        const record = await prisma.resourceSharing.update({
            where: { id },
            data: { status: 'REJECTED', approvedBy },
            include: {
                user: { select: { id: true, email: true, role: true } },
                fromBranch: { select: { id: true, name: true } },
                toBranch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[ResourceSharing] Request ${id} rejected by ${approvedBy}`);
        return record;
    }

    /**
     * List sharing requests with optional filters + pagination.
     */
    static async getRequests({ branchId, status, page = 1, limit = 20 }) {
        const where = {};
        if (branchId) {
            where.OR = [{ fromBranchId: branchId }, { toBranchId: branchId }];
        }
        if (status) where.status = status;

        const skip = (page - 1) * limit;

        const [data, total] = await Promise.all([
            prisma.resourceSharing.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    user: { select: { id: true, email: true, role: true } },
                    fromBranch: { select: { id: true, name: true } },
                    toBranch: { select: { id: true, name: true } },
                },
            }),
            prisma.resourceSharing.count({ where }),
        ]);

        return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
    }

    /**
     * Get all approved shared staff covering a specific branch today.
     */
    static async getSharedStaffForBranch(branchId, date) {
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);

        const records = await prisma.resourceSharing.findMany({
            where: {
                toBranchId: branchId,
                status: 'APPROVED',
                date: { gte: dayStart, lte: dayEnd },
            },
            include: {
                user: { select: { id: true, email: true, role: true } },
                fromBranch: { select: { id: true, name: true } },
            },
            orderBy: { startTime: 'asc' },
        });

        return records;
    }
}
