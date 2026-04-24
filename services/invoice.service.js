import prisma from '../lib/prisma.js';

/**
 * Invoice & Payment management.
 * Backs the Billing page and records package-enrolment auto-invoices.
 */
export class InvoiceService {
    static async list({ status, patientId, branchId, page = 1, limit = 20 }) {
        const where = {
            ...(status ? { status } : {}),
            ...(patientId ? { patientId } : {}),
            ...(branchId ? { branchId } : {}),
        };
        const take = Math.min(Number(limit) || 20, 100);
        const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

        const [rows, total] = await Promise.all([
            prisma.invoice.findMany({
                where,
                include: {
                    items: true,
                    payments: true,
                    patient: { select: { id: true, fullName: true, patientId: true } },
                    branch: { select: { id: true, name: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip, take,
            }),
            prisma.invoice.count({ where }),
        ]);

        return { data: rows, total, page: Number(page) || 1, totalPages: Math.max(1, Math.ceil(total / take)) };
    }

    static async getById(id) {
        return prisma.invoice.findUnique({
            where: { id },
            include: {
                items: true,
                payments: true,
                patient: { select: { id: true, fullName: true, patientId: true, phoneNumber: true } },
                branch: { select: { id: true, name: true } },
                packageEnrolment: { include: { package: true } },
            },
        });
    }

    static async listForPatient(patientId) {
        return prisma.invoice.findMany({
            where: { patientId },
            include: { items: true, payments: true },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Create a manual invoice. Package-enrolment auto-invoices go through
     * TreatmentPackageService and bypass this path.
     */
    static async create({ patientId, items = [], tax = 0, discount = 0, notes, dueDate, branchId, appointmentId }) {
        const totalAmount = items.reduce((sum, it) => sum + (Number(it.quantity) * Number(it.unitPrice)), 0);
        const taxAmount   = Number(tax) || 0;
        const discountAmt = Number(discount) || 0;
        const netAmount   = totalAmount + taxAmount - discountAmt;

        return prisma.invoice.create({
            data: {
                patientId, branchId, totalAmount, taxAmount, discount: discountAmt, netAmount,
                status: 'UNPAID',
                dueDate: dueDate ? new Date(dueDate) : null,
                items: {
                    create: items.map((it) => ({
                        description: it.description,
                        quantity: Number(it.quantity),
                        unitPrice: Number(it.unitPrice),
                        totalPrice: Number(it.quantity) * Number(it.unitPrice),
                        medicineId: it.medicineId || null,
                    })),
                },
            },
            include: { items: true, payments: true },
        });
    }

    static async updateStatus(id, status) {
        return prisma.invoice.update({ where: { id }, data: { status }, include: { items: true, payments: true } });
    }

    /**
     * Record a payment against an invoice. Auto-transitions the invoice status
     * to PAID when cumulative payments cover the net amount.
     */
    static async recordPayment(invoiceId, { amount, method, transactionId }) {
        return prisma.$transaction(async (tx) => {
            const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true } });
            if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });

            const payment = await tx.payment.create({
                data: {
                    patientId: invoice.patientId,
                    invoiceId,
                    amount: Number(amount),
                    paymentMethod: method,
                    transactionId: transactionId || null,
                    status: 'COMPLETED',
                    branchId: invoice.branchId,
                }
            });

            const paid = invoice.payments.reduce((s, p) => s + (p.amount || 0), 0) + Number(amount);
            const newStatus = paid >= invoice.netAmount ? 'PAID' : 'PARTIAL';
            await tx.invoice.update({ where: { id: invoiceId }, data: { status: newStatus } });
            return payment;
        });
    }
}
