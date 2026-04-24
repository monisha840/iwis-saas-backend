import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { inventoryService } from './inventory.service.js';
import { onDispense as onMedicationDispense } from './medicationLifecycle.service.js';

// Patient-facing instructional videos must come from YouTube to keep the
// origin allow-list short (CSP, oEmbed thumbnails, embed-iframe contract).
// Returns the canonical 11-char YouTube video id, or null when the input
// is empty / not a YouTube URL.
export function extractYouTubeId(raw) {
    if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const u = new URL(raw.trim());
        const host = u.hostname.replace(/^www\./, '');
        let candidate = null;
        if (host === 'youtu.be') {
            candidate = u.pathname.slice(1).split(/[/?&]/)[0];
        } else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
            if (u.pathname === '/watch') {
                candidate = u.searchParams.get('v');
            } else if (u.pathname.startsWith('/embed/')) {
                candidate = u.pathname.split('/embed/')[1]?.split(/[/?&]/)[0];
            } else if (u.pathname.startsWith('/shorts/')) {
                candidate = u.pathname.split('/shorts/')[1]?.split(/[/?&]/)[0];
            } else if (u.pathname.startsWith('/v/')) {
                candidate = u.pathname.split('/v/')[1]?.split(/[/?&]/)[0];
            }
        }
        if (candidate && /^[\w-]{11}$/.test(candidate)) return candidate;
        return null;
    } catch {
        return null;
    }
}

// Throws a 400 on a non-empty value that is NOT a recognisable YouTube URL.
// Empty / null / undefined are accepted so the field stays optional.
export function assertYouTubeUrl(value) {
    if (value === undefined || value === null || value === '') return null;
    const id = extractYouTubeId(value);
    if (!id) {
        const err = new Error('videoUrl must be a YouTube URL (youtube.com/watch?v=…, youtu.be/…, /shorts/…, /embed/…)');
        err.status = 400;
        throw err;
    }
    return value.trim();
}

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

    /**
     * Advanced search over the medicine inventory. Supports text search,
     * categorical filters, stock availability, expiry window, and a
     * has-instructional-video toggle. Results are paginated and include
     * a facets payload so the UI can render filter chip counts without
     * a second round-trip.
     *
     * Filter contract (all optional unless noted):
     *   q              — case-insensitive substring across name/sku/brand/manufacturer/composition
     *   category       — exact match
     *   type           — exact match (e.g. Tablet, Capsule, Syrup)
     *   manufacturer   — exact match
     *   riskLevel      — exact match (LOW/MEDIUM/HIGH for ATC-like risk)
     *   availability   — IN_STOCK | LOW_STOCK | OUT_OF_STOCK (computed from per-batch sums)
     *   hasVideo       — boolean — only medicines with a YouTube videoUrl set
     *   expiringInDays — integer (1..365) — at least one batch expires within N days
     *   priceMin/Max   — float
     *   sortBy         — name | price | totalStock | createdAt
     *   sortOrder      — asc | desc
     *   page / limit   — pagination (default 1 / 30, max 200)
     */
    static async searchMedicines(branchId, filters = {}) {
        const {
            q, category, type, manufacturer, riskLevel,
            availability, hasVideo, expiringInDays,
            priceMin, priceMax,
            sortBy = 'name', sortOrder = 'asc',
            page = 1, limit = 30,
        } = filters;

        const pageInt = Math.max(1, parseInt(page, 10) || 1);
        const limitInt = Math.min(200, Math.max(1, parseInt(limit, 10) || 30));

        // Base where (column-level filters that Prisma can apply
        // directly). Stock-derived filters (availability,
        // expiringInDays) need a post-fetch reduce because Prisma
        // doesn't support filtering on `_sum` of a relation in a single
        // findMany.
        const where = {};
        if (q && q.trim()) {
            where.OR = [
                { name:           { contains: q.trim(), mode: 'insensitive' } },
                { sku:            { contains: q.trim(), mode: 'insensitive' } },
                { brand:          { contains: q.trim(), mode: 'insensitive' } },
                { manufacturer:   { contains: q.trim(), mode: 'insensitive' } },
                { composition:    { contains: q.trim(), mode: 'insensitive' } },
            ];
        }
        if (category)     where.category     = category;
        if (type)         where.type         = type;
        if (manufacturer) where.manufacturer = manufacturer;
        if (riskLevel)    where.riskLevel    = riskLevel;
        if (hasVideo === true || hasVideo === 'true') {
            where.videoUrl = { not: null };
        }
        if (priceMin !== undefined && priceMin !== null && priceMin !== '') {
            where.price = { ...(where.price || {}), gte: parseFloat(priceMin) };
        }
        if (priceMax !== undefined && priceMax !== null && priceMax !== '') {
            where.price = { ...(where.price || {}), lte: parseFloat(priceMax) };
        }

        // Validate sort column to avoid arbitrary string injection.
        const sortableColumns = new Set(['name', 'price', 'createdAt', 'sku', 'category']);
        const orderColumn = sortableColumns.has(sortBy) ? sortBy : 'name';
        const orderDir = sortOrder === 'desc' ? 'desc' : 'asc';

        // Fetch matching medicines + their stocks. We over-fetch the
        // matching set (capped at 1000) so post-filtering on
        // computed fields stays correct. Real query volume is small
        // (clinic-scale), so this is fine.
        const matched = await prisma.medicine.findMany({
            where,
            include: {
                stocks: {
                    where: branchId ? { branchId } : {},
                    select: { id: true, quantity: true, minStock: true, expiryDate: true, batchNumber: true },
                },
            },
            orderBy: orderColumn === 'name' || orderColumn === 'price' || orderColumn === 'createdAt' || orderColumn === 'sku' || orderColumn === 'category'
                ? { [orderColumn]: orderDir }
                : { name: 'asc' },
            take: 1000,
        });

        const expiringWindowMs = expiringInDays
            ? Math.max(0, parseInt(expiringInDays, 10)) * 24 * 60 * 60 * 1000
            : null;
        const now = Date.now();

        const enriched = matched.map(med => {
            const totalStock = med.stocks.reduce((sum, s) => sum + s.quantity, 0);
            const minStock = med.stocks[0]?.minStock ?? 10;
            const status = totalStock === 0 ? 'OUT_OF_STOCK'
                : totalStock <= minStock ? 'LOW_STOCK'
                : 'IN_STOCK';
            const nearestExpiry = med.stocks.length
                ? med.stocks.reduce((min, s) => s.expiryDate < min ? s.expiryDate : min, med.stocks[0].expiryDate)
                : null;
            const expiringSoon = expiringWindowMs !== null && nearestExpiry
                ? (nearestExpiry.getTime() - now) <= expiringWindowMs
                : null;
            return {
                ...med,
                totalStock,
                availabilityStatus: status,
                nearestExpiry,
                hasVideo: !!med.videoUrl,
                youtubeId: med.videoUrl ? extractYouTubeId(med.videoUrl) : null,
                expiringSoon,
            };
        });

        // Stock-based + expiry filters (post-aggregation)
        const filtered = enriched.filter(m => {
            if (availability && m.availabilityStatus !== availability) return false;
            if (expiringWindowMs !== null && !m.expiringSoon) return false;
            return true;
        });

        // Sort by totalStock when requested (Prisma can't sort by an
        // aggregated field of a related table directly).
        if (sortBy === 'totalStock') {
            filtered.sort((a, b) => orderDir === 'desc' ? b.totalStock - a.totalStock : a.totalStock - b.totalStock);
        }

        // Facets — pre-pagination counts so the chip badges always
        // reflect the FULL filtered set, not just the visible page.
        const facets = {
            availability: filtered.reduce((acc, m) => {
                acc[m.availabilityStatus] = (acc[m.availabilityStatus] || 0) + 1;
                return acc;
            }, { IN_STOCK: 0, LOW_STOCK: 0, OUT_OF_STOCK: 0 }),
            withVideo: filtered.filter(m => m.hasVideo).length,
        };

        const total = filtered.length;
        const start = (pageInt - 1) * limitInt;
        const pageRows = filtered.slice(start, start + limitInt);

        return {
            medicines: pageRows,
            facets,
            pagination: {
                total,
                page: pageInt,
                limit: limitInt,
                totalPages: Math.max(1, Math.ceil(total / limitInt)),
            },
        };
    }

    /**
     * Distinct attribute lists used to populate filter dropdowns. Cached
     * server-side per request via the calling route layer if needed.
     */
    static async getInventoryFilterOptions(branchId) {
        const medicines = await prisma.medicine.findMany({
            where: branchId ? { stocks: { some: { branchId } } } : {},
            select: { category: true, type: true, manufacturer: true, riskLevel: true },
            take: 5000,
        });
        const dedup = (key) => Array.from(new Set(medicines.map(m => m[key]).filter(Boolean))).sort();
        return {
            categories:    dedup('category'),
            types:         dedup('type'),
            manufacturers: dedup('manufacturer'),
            riskLevels:    dedup('riskLevel'),
        };
    }

    static async addMedicine(data) {
        const { sku, name, stock, branchId, videoUrl, ...rest } = data;

        // Duplicate SKU check
        if (sku) {
            const existing = await prisma.medicine.findUnique({ where: { sku } });
            if (existing) {
                const error = new Error(`Medicine with SKU ${sku} already exists`);
                error.status = 409;
                throw error;
            }
        }

        const cleanVideoUrl = assertYouTubeUrl(videoUrl);

        try {
            return await prisma.$transaction(async (tx) => {
                const medicine = await tx.medicine.create({
                    data: {
                        ...rest,
                        sku,
                        name,
                        videoUrl: cleanVideoUrl,
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
        const { price, videoUrl, ...rest } = data;
        // videoUrl is optional on update — only validate when the
        // caller actually sends the field (allows empty-string clear).
        const videoUrlPatch = videoUrl === undefined
            ? {}
            : { videoUrl: videoUrl === '' || videoUrl === null ? null : assertYouTubeUrl(videoUrl) };
        try {
            return await prisma.medicine.update({
                where: { id },
                data: {
                    ...rest,
                    ...videoUrlPatch,
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
