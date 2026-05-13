import express from 'express';
import multer from 'multer';
import { unlink } from 'fs/promises';
import { z } from 'zod';
import { PharmacyService } from '../services/pharmacy.service.js';
import { MedicineImportService } from '../services/medicineImport.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditAction } from '../middleware/auditLog.js';
import prisma from '../lib/prisma.js';

const csvUpload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = file.mimetype === 'text/csv'
            || file.mimetype === 'application/vnd.ms-excel'
            || file.originalname.toLowerCase().endsWith('.csv');
        cb(ok ? null : new Error('Only CSV files are allowed'), ok);
    },
});

const router = express.Router();

const medicineSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    sku: z.string().min(1, 'SKU is required'),
    category: z.string().min(1, 'Category is required'),
    type: z.string().min(1, 'Type is required'),
    brand: z.string().optional(),
    manufacturer: z.string().optional(),
    composition: z.string().optional(),
    description: z.string().optional(),
    riskLevel: z.string().optional(),
    // Optional YouTube URL for patient education / dosage instructions.
    // Service-level validator (assertYouTubeUrl) enforces the URL is YouTube.
    videoUrl: z.string().optional().nullable(),
    stock: z.number().or(z.string()).transform(v => typeof v === 'string' ? parseInt(v) : v).refine(v => v >= 0 && v <= 100000, { message: 'Stock must be between 0 and 100,000' }).optional().default(0),
    price: z.number().or(z.string()).transform(v => typeof v === 'string' ? parseFloat(v) : v),
});

// Coerce truthy/falsey strings without choking on undefined.
const boolish = z.preprocess(
    (v) => v === undefined ? undefined : (v === 'true' || v === true ? true : v === 'false' || v === false ? false : v),
    z.boolean().optional(),
);

const inventorySearchSchema = z.object({
    q: z.string().optional(),
    category: z.string().optional(),
    type: z.string().optional(),
    manufacturer: z.string().optional(),
    riskLevel: z.string().optional(),
    availability: z.enum(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK']).optional(),
    hasVideo: boolish,
    expiringInDays: z.string().optional().transform(v => v ? parseInt(v, 10) : undefined),
    priceMin: z.string().optional().transform(v => v ? parseFloat(v) : undefined),
    priceMax: z.string().optional().transform(v => v ? parseFloat(v) : undefined),
    sortBy: z.enum(['name', 'price', 'totalStock', 'createdAt', 'sku', 'category']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    page: z.string().optional().transform(v => v ? parseInt(v, 10) : undefined),
    limit: z.string().optional().transform(v => v ? parseInt(v, 10) : undefined),
    branchId: z.string().optional(),
});

const positiveInt = z.number().or(z.string())
    .transform(v => typeof v === 'string' ? parseInt(v) : v)
    .refine(v => Number.isInteger(v) && v > 0, { message: 'Must be a positive integer' })
    .refine(v => v <= 100000, { message: 'Quantity cannot exceed 100,000' });

const stockSchema = z.object({
    medicineId: z.string(),
    batchNumber: z.string(),
    expiryDate: z.string(),
    quantity: positiveInt,
    minStock: z.number().or(z.string()).optional().transform(v => v ? (typeof v === 'string' ? parseInt(v) : v) : 10),
    location: z.string().optional(),
});

const dispenseSchema = z.object({
    patientId: z.string(),
    prescriptionId: z.string().optional(),
    items: z.array(z.object({
        medicineId: z.string(),
        quantity: z.number().int().positive().max(10000),
        stockId: z.string().optional(),
    })).min(1, 'At least one item is required'),
});

const orderStatusSchema = z.object({
    status: z.enum(['PENDING', 'APPROVED', 'DISPATCHED', 'DELIVERED', 'CANCELLED']),
});

const orderSchema = z.object({
    patientId: z.string(),
    prescriptionId: z.string().optional(),
    items: z.array(z.object({
        medicineId: z.string(),
        quantity: z.number(),
    })),
    urgency: z.enum(['NORMAL', 'URGENT', 'CRITICAL']).optional(),
    notes: z.string().optional(),
});

const listOrdersSchema = z.object({
    page: z.string().optional().transform(v => v ? parseInt(v) : 1),
    limit: z.string().optional().transform(v => v ? parseInt(v) : 20),
    status: z.string().optional(),
    branchId: z.string().optional(),
});

router.get('/medicines', authMiddleware, roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), async (req, res, next) => {
    try {
        // Admins (no personal branch) may pass branchId to scope to a specific branch.
        // Branch-scoped users (pharmacists etc.) always see their own branch.
        const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'ADMIN_DOCTOR';
        const branchId = isAdmin ? (req.query.branchId || null) : req.user.branchId;
        const data = await PharmacyService.getAllMedicines(branchId);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

// Advanced inventory search — superset of /medicines that supports text
// search, categorical filters, availability buckets, and a paginated
// envelope with facet counts. UI uses this for the new filter controls.
router.get('/medicines/search', authMiddleware, roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), validate({ query: inventorySearchSchema }), async (req, res, next) => {
    try {
        const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'ADMIN_DOCTOR';
        const branchId = isAdmin ? (req.query.branchId || null) : req.user.branchId;
        const data = await PharmacyService.searchMedicines(branchId, req.query);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

// Distinct attribute lists for the inventory filter dropdowns. Light
// query — used to populate <Select> options from the actual data set.
router.get('/medicines/filter-options', authMiddleware, roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), async (req, res, next) => {
    try {
        const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'ADMIN_DOCTOR';
        const branchId = isAdmin ? (req.query.branchId || null) : req.user.branchId;
        const data = await PharmacyService.getInventoryFilterOptions(branchId);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

router.post('/medicines', authMiddleware, roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR']), validate({ body: medicineSchema }), async (req, res, next) => {
    try {
        const data = { ...req.body, branchId: req.user.branchId };
        const medicine = await PharmacyService.addMedicine(data);
        res.status(201).json(medicine);
    } catch (err) {
        next(err);
    }
});

router.put('/medicines/:id', authMiddleware, roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR']), validate({ body: medicineSchema.partial() }), async (req, res, next) => {
    try {
        const data = await PharmacyService.updateMedicine(req.params.id, req.body);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

// Delete is admin-only and gated on active-prescription usage so we don't
// orphan a medication a patient is mid-course on. Active = not discontinued.
router.delete('/medicines/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const { id } = req.params;
        const activePrescriptions = await prisma.prescription.count({
            where: { medicineId: id, discontinuedAt: null },
        });
        if (activePrescriptions > 0) {
            return res.status(409).json({
                error: {
                    code: 'MEDICINE_IN_USE',
                    message: 'Cannot delete: medicine has active prescriptions. Discontinue them or wait for the courses to end.',
                },
            });
        }
        await prisma.medicine.delete({ where: { id } });
        res.json({ data: { message: 'Medicine deleted successfully' } });
    } catch (err) {
        // Prisma P2025 = record not found.
        if (err?.code === 'P2025') {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Medicine not found' } });
        }
        next(err);
    }
});

router.post(
    '/medicines/bulk-upload',
    authMiddleware,
    roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR']),
    csvUpload.single('file'),
    async (req, res, next) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
            const preview = await MedicineImportService.previewImport(req.file.path, req.user);
            await unlink(req.file.path).catch(() => { });
            res.json({ success: true, ...preview });
        } catch (err) {
            if (req.file) await unlink(req.file.path).catch(() => { });
            next(err);
        }
    }
);

router.post(
    '/medicines/bulk-import',
    authMiddleware,
    roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR']),
    auditAction('BULK_IMPORT_MEDICINES', 'Medicine', () => null),
    async (req, res, next) => {
        try {
            const { rows } = req.body;
            if (!Array.isArray(rows) || rows.length === 0) {
                return res.status(400).json({ error: 'rows must be a non-empty array' });
            }
            const summary = await MedicineImportService.executeImport(req.user.id, rows);
            res.json({ success: true, summary });
        } catch (err) {
            next(err);
        }
    }
);

router.post('/stock', authMiddleware, roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR']), validate({ body: stockSchema }), async (req, res, next) => {
    try {
        const data = await PharmacyService.addStock(req.body);
        res.status(201).json(data);
    } catch (err) {
        next(err);
    }
});

router.get('/stock/low', authMiddleware, roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const data = await PharmacyService.getLowStockMedicines(req.user.branchId);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

router.post('/dispense', authMiddleware, roleMiddleware(['PHARMACIST', 'ADMIN_DOCTOR']), validate({ body: dispenseSchema }), auditAction('PHARMACY_DISPENSE', 'PharmacyDispense', () => null), async (req, res, next) => {
    try {
        const data = await PharmacyService.dispenseMedicines(req.user.id, req.body);
        res.status(201).json(data);
    } catch (err) {
        next(err);
    }
});

router.get('/dispenses', authMiddleware, roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'ADMIN_DOCTOR';
        const branchId = isAdmin ? (req.query.branchId || null) : req.user.branchId;
        const data = await PharmacyService.getDispenseHistory(branchId, { page, limit });
        res.json(data);
    } catch (err) {
        next(err);
    }
});

router.post('/orders', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']), validate({ body: orderSchema }), async (req, res, next) => {
    try {
        const data = await PharmacyService.createOrder(req.user.id, req.body);
        res.status(201).json(data);
    } catch (err) {
        next(err);
    }
});

router.get('/orders', authMiddleware, validate({ query: listOrdersSchema }), async (req, res, next) => {
    try {
        const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'ADMIN_DOCTOR';
        const branchId = isAdmin ? (req.query.branchId || null) : req.user.branchId;
        const data = await PharmacyService.getOrders(req.query, branchId);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

router.patch('/orders/:id/status', authMiddleware, roleMiddleware(['PHARMACIST', 'ADMIN', 'ADMIN_DOCTOR']), validate({ body: orderStatusSchema }), async (req, res, next) => {
    try {
        const { status } = req.body;
        const data = await PharmacyService.updateOrderStatus(req.user.id, req.params.id, status);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

export default router;
