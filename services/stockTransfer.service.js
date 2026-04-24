import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * StockTransferService — centralized inventory view and cross-branch stock transfers.
 */
export class StockTransferService {
    /**
     * Get a centralized view of inventory grouped by medicine across all branches.
     */
    static async getCentralizedInventory() {
        const stocks = await prisma.medicineStock.findMany({
            include: {
                medicine: { select: { id: true, name: true, brand: true, category: true } },
                branch: { select: { id: true, name: true } },
            },
        });

        const now = new Date();
        const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        // Group by medicine
        const grouped = {};
        for (const stock of stocks) {
            const medId = stock.medicineId;
            if (!grouped[medId]) {
                grouped[medId] = {
                    medicine: stock.medicine,
                    branches: [],
                };
            }

            // Find existing branch entry or create one
            let branchEntry = grouped[medId].branches.find(
                (b) => b.branchId === stock.branchId
            );
            if (!branchEntry) {
                branchEntry = {
                    branchId: stock.branchId,
                    branchName: stock.branch?.name || 'Unassigned',
                    totalQty: 0,
                    expiringCount: 0,
                };
                grouped[medId].branches.push(branchEntry);
            }

            branchEntry.totalQty += stock.quantity;
            if (stock.expiryDate <= thirtyDaysOut) {
                branchEntry.expiringCount += stock.quantity;
            }
        }

        return Object.values(grouped);
    }

    /**
     * Create a stock transfer request between branches.
     */
    static async createTransferRequest(medicineId, fromBranchId, toBranchId, quantity, requestedBy, notes) {
        const transfer = await prisma.stockTransfer.create({
            data: {
                medicineId,
                fromBranchId,
                toBranchId,
                quantity,
                requestedBy,
                notes,
                status: 'PENDING',
            },
            include: {
                medicine: { select: { id: true, name: true } },
                fromBranch: { select: { id: true, name: true } },
                toBranch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[StockTransfer] Transfer request ${transfer.id}: ${quantity}x ${medicineId} from ${fromBranchId} → ${toBranchId}`);
        return transfer;
    }

    /**
     * Approve a pending transfer request.
     */
    static async approveTransfer(id, approvedBy) {
        const transfer = await prisma.stockTransfer.update({
            where: { id },
            data: { status: 'APPROVED', approvedBy },
            include: {
                medicine: { select: { id: true, name: true } },
                fromBranch: { select: { id: true, name: true } },
                toBranch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[StockTransfer] Transfer ${id} approved by ${approvedBy}`);
        return transfer;
    }

    /**
     * Mark transfer as received — actually move stock quantities between branches.
     */
    static async receiveTransfer(id) {
        const transfer = await prisma.stockTransfer.findUnique({ where: { id } });
        if (!transfer) throw new Error('Transfer not found');
        if (transfer.status !== 'APPROVED') throw new Error('Transfer must be approved before receiving');

        // Use a transaction to atomically move stock
        const result = await prisma.$transaction(async (tx) => {
            // Deduct from source branch — find the stock batch(es)
            const sourceStocks = await tx.medicineStock.findMany({
                where: {
                    medicineId: transfer.medicineId,
                    branchId: transfer.fromBranchId,
                    quantity: { gt: 0 },
                },
                orderBy: { expiryDate: 'asc' }, // FEFO: first-expiry-first-out
            });

            let remaining = transfer.quantity;
            for (const batch of sourceStocks) {
                if (remaining <= 0) break;
                const deduct = Math.min(batch.quantity, remaining);
                // Guarded update: only decrement if the batch still has enough
                // stock. A concurrent dispense against the same batch cannot
                // race us into a negative quantity.
                const res = await tx.medicineStock.updateMany({
                    where: { id: batch.id, quantity: { gte: deduct } },
                    data: { quantity: { decrement: deduct } },
                });
                if (res.count === 0) {
                    throw new Error('Stock batch changed during transfer — retry');
                }
                remaining -= deduct;
            }

            if (remaining > 0) {
                throw new Error(`Insufficient stock: short by ${remaining} units`);
            }

            // Add to destination branch. Upsert on (medicineId, branchId, batchNumber)
            // so idempotent retries of the same transfer receipt don't create
            // duplicate rows.
            const sourceBatch = sourceStocks[0];
            const destBatchNumber = `TRANSFER-${id}`;
            await tx.medicineStock.upsert({
                where: {
                    medicineId_branchId_batchNumber: {
                        medicineId: transfer.medicineId,
                        branchId: transfer.toBranchId,
                        batchNumber: destBatchNumber,
                    },
                },
                update: { quantity: { increment: transfer.quantity } },
                create: {
                    medicineId: transfer.medicineId,
                    branchId: transfer.toBranchId,
                    batchNumber: destBatchNumber,
                    expiryDate: sourceBatch.expiryDate,
                    quantity: transfer.quantity,
                },
            });

            // Mark transfer as received
            return tx.stockTransfer.update({
                where: { id },
                data: { status: 'RECEIVED' },
                include: {
                    medicine: { select: { id: true, name: true } },
                    fromBranch: { select: { id: true, name: true } },
                    toBranch: { select: { id: true, name: true } },
                },
            });
        });

        logger.info(`[StockTransfer] Transfer ${id} received — ${transfer.quantity} units moved`);
        return result;
    }

    /**
     * List transfers with optional filters + pagination.
     */
    static async getTransfers({ branchId, status, page = 1, limit = 20 }) {
        const where = {};
        if (branchId) {
            where.OR = [{ fromBranchId: branchId }, { toBranchId: branchId }];
        }
        if (status) where.status = status;

        const skip = (page - 1) * limit;

        const [data, total] = await Promise.all([
            prisma.stockTransfer.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    medicine: { select: { id: true, name: true } },
                    fromBranch: { select: { id: true, name: true } },
                    toBranch: { select: { id: true, name: true } },
                },
            }),
            prisma.stockTransfer.count({ where }),
        ]);

        return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
    }
}
