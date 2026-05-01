import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';

/**
 * RewardStoreService — manages reward items and redemptions.
 * Clinicians spend XP (from ClinicianXP.totalXP), patients spend zenPoints.
 */
export class RewardStoreService {
    /**
     * Get all active reward items.
     */
    static async getAvailableRewards() {
        return prisma.rewardItem.findMany({
            where: { isActive: true },
            orderBy: { pointsCost: 'asc' },
        });
    }

    /**
     * Redeem a reward.
     *
     * Atomic by construction: the balance debit, stock decrement, and
     * redemption insert all live inside a single Prisma transaction. The
     * debits use conditional `updateMany`s (compare-and-swap) so two
     * concurrent redemptions can't both pass the balance/stock check —
     * one will see an update count of 0 and we throw, rolling back.
     *
     * Idempotency: a user with an existing PENDING redemption for the same
     * reward gets a 409 instead of a duplicate row, which prevents network
     * retries from double-charging.
     */
    static async redeemReward(userId, rewardId) {
        const cost = await prisma.rewardItem.findUnique({
            where: { id: rewardId },
            select: { pointsCost: true, isActive: true, stock: true, name: true },
        });
        if (!cost || !cost.isActive) {
            throw Object.assign(new Error('Reward not found or inactive'), { status: 404 });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { role: true },
        });
        const role = user?.role;
        const isClinician = role === 'DOCTOR' || role === 'THERAPIST';
        const isPatient = role === 'PATIENT';
        if (!isClinician && !isPatient) {
            throw Object.assign(new Error('Your role cannot redeem rewards'), { status: 403 });
        }

        const redemption = await prisma.$transaction(async (tx) => {
            // Idempotency: refuse a second PENDING for the same (user, reward)
            // pair so a retried POST returns 409 rather than a duplicate row.
            const existingPending = await tx.rewardRedemption.findFirst({
                where: { userId, rewardId, status: 'PENDING' },
                select: { id: true },
            });
            if (existingPending) {
                throw Object.assign(
                    new Error('You already have a pending redemption for this reward'),
                    { status: 409 },
                );
            }

            // Stock CAS — only decrement when stock is null (unlimited) or > 0.
            // If stock is null we don't touch the row at all.
            if (cost.stock !== null) {
                const stockUpdate = await tx.rewardItem.updateMany({
                    where: { id: rewardId, isActive: true, stock: { gt: 0 } },
                    data: { stock: { decrement: 1 } },
                });
                if (stockUpdate.count === 0) {
                    throw Object.assign(new Error('Reward is out of stock'), { status: 400 });
                }
            }

            // Balance CAS — clinician XP or patient zenPoints. If 0 rows match
            // the balance is below cost; throw so the transaction rolls back
            // (which also un-decrements the stock CAS above).
            if (isClinician) {
                const debit = await tx.clinicianXP.updateMany({
                    where: { userId, totalXP: { gte: cost.pointsCost } },
                    data: { totalXP: { decrement: cost.pointsCost } },
                });
                if (debit.count === 0) {
                    const xp = await tx.clinicianXP.findUnique({
                        where: { userId },
                        select: { totalXP: true },
                    });
                    const have = xp?.totalXP ?? 0;
                    throw Object.assign(
                        new Error(`Insufficient XP. You have ${have}, need ${cost.pointsCost}`),
                        { status: 400 },
                    );
                }
            } else {
                const patient = await tx.patient.findUnique({
                    where: { userId },
                    select: { id: true, zenPoints: true },
                });
                if (!patient) {
                    throw Object.assign(new Error('Patient profile not found'), { status: 404 });
                }
                const debit = await tx.patient.updateMany({
                    where: { id: patient.id, zenPoints: { gte: cost.pointsCost } },
                    data: { zenPoints: { decrement: cost.pointsCost } },
                });
                if (debit.count === 0) {
                    throw Object.assign(
                        new Error(`Insufficient zen points. You have ${patient.zenPoints}, need ${cost.pointsCost}`),
                        { status: 400 },
                    );
                }
            }

            return tx.rewardRedemption.create({
                data: {
                    userId,
                    rewardId,
                    pointsSpent: cost.pointsCost,
                    status: 'PENDING',
                },
                include: { reward: true },
            });
        });

        emitToUser(userId, 'reward_redeemed', {
            rewardName: cost.name,
            pointsSpent: cost.pointsCost,
            status: 'PENDING',
        });

        logger.info(`[RewardStoreService] User ${userId} redeemed "${cost.name}" for ${cost.pointsCost} points`);
        return redemption;
    }

    /**
     * Admin queue — paginated list of redemptions across all users with the
     * given status (default PENDING). Used by the Reward Store admin panel
     * to triage pending requests; previously the panel reused the caller's
     * own `getUserRedemptions` payload, which only worked for participants.
     */
    static async listAllRedemptions({ status = 'PENDING', page = 1, limit = 50 } = {}) {
        const where = status ? { status } : {};
        const skip = (Math.max(1, page) - 1) * Math.max(1, limit);

        const [redemptions, total] = await Promise.all([
            prisma.rewardRedemption.findMany({
                where,
                orderBy: { createdAt: 'asc' }, // oldest first — admins should clear the backlog
                skip,
                take: Math.min(200, limit),
                include: {
                    reward: true,
                    user: {
                        select: {
                            id: true, email: true, role: true,
                            doctor:    { select: { fullName: true } },
                            therapist: { select: { fullName: true } },
                            patient:   { select: { fullName: true } },
                        },
                    },
                },
            }),
            prisma.rewardRedemption.count({ where }),
        ]);

        const flat = redemptions.map((r) => ({
            ...r,
            user: {
                id:       r.user?.id,
                email:    r.user?.email,
                role:     r.user?.role,
                fullName: r.user?.doctor?.fullName
                       ?? r.user?.therapist?.fullName
                       ?? r.user?.patient?.fullName
                       ?? r.user?.email
                       ?? null,
            },
        }));

        return {
            redemptions: flat,
            pagination: { page, limit, total, totalPages: Math.ceil(total / Math.max(1, limit)) },
        };
    }

    /**
     * Get a user's redemption history (paginated).
     */
    static async getUserRedemptions(userId, { page = 1, limit = 20 } = {}) {
        const skip = (page - 1) * limit;

        const [redemptions, total] = await Promise.all([
            prisma.rewardRedemption.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                include: { reward: true },
            }),
            prisma.rewardRedemption.count({ where: { userId } }),
        ]);

        return {
            redemptions,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        };
    }

    /**
     * Process a redemption (admin approve/reject).
     *
     * REJECTED branches must refund balance + restore stock atomically with
     * the status flip — otherwise a crash between the status update and the
     * refund would leave the user permanently debited. Uses `updateMany`
     * with a status='PENDING' guard so two concurrent admins can't both
     * approve and double-refund.
     */
    static async processRedemption(redemptionId, status, processedBy) {
        const updated = await prisma.$transaction(async (tx) => {
            const redemption = await tx.rewardRedemption.findUnique({
                where: { id: redemptionId },
                include: { reward: true },
            });
            if (!redemption) {
                throw Object.assign(new Error('Redemption not found'), { status: 404 });
            }
            if (redemption.status !== 'PENDING') {
                throw Object.assign(
                    new Error(`Redemption already ${redemption.status.toLowerCase()}`),
                    { status: 400 },
                );
            }

            // CAS the status flip — count==0 means another admin beat us to it.
            const flip = await tx.rewardRedemption.updateMany({
                where: { id: redemptionId, status: 'PENDING' },
                data: { status, processedBy, processedAt: new Date() },
            });
            if (flip.count === 0) {
                throw Object.assign(
                    new Error('Redemption was processed by another admin'),
                    { status: 409 },
                );
            }

            if (status === 'REJECTED') {
                const user = await tx.user.findUnique({
                    where: { id: redemption.userId },
                    select: { role: true },
                });
                if (user?.role === 'DOCTOR' || user?.role === 'THERAPIST') {
                    await tx.clinicianXP.update({
                        where: { userId: redemption.userId },
                        data: { totalXP: { increment: redemption.pointsSpent } },
                    });
                } else if (user?.role === 'PATIENT') {
                    await tx.patient.update({
                        where: { userId: redemption.userId },
                        data: { zenPoints: { increment: redemption.pointsSpent } },
                    });
                }
                if (redemption.reward.stock !== null) {
                    await tx.rewardItem.update({
                        where: { id: redemption.rewardId },
                        data: { stock: { increment: 1 } },
                    });
                }
            }

            return tx.rewardRedemption.findUnique({
                where: { id: redemptionId },
                include: { reward: true },
            });
        });

        emitToUser(updated.userId, 'redemption_processed', {
            rewardName: updated.reward.name,
            status,
        });

        logger.info(`[RewardStoreService] Redemption ${redemptionId} ${status} by ${processedBy}`);
        return updated;
    }

    /**
     * Create a new reward item (admin).
     */
    static async createReward(data) {
        const reward = await prisma.rewardItem.create({ data });
        logger.info(`[RewardStoreService] Created reward "${reward.name}"`);
        return reward;
    }

    /**
     * Update a reward item (admin).
     */
    static async updateReward(id, data) {
        const reward = await prisma.rewardItem.update({ where: { id }, data });
        logger.info(`[RewardStoreService] Updated reward "${reward.name}"`);
        return reward;
    }
}
