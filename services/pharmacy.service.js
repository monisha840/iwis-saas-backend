import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { inventoryService } from './inventory.service.js';
import { onDispense as onMedicationDispense } from './medicationLifecycle.service.js';

export class PharmacyService {
    static async getAllMedicines(branchId) {
        const medicines = await prisma.medicine.findMany({
            include: {
                stocks: {
                    where: branchId ? { branchId } : {}
                }
            },
            orderBy: { name: 'asc' }
        });
        return medicines.map(med => ({
            ...med,
            totalStock: med.stocks.reduce((sum, stock) => sum + stock.quantity, 0)
        }));
    }

    static async addMedicine(data) {
        const { sku, name, stock, branchId, ...rest } = data;

        // Duplicate SKU check
        if (sku) {
            const existing = await prisma.medicine.findUnique({ where: { sku } });
            if (existing) {
                const error = new Error(`Medicine with SKU ${sku} already exists`);
                error.status = 409;
                throw error;
            }
        }

        try {
            return await prisma.$transaction(async (tx) => {
                const medicine = await tx.medicine.create({
                    data: {
                        ...rest,
                        sku,
                        name,
                        price: parseFloat(data.price)
                    }
                });

                // Create initial stock record if provided
                if (stock !== undefined) {
                    await tx.medicineStock.create({
                        data: {
                            medicineId: medicine.id,
                            batchNumber: `INIT-${Date.now()}`,
                            expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Default 1 year
                            quantity: parseInt(stock),
                            minStock: 10,
                            branchId: branchId || null
                        }
                    });
                }

                logger.audit('ADD_MEDICINE', 'SYSTEM', medicine.id, { sku, name });
                return medicine;
            });
        } catch (error) {
            logger.error('Failed to add medicine:', error);
            if (error.status) throw error;
            throw new Error(`Failed to create medicine: ${error.message}`);
        }
    }

    static async updateMedicine(id, data) {
        const { price, ...rest } = data;
        try {
            return await prisma.medicine.update({
                where: { id },
                data: {
                    ...rest,
                    price: price ? parseFloat(price) : undefined
                }
            });
        } catch (error) {
            logger.error('Failed to update medicine:', error);
            throw error;
        }
    }

    static async addStock(data) {
        return prisma.medicineStock.create({
            data: {
                ...data,
                expiryDate: new Date(data.expiryDate),
                quantity: parseInt(data.quantity),
                minStock: data.minStock ? parseInt(data.minStock) : 10,
                branchId: data.branchId
            }
        });
    }

    static async getLowStockMedicines() {
        return inventoryService.getLowStockMedicines();
    }

    static async dispenseMedicines(userId, data) {
        const { patientId, prescriptionId, items, orderId } = data;

        return prisma.$transaction(async (tx) => {
            let totalAmount = 0;
            const itemsWithPrices = [];

            for (const item of items) {
                const medicine = await tx.medicine.findUnique({ where: { id: item.medicineId } });
                if (!medicine) throw new Error(`Medicine ${item.medicineId} not found`);

                const itemTotalPrice = medicine.price * item.quantity;
                totalAmount += itemTotalPrice;

                itemsWithPrices.push({
                    medicineId: item.medicineId,
                    quantity: item.quantity,
                    unitPrice: medicine.price,
                    totalPrice: itemTotalPrice,
                    stockId: item.stockId,
                    branchId: data.branchId || (await tx.user.findUnique({ where: { id: userId } }))?.branchId
                });
            }

            await inventoryService.deductStock(tx, itemsWithPrices);

            // If a prescription is linked, increment lifecycle counters
            // (dispensedQty is the new source of truth; totalQuantity is
            // kept in sync inside onMedicationDispense for back-compat).
            if (prescriptionId) {
                for (const item of itemsWithPrices) {
                    const prescription = await tx.prescription.findFirst({
                        where: { id: prescriptionId, patientId, medicineId: item.medicineId }
                    });

                    if (prescription) {
                        await onMedicationDispense(tx, prescription.id, item.quantity);
                    }
                }
            }

            return tx.pharmacyDispense.create({
                data: {
                    patientId,
                    prescriptionId,
                    dispensedBy: userId,
                    totalAmount,
                    orderId,
                    items: {
                        create: itemsWithPrices.map(item => ({
                            medicineId: item.medicineId,
                            quantity: item.quantity,
                            unitPrice: item.unitPrice,
                            totalPrice: item.totalPrice
                        }))
                    }
                },
                include: { items: true }
            });
        });
    }

    static async createOrder(userId, data) {
        const { patientId, prescriptionId, items, urgency, notes } = data;

        return prisma.$transaction(async (tx) => {
            let totalAmount = 0;
            const itemsWithPrices = [];

            for (const item of items) {
                const medicine = await tx.medicine.findUnique({ where: { id: item.medicineId } });
                if (!medicine) throw new Error(`Medicine ${item.medicineId} not found`);

                const itemTotalPrice = medicine.price * item.quantity;
                totalAmount += itemTotalPrice;

                itemsWithPrices.push({
                    medicineId: item.medicineId,
                    quantity: item.quantity,
                    unitPrice: medicine.price,
                    totalPrice: itemTotalPrice
                });
            }

            return tx.pharmacyOrder.create({
                data: {
                    patientId,
                    prescriptionId,
                    orderedBy: userId,
                    totalAmount,
                    urgency: urgency || 'NORMAL',
                    notes,
                    branchId: data.branchId || (await tx.user.findUnique({ where: { id: userId } }))?.branchId,
                    items: {
                        create: itemsWithPrices
                    }
                },
                include: { items: { include: { medicine: true } }, patient: true, orderer: true }
            });
        });
    }

    static async getOrders(filters = {}, branchId) {
        const { status, urgency, patientId, page = 1, limit = 20 } = filters;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const take = parseInt(limit);

        const where = {};
        if (status) where.status = status;
        if (urgency) where.urgency = urgency;
        if (patientId) where.patientId = patientId;
        if (branchId) where.branchId = branchId;

        const [orders, total] = await Promise.all([
            prisma.pharmacyOrder.findMany({
                where,
                include: {
                    items: { include: { medicine: true } },
                    patient: { select: { fullName: true, id: true } },
                    orderer: { select: { email: true, role: true } },
                    prescription: { select: { medicationName: true, doctor: { select: { fullName: true } } } }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take
            }),
            prisma.pharmacyOrder.count({ where })
        ]);

        return {
            orders,
            pagination: {
                total,
                page: parseInt(page),
                limit: take,
                totalPages: Math.ceil(total / take)
            }
        };
    }

    static async updateOrderStatus(userId, orderId, status) {
        const order = await prisma.pharmacyOrder.findUnique({
            where: { id: orderId },
            include: { items: true }
        });

        if (!order) throw new Error('Order not found');

        // If status is transitioning to DELIVERED, automatically dispense
        if (status === 'DELIVERED' && order.status !== 'DELIVERED') {
            await this.dispenseMedicines(userId, {
                patientId: order.patientId,
                prescriptionId: order.prescriptionId,
                orderId: order.id,
                items: order.items.map(item => ({
                    medicineId: item.medicineId,
                    quantity: item.quantity
                }))
            });
        }

        const updatedOrder = await prisma.pharmacyOrder.update({
            where: { id: orderId },
            data: { status },
            include: { items: { include: { medicine: true } }, patient: true }
        });

        logger.audit('UPDATE_ORDER_STATUS', userId, orderId, { oldStatus: order.status, newStatus: status });

        return updatedOrder;
    }

    static async getDispenseHistory(branchId, { page = 1, limit = 20 } = {}) {
        const where = branchId ? { branchId } : {};
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const take = parseInt(limit);

        const [dispenses, total] = await Promise.all([
            prisma.pharmacyDispense.findMany({
                where,
                include: {
                    patient: { select: { fullName: true } },
                    dispenser: { select: { email: true } },
                    items: {
                        include: { medicine: { select: { name: true } } }
                    }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take
            }),
            prisma.pharmacyDispense.count({ where })
        ]);

        return {
            data: dispenses,
            total,
            page: parseInt(page),
            limit: take,
            totalPages: Math.ceil(total / take)
        };
    }
}
