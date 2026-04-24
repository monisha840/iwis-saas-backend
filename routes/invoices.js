import express from 'express';
import { z } from 'zod';
import { InvoiceService } from '../services/invoice.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = express.Router();
router.use(authenticateToken);

const itemSchema = z.object({
    description: z.string().min(1),
    quantity:    z.coerce.number().positive(),
    unitPrice:   z.coerce.number().nonnegative(),
    medicineId:  z.string().optional(),
});

const createSchema = z.object({
    patientId:     z.string(),
    branchId:      z.string().optional(),
    appointmentId: z.string().optional(),
    items:         z.array(itemSchema).min(1),
    tax:           z.coerce.number().nonnegative().optional(),
    discount:      z.coerce.number().nonnegative().optional(),
    notes:         z.string().optional(),
    dueDate:       z.coerce.date().optional(),
});

const paymentSchema = z.object({
    amount:        z.coerce.number().positive(),
    method:        z.string().min(1),
    transactionId: z.string().optional(),
});

// Patient's own invoices — must come before /:id
router.get('/my', async (req, res, next) => {
    try {
        // Resolve patient.id from the authenticated user
        const patient = await prisma.patient.findUnique({ where: { userId: req.user.id } });
        if (!patient) return res.json([]);
        res.json(await InvoiceService.listForPatient(patient.id));
    } catch (err) { next(err); }
});

router.get('/', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR'), async (req, res, next) => {
    try {
        const { status, patientId, branchId, page, limit } = req.query;
        res.json(await InvoiceService.list({ status, patientId, branchId, page, limit }));
    } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
    try {
        const inv = await InvoiceService.getById(req.params.id);
        if (!inv) return res.status(404).json({ error: 'Invoice not found' });
        // Patients may only read their own invoices
        if (req.user.role === 'PATIENT') {
            const patient = await prisma.patient.findUnique({ where: { userId: req.user.id } });
            if (!patient || patient.id !== inv.patientId) return res.status(403).json({ error: 'Forbidden' });
        }
        res.json(inv);
    } catch (err) { next(err); }
});

router.post('/', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR'), async (req, res, next) => {
    try {
        const data = createSchema.parse(req.body);
        res.status(201).json(await InvoiceService.create(data));
    } catch (err) { next(err); }
});

router.patch('/:id/status', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR'), async (req, res, next) => {
    try {
        const status = String(req.body.status || '').toUpperCase();
        if (!['UNPAID','PARTIAL','PAID','CANCELLED'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        res.json(await InvoiceService.updateStatus(req.params.id, status));
    } catch (err) { next(err); }
});

router.post('/:id/payments', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'PHARMACIST'), async (req, res, next) => {
    try {
        const data = paymentSchema.parse(req.body);
        res.status(201).json(await InvoiceService.recordPayment(req.params.id, data));
    } catch (err) { next(err); }
});

export default router;
