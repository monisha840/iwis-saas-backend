import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

class InventoryService {
    /**
     * Check current stock levels for a medicine by name.
     * @param {string} name - The name of the medicine.
     * @returns {Promise<object>} - Stock status object.
     */
    async checkStockByMedicineName(name, branchId) {
        try {
            const medicine = await prisma.medicine.findFirst({
                where: { name: { equals: name, mode: 'insensitive' } },
                include: {
                    stocks: {
                        where: branchId ? { branchId } : {}
                    }
                }
            });

            if (!medicine) {
                return { available: false, quantity: 0, reason: 'Medicine not found' };
            }

            const totalQuantity = medicine.stocks.reduce((sum, s) => sum + s.quantity, 0);
            const minStock = medicine.stocks[0]?.minStock || 10;

            return {
                available: totalQuantity > 0,
                quantity: totalQuantity,
                lowStock: totalQuantity <= minStock,
                medicineId: medicine.id,
                price: medicine.price
            };
        } catch (error) {
            logger.error('Error checking stock:', error);
            throw error;
        }
    }

    /**
     * Deduct stock for a list of items within a transaction.
     * @param {object} tx - Prisma transaction client.
     * @param {Array} items - List of items { medicineId, quantity, stockId (optional) }.
     */
    async deductStock(tx, items) {
        for (const item of items) {
            if (item.stockId) {
                // Deduct from specific batch — guarded so we can't go negative
                // under concurrent dispenses against the same batch.
                const res = await tx.medicineStock.updateMany({
                    where: { id: item.stockId, quantity: { gte: item.quantity } },
                    data: { quantity: { decrement: item.quantity } }
                });
                if (res.count === 0) {
                    throw new Error(`Insufficient stock for batch ${item.stockId}`);
                }
            } else {
                // Auto-pick batches (FIFO: oldest first by expiry)
                let remainingToDeduct = item.quantity;
                const stocks = await tx.medicineStock.findMany({
                    where: {
                        medicineId: item.medicineId,
                        quantity: { gt: 0 },
                        branchId: item.branchId // Enforce branch deduction
                    },
                    orderBy: { expiryDate: 'asc' }
                });

                if (stocks.reduce((sum, s) => sum + s.quantity, 0) < item.quantity) {
                    throw new Error(`Insufficient total stock for medicine ${item.medicineId}`);
                }

                for (const stock of stocks) {
                    if (remainingToDeduct === 0) break;
                    const deductFromThisStock = Math.min(stock.quantity, remainingToDeduct);
                    // Guarded decrement: refuse to go negative if a concurrent
                    // transaction already drained this batch.
                    const res = await tx.medicineStock.updateMany({
                        where: { id: stock.id, quantity: { gte: deductFromThisStock } },
                        data: { quantity: { decrement: deductFromThisStock } }
                    });
                    if (res.count === 0) {
                        throw new Error(`Stock batch ${stock.id} changed during dispense — retry`);
                    }
                    const updatedStock = await tx.medicineStock.findUnique({ where: { id: stock.id } });
                    remainingToDeduct -= deductFromThisStock;

                    // Trigger low stock alert if needed
                    if (updatedStock.quantity <= updatedStock.minStock) {
                        try {
                            const medicine = await tx.medicine.findUnique({ where: { id: item.medicineId } });
                            // We import notificationService dynamically to avoid circular dependencies
                            const { notificationService } = await import('./notification.service.js');
                            await notificationService.sendLowStockAlert(medicine.name, updatedStock.quantity);
                        } catch (notifyErr) {
                            logger.warn('Failed to send low stock alert:', notifyErr.message);
                        }
                    }
                }
            }
        }
    }

    /**
     * Get all medicines that are low on stock.
     */
    async getLowStockMedicines(branchId) {
        // This is a bit complex in Prisma due to aggregate filters
        const medicines = await prisma.medicine.findMany({
            include: {
                stocks: {
                    where: branchId ? { branchId } : {}
                }
            }
        });

        return medicines.filter(med => {
            const total = med.stocks.reduce((sum, s) => sum + s.quantity, 0);
            const min = med.stocks[0]?.minStock || 10;
            return total <= min;
        });
    }
}

export const inventoryService = new InventoryService();
