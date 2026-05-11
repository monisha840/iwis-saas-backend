// Revenue dashboard route — admin / admin-doctor view of today's billing.
//
// Aggregates Invoice + Payment rows for the requested date and breaks the
// total down into appointment / medicine / package buckets, plus an hourly
// timeline and a recent-transactions list. Returns zeros + empty arrays
// when no data exists (the frontend handles empty state gracefully).

import express from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const todaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  branchId: z.string().optional(),
});

router.get(
  '/today',
  authMiddleware,
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
  validate({ query: todaySchema }),
  async (req, res, next) => {
    try {
      // Resolve the day window: query.date overrides; otherwise local "today".
      const dateStr = typeof req.query.date === 'string' ? req.query.date : null;
      const dayStart = dateStr ? new Date(`${dateStr}T00:00:00.000Z`) : new Date();
      if (!dateStr) dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      // ADMIN_DOCTOR is hospital-scoped (no JWT branch pin); only filter
      // when an explicit branchId is supplied.
      const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : null;
      const branchFilter = branchId ? { branchId } : {};

      // Pull invoices for the day with items + patient + payments. Same range
      // for payments (in case payments exist without an invoice — e.g. legacy
      // appointment-fee captures).
      const [invoices, payments] = await Promise.all([
        prisma.invoice.findMany({
          where: {
            createdAt: { gte: dayStart, lt: dayEnd },
            ...branchFilter,
          },
          include: {
            items: { select: { medicineId: true, totalPrice: true } },
            patient: { select: { id: true, fullName: true } },
            packageEnrolment: { select: { id: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.payment.findMany({
          where: {
            createdAt: { gte: dayStart, lt: dayEnd },
            ...branchFilter,
          },
          select: {
            id: true,
            amount: true,
            createdAt: true,
            status: true,
            patient: { select: { fullName: true } },
            invoice: { select: { id: true, packageEnrolmentId: true, items: { select: { medicineId: true } } } },
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      // ── Bucket invoices into appointment / medicine / package ─────────────
      let appointmentRevenue = 0;
      let medicineRevenue = 0;
      let packageRevenue = 0;
      let paidCount = 0;
      let pendingCount = 0;

      for (const inv of invoices) {
        const isPaid = inv.status === 'PAID';
        const isPending = inv.status === 'UNPAID' || inv.status === 'PARTIALLY_PAID';
        if (isPaid) paidCount += 1;
        if (isPending) pendingCount += 1;

        if (inv.packageEnrolment) {
          packageRevenue += inv.netAmount;
          continue;
        }
        // Split per item: medicine items vs everything else (consult fee).
        let medSubtotal = 0;
        let nonMedSubtotal = 0;
        for (const it of inv.items) {
          if (it.medicineId) medSubtotal += it.totalPrice;
          else nonMedSubtotal += it.totalPrice;
        }
        // If items don't fully cover the netAmount (tax/discount applied),
        // attribute the residual to whichever bucket has a positive subtotal.
        const itemSum = medSubtotal + nonMedSubtotal;
        const residual = inv.netAmount - itemSum;
        if (itemSum > 0) {
          medicineRevenue += medSubtotal + (medSubtotal > 0 && nonMedSubtotal === 0 ? residual : 0);
          appointmentRevenue += nonMedSubtotal + (nonMedSubtotal > 0 ? residual : 0);
        } else {
          appointmentRevenue += inv.netAmount;
        }
      }

      // ── Hourly breakdown over Payment.createdAt ───────────────────────────
      const hourlyMap = new Map();
      for (let h = 0; h < 24; h += 1) hourlyMap.set(h, 0);
      for (const p of payments) {
        const h = p.createdAt.getHours();
        hourlyMap.set(h, (hourlyMap.get(h) || 0) + p.amount);
      }
      const hourlyBreakdown = [...hourlyMap.entries()]
        .filter(([h]) => h >= 7 && h <= 21) // 7 AM → 9 PM clinic window
        .map(([h, amount]) => ({
          hour: `${String(h).padStart(2, '0')}:00`,
          amount: Math.round(amount),
        }));

      // ── Recent transactions: latest 20 payments ───────────────────────────
      const recentTransactions = payments.slice(0, 20).map((p) => {
        const inv = p.invoice;
        const t = inv?.packageEnrolmentId
          ? 'PACKAGE'
          : inv?.items?.some((i) => i.medicineId)
          ? 'MEDICINE'
          : 'APPOINTMENT';
        return {
          id: p.id,
          patientName: p.patient?.fullName ?? 'Unknown',
          amount: Math.round(p.amount),
          type: t,
          status: p.status,
          time: p.createdAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        };
      });

      const totalRevenue = payments
        .filter((p) => (p.status || '').toUpperCase() === 'COMPLETED' || (p.status || '').toUpperCase() === 'PAID')
        .reduce((s, p) => s + p.amount, 0);

      res.json({
        data: {
          today: {
            totalRevenue: Math.round(totalRevenue),
            appointmentRevenue: Math.round(appointmentRevenue),
            medicineRevenue: Math.round(medicineRevenue),
            packageRevenue: Math.round(packageRevenue),
            invoiceCount: invoices.length,
            paidCount,
            pendingCount,
          },
          recentTransactions,
          hourlyBreakdown,
        },
      });
    } catch (err) { next(err); }
  },
);

export default router;
