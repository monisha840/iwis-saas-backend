import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';
import { AvailabilityService } from './availability.service.js';

/**
 * ResourceSharingService — manages cross-branch doctor/staff coverage requests.
 */
export class ResourceSharingService {
    /**
     * Create a new resource-sharing request, then notify the receiving
     * branch's Admin Doctors so they can act on it.
     */
    static async createSharingRequest(userId, fromBranchId, toBranchId, date, startTime, endTime, reason, opts = {}) {
        const { endDate = null, createdById = null } = opts;
        // Gate 1: the clinician must actually be available during the
        // requested window. Sharing someone who's on leave (or whose
        // availability hasn't been published) would create a no-show the
        // receiving branch only discovers on the day.
        const availability = await AvailabilityService.checkAvailabilityForUser(userId, date, startTime, endTime);
        if (!availability.available) {
            const err = new Error(
                `Cannot share this staff member: ${availability.reason || 'not marked as available for the requested time'}.`
            );
            err.status = 409;
            err.code = 'STAFF_NOT_AVAILABLE';
            err.reason = availability.reason || null;
            throw err;
        }

        // Date-range sanity: endDate must be on or after the start date.
        if (endDate) {
            const start = new Date(date);
            const end = new Date(endDate);
            if (Number.isNaN(end.getTime()) || end < start) {
                const err = new Error('End date must be on or after the start date');
                err.status = 400;
                throw err;
            }
        }

        const record = await prisma.resourceSharing.create({
            data: {
                userId,
                fromBranchId,
                toBranchId,
                date: new Date(date),
                endDate: endDate ? new Date(endDate) : null,
                startTime,
                endTime,
                reason,
                status: 'PENDING',
                createdById: createdById || null,
            },
            include: {
                user: { select: { id: true, email: true, role: true,
                    doctor: { select: { fullName: true } },
                    therapist: { select: { fullName: true } },
                } },
                fromBranch: { select: { id: true, name: true } },
                toBranch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[ResourceSharing] Request created: ${record.id} — ${fromBranchId} → ${toBranchId}`);

        // Notify the receiving branch's Admin Doctors (they're the approvers).
        try {
            const approvers = await prisma.user.findMany({
                where: { role: 'ADMIN_DOCTOR', branchId: toBranchId, deletedAt: null },
                select: { id: true },
            });
            const staffName = record.user?.doctor?.fullName
                || record.user?.therapist?.fullName
                || record.user?.email
                || 'a clinician';
            const whenText = new Date(record.date).toLocaleDateString();
            await Promise.all(approvers.map(a => notificationService.createNotification({
                userId: a.id,
                type: 'RESOURCE_SHARING_REQUEST',
                title: `Sharing request: ${staffName}`,
                message: `${record.fromBranch?.name || 'Another branch'} → ${record.toBranch?.name || 'your branch'}, ${whenText} ${startTime}–${endTime}. Awaiting your approval.`,
                priority: 'INFO',
                data: { requestId: record.id, fromBranchId, toBranchId, date },
            })));
        } catch (err) {
            logger.warn(`[ResourceSharing] Failed to notify approvers for ${record.id}: ${err.message}`);
        }

        return record;
    }

    /**
     * Approve a pending sharing request.
     *
     * Authorization: ADMIN may approve any request. ADMIN_DOCTOR may only
     * approve requests targeting *their* branch (`toBranchId === user.branchId`).
     * This enforces the intended handshake: the receiving branch signs off.
     */
    static async approveSharingRequest(id, approver) {
        await this._assertCanDecide(id, approver);
        const record = await prisma.resourceSharing.update({
            where: { id },
            data: { status: 'APPROVED', approvedBy: approver.id },
            include: {
                user: { select: { id: true, email: true, role: true } },
                fromBranch: { select: { id: true, name: true } },
                toBranch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[ResourceSharing] Request ${id} approved by ${approver.id}`);
        return record;
    }

    /**
     * Reject a pending sharing request. Same authorization as approve.
     */
    static async rejectSharingRequest(id, approver) {
        await this._assertCanDecide(id, approver);
        const record = await prisma.resourceSharing.update({
            where: { id },
            data: { status: 'REJECTED', approvedBy: approver.id },
            include: {
                user: { select: { id: true, email: true, role: true } },
                fromBranch: { select: { id: true, name: true } },
                toBranch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[ResourceSharing] Request ${id} rejected by ${approver.id}`);
        return record;
    }

    /**
     * Edit a pending sharing request. Permitted for:
     *   • the original creator (createdById === actor.id)
     *   • the source-branch admin (ADMIN_DOCTOR with branchId === fromBranchId)
     *   • the destination-branch admin (ADMIN_DOCTOR with branchId === toBranchId)
     *   • global ADMIN
     *
     * Only PENDING requests can be edited — once approved/rejected the row
     * is immutable so the schedule history isn't rewritten.
     */
    static async updateSharingRequest(id, actor, patch) {
        const existing = await prisma.resourceSharing.findUnique({
            where: { id },
            select: {
                id: true, status: true, fromBranchId: true, toBranchId: true,
                createdById: true, userId: true, date: true,
            },
        });
        if (!existing) throw Object.assign(new Error('Sharing request not found'), { status: 404 });
        if (existing.status !== 'PENDING') {
            throw Object.assign(
                new Error(`Cannot edit a ${existing.status.toLowerCase()} request`),
                { status: 400 },
            );
        }

        const isCreator = !!existing.createdById && existing.createdById === actor.id;
        const isSourceAdmin = actor.role === 'ADMIN_DOCTOR' && actor.branchId === existing.fromBranchId;
        const isTargetAdmin = actor.role === 'ADMIN_DOCTOR' && actor.branchId === existing.toBranchId;
        const isGlobalAdmin = actor.role === 'ADMIN';
        if (!isCreator && !isSourceAdmin && !isTargetAdmin && !isGlobalAdmin) {
            throw Object.assign(
                new Error('You are not authorised to edit this sharing request'),
                { status: 403 },
            );
        }

        // Whitelist patchable fields. Status is intentionally NOT here —
        // approve/reject have their own gated endpoints.
        const data = {};
        if (patch.date !== undefined)      data.date      = new Date(patch.date);
        if (patch.endDate !== undefined)   data.endDate   = patch.endDate ? new Date(patch.endDate) : null;
        if (patch.startTime !== undefined) data.startTime = patch.startTime;
        if (patch.endTime !== undefined)   data.endTime   = patch.endTime;
        if (patch.reason !== undefined)    data.reason    = patch.reason || null;
        if (patch.toBranchId !== undefined) data.toBranchId = patch.toBranchId;
        if (patch.fromBranchId !== undefined) data.fromBranchId = patch.fromBranchId;

        if (data.endDate && data.date && data.endDate < data.date) {
            throw Object.assign(new Error('End date must be on or after the start date'), { status: 400 });
        }

        const updated = await prisma.resourceSharing.update({
            where: { id },
            data,
            include: {
                user: { select: { id: true, email: true, role: true,
                    doctor: { select: { fullName: true } },
                    therapist: { select: { fullName: true } },
                } },
                fromBranch: { select: { id: true, name: true } },
                toBranch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[ResourceSharing] Request ${id} edited by ${actor.id}`);
        return updated;
    }

    /**
     * Delete (cancel) a pending sharing request. Permitted for the creator
     * and the source/destination branch admins. Once approved we keep the
     * row for the audit trail and force a CANCELLED status flip via the
     * cancel endpoint instead — but this method only handles deletes for
     * PENDING rows, which is what the form's Delete button targets.
     */
    static async deleteSharingRequest(id, actor) {
        const existing = await prisma.resourceSharing.findUnique({
            where: { id },
            select: {
                id: true, status: true, fromBranchId: true, toBranchId: true,
                createdById: true,
            },
        });
        if (!existing) throw Object.assign(new Error('Sharing request not found'), { status: 404 });
        if (existing.status !== 'PENDING') {
            throw Object.assign(
                new Error(`Cannot delete a ${existing.status.toLowerCase()} request — keep it for audit`),
                { status: 400 },
            );
        }

        const isCreator = !!existing.createdById && existing.createdById === actor.id;
        const isSourceAdmin = actor.role === 'ADMIN_DOCTOR' && actor.branchId === existing.fromBranchId;
        const isTargetAdmin = actor.role === 'ADMIN_DOCTOR' && actor.branchId === existing.toBranchId;
        const isGlobalAdmin = actor.role === 'ADMIN';
        if (!isCreator && !isSourceAdmin && !isTargetAdmin && !isGlobalAdmin) {
            throw Object.assign(
                new Error('You are not authorised to delete this sharing request'),
                { status: 403 },
            );
        }

        await prisma.resourceSharing.delete({ where: { id } });
        logger.info(`[ResourceSharing] Request ${id} deleted by ${actor.id}`);
        return { id, deleted: true };
    }

    /**
     * Internal: throws 403 if the approver isn't authorized for this request.
     */
    static async _assertCanDecide(id, approver) {
        const request = await prisma.resourceSharing.findUnique({
            where: { id },
            select: { id: true, status: true, toBranchId: true, fromBranchId: true },
        });
        if (!request) {
            throw Object.assign(new Error('Sharing request not found'), { status: 404 });
        }
        if (request.status !== 'PENDING') {
            throw Object.assign(
                new Error(`Request is already ${request.status.toLowerCase()} — cannot change`),
                { status: 400 },
            );
        }
        // ADMIN is a global override; ADMIN_DOCTOR is scoped to the receiving branch.
        if (approver.role === 'ADMIN') return;
        if (approver.role === 'ADMIN_DOCTOR' && approver.branchId === request.toBranchId) return;

        throw Object.assign(
            new Error("Only the receiving branch's Admin Doctor (or an Admin) can decide this request"),
            { status: 403 },
        );
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
