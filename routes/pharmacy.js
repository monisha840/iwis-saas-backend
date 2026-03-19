import express from 'express';
import { z } from 'zod';
import { PharmacyService } from '../services/pharmacy.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const medicineSchema = z.object({
    name: z.string(),
    brand: z.string().optional(),
    category: z.string().optional(),
    manufacturer: z.string().optional(),
    composition: z.string().optional(),
    description: z.string().optional(),
    price: z.number().or(z.string()).transform(v => typeof v === 'string' ? parseFloat(v) : v),
});

const stockSchema = z.object({
    medicineId: z.string(),
    batchNumber: z.string(),
    expiryDate: z.string(),
    quantity: z.number().or(z.string()).transform(v => typeof v === 'string' ? parseInt(v) : v),
    minStock: z.number().or(z.string()).optional().transform(v => v ? (typeof v === 'string' ? parseInt(v) : v) : 10),
    location: z.string().optional(),
});

const dispenseSchema = z.object({
    patientId: z.string(),
    prescriptionId: z.string().optional(),
    items: z.array(z.object({
        medicineId: z.string(),
        quantity: z.number(),
        stockId: z.string().optional(),
    })),
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
});

router.get('/medicines', authMiddleware, async (req, res, next) => {
    try {
        const data = await PharmacyService.getAllMedicines(req.user.branchId);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

router.post('/medicines', authMiddleware, roleMiddleware(['ADMIN', 'PHARMACIST', 'ADMIN_DOCTOR']), validate({ body: medicineSchema }), async (req, res, next) => {
    try {
        const data = await PharmacyService.addMedicine(req.body);
        res.status(201).json(data);
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

router.post('/dispense', authMiddleware, roleMiddleware(['PHARMACIST', 'ADMIN', 'ADMIN_DOCTOR']), validate({ body: dispenseSchema }), async (req, res, next) => {
    try {
        const data = await PharmacyService.dispenseMedicines(req.user.id, req.body);
        res.status(201).json(data);
    } catch (err) {
        next(err);
    }
});

router.get('/dispenses', authMiddleware, async (req, res, next) => {
    try {
        const data = await PharmacyService.getDispenseHistory(req.user.branchId);
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
        const data = await PharmacyService.getOrders(req.query, req.user.branchId);
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
