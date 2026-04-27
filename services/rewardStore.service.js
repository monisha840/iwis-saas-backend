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
     * Redeem a reward. Checks balance and deducts points/XP.
     */
    static async redeemReward(userId, rewardId) {
        const reward = await prisma.rewardItem.findUnique({ where: { id: rewardId } });
        if (!reward || !reward.isActive) {
            throw Object.assign(new Error('Reward not found or inactive'), { status: 404 });
        }

        // Check stock
        if (reward.stock !== null && reward.stock <= 0) {
            throw Object.assign(new Error('Reward is out of stock'), { status: 400 });
        }

        // Determine user type and check balance
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { role: true },
        });

        if (['DOCTOR', 'THERAPIST'].includes(user.role)) {
            // Clinician: check ClinicianXP totalXP
            const xpProfile = await prisma.clinicianXP.findUnique({ where: { userId } });
            const totalXP = xpProfile?.totalXP || 0;

            if (totalXP < reward.pointsCost) {
                throw Object.assign(new Error(`Insufficient XP. You have ${totalXP}, need ${reward.pointsCost}`), { status: 400 });
            }

            // Deduct XP
            await prisma.clinicianXP.update({
                where: { userId },
                data: { totalXP: { decrement: reward.pointsCost } },
            });
        } else if (user.role === 'PATIENT') {
            // Patient: check zenPoints
            const patient = await prisma.patient.findUnique({
                where: { userId },
                select: { id: true, zenPoints: true },
            });

            if (!patient) {
                throw Object.assign(new Error('Patient profile not found'), { status: 404 });
            }

            if (patient.zenPoints < reward.pointsCost) {
                throw Object.assign(new Error(`Insufficient zen points. You have ${patient.zenPoints}, need ${reward.pointsCost}`), { status: 400 });
            }

            // Deduct zen points
            await prisma.patient.update({
                where: { id: patient.id },
                data: { zenPoints: { decrement: reward.pointsCost } },
            });
        } else {
            throw Object.assign(new Error('Your role cannot redeem rewards'), { status: 403 });
        }

        // Decrement stock if applicable
        if (reward.stock !== null) {
            await prisma.rewardItem.update({
                where: { id: rewardId },
                data: { stock: { decrement: 1 } },
            });
        }

        // Create redemption record
        const redemption = await prisma.rewardRedemption.create({
            data: {
                userId,
                rewardId,
                pointsSpent: reward.pointsCost,
                status: 'PENDING',
            },
            include: { reward: true },
        });

        emitToUser(userId, 'reward_redeemed', {
            rewardName: reward.name,
            pointsSpent: reward.pointsCost,
            status: 'PENDING',
        });

        logger.info(`[RewardStoreService] User ${userId} redeemed "${reward.name}" for ${reward.pointsCost} points`);
        return redemption;
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
     */
    static async processRedemption(redemptionId, status, processedBy) {
        const redemption = await prisma.rewardRedemption.findUnique({ where: { id: redemptionId } });
        if (!redemption) {
            throw Object.assign(new Error('Redemption not found'), { status: 404 });
        }

        if (redemption.status !== 'PENDING') {
            throw Object.assign(new Error(`Redemption already ${redemption.status.toLowerCase()}`), { status: 400 });
        }

        const updated = await prisma.rewardRedemption.update({
            where: { id: redemptionId },
            data: {
                status,
                processedBy,
                processedAt: new Date(),
            },
            include: { reward: true },
        });

        // If rejected, refund the points
        if (status === 'REJECTED') {
            const user = await prisma.user.findUnique({
                where: { id: redemption.userId },
                select: { role: true },
            });

            if (['DOCTOR', 'THERAPIST'].includes(user.role)) {
                await prisma.clinicianXP.update({
                    where: { userId: redemption.userId },
                    data: { totalXP: { increment: redemption.pointsSpent } },
                });
            } else if (user.role === 'PATIENT') {
                await prisma.patient.update({
                    where: { userId: redemption.userId },
                    data: { zenPoints: { increment: redemption.pointsSpent } },
                });
            }

            // Restore stock
            const reward = await prisma.rewardItem.findUnique({ where: { id: redemption.rewardId } });
            if (reward?.stock !== null) {
                await prisma.rewardItem.update({
                    where: { id: redemption.rewardId },
                    data: { stock: { increment: 1 } },
                });
            }
        }

        emitToUser(redemption.userId, 'redemption_processed', {
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
