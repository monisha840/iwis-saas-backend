/**
 * PharmacyRepository — DB access for MedicineStock, PharmacyOrder, PharmacyDispense, Medicine.
 *
 * Centralises all inventory + dispensing queries to a single low-coupling layer.
 */

import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { getCurrentTenant } from '../lib/tenantContext.js';
import { BaseRepository } from './base.repository.js';

export class PharmacyRepository extends BaseRepository {
  get model() {
    return prisma.medicineStock;
  }

  // ── Medicine ─────────────────────────────────────────────────────────────

  async findMedicines({ where = {}, page = 1, limit = 20 } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (safePage - 1) * safeLimit;

    const [medicines, total] = await prisma.$transaction([
      prisma.medicine.findMany({
        where,
        include: { stocks: { where: { quantity: { gt: 0 } }, select: { quantity: true, branchId: true } } },
        orderBy: { name: 'asc' },
        skip,
        take: safeLimit,
      }),
      prisma.medicine.count({ where }),
    ]);

    return { medicines, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
  }

  // ── MedicineStock ─────────────────────────────────────────────────────────

  async findStockByBranch(branchId, { lowStockOnly = false } = {}) {
    return prisma.medicineStock.findMany({
      where: {
        branchId,
        ...(lowStockOnly && {
          quantity: { lte: prisma.medicineStock.fields.minStock },
        }),
      },
      include: { medicine: true },
      orderBy: [{ medicine: { name: 'asc' } }],
    });
  }

  async findLowStock(branchId = null) {
    // Phase 1 tenant scope: when a request tenant is set, never return stock
    // outside the caller's hospital (a null branchId must NOT mean all hospitals).
    const tenant = getCurrentTenant();
    const branchClause = branchId ? Prisma.sql`AND ms."branchId" = ${branchId}` : Prisma.empty;
    const tenantClause = tenant
      ? Prisma.sql`AND ms."branchId" IN (SELECT id FROM "Branch" WHERE "hospitalId" = ${tenant})`
      : Prisma.empty;
    return prisma.$queryRaw`
      SELECT ms.*, m.name, m.brand
      FROM "MedicineStock" ms
      JOIN "Medicine" m ON ms."medicineId" = m.id
      WHERE ms.quantity <= ms."minStock"
        ${branchClause}
        ${tenantClause}
      ORDER BY (ms.quantity::float / NULLIF(ms."minStock", 0)) ASC
    `;
  }

  async adjustStock(stockId, quantityDelta, tx = prisma) {
    return tx.medicineStock.update({
      where: { id: stockId },
      data: { quantity: { increment: quantityDelta } },
    });
  }

  // ── PharmacyOrder ─────────────────────────────────────────────────────────

  async createOrder(data, items) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.pharmacyOrder.create({
        data: {
          ...data,
          items: { create: items },
        },
        include: { items: { include: { medicine: true } }, patient: true },
      });
      return order;
    });
  }

  async findOrdersByBranch(branchId, { status, page = 1, limit = 20 } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (safePage - 1) * safeLimit;
    const where = { branchId, ...(status && { status }) };

    const [orders, total] = await prisma.$transaction([
      prisma.pharmacyOrder.findMany({
        where,
        include: { items: { include: { medicine: true } }, patient: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      prisma.pharmacyOrder.count({ where }),
    ]);

    return { orders, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
  }

  // ── PharmacyDispense ─────────────────────────────────────────────────────

  async createDispense(data, items, stockAdjustments) {
    return prisma.$transaction(async (tx) => {
      const dispense = await tx.pharmacyDispense.create({
        data: {
          ...data,
          items: { create: items },
        },
        include: { items: { include: { medicine: true } }, patient: true },
      });

      // Deduct stock atomically in the same transaction
      for (const { stockId, quantity } of stockAdjustments) {
        await tx.medicineStock.update({
          where: { id: stockId },
          data: { quantity: { decrement: quantity } },
        });
      }

      return dispense;
    });
  }
}

export const pharmacyRepository = new PharmacyRepository();
