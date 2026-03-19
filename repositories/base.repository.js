/**
 * BaseRepository — shared CRUD primitives for all domain repositories.
 *
 * Every repository extends this class and provides a `model` getter
 * that returns the Prisma delegate (e.g. prisma.appointment).
 *
 * Advantages over calling prisma directly in services:
 *  • Consistent error surface (Prisma errors converted in one place)
 *  • Pagination helpers standardised across all resources
 *  • Easy to replace with a mock in unit tests
 *  • Single location to add cross-cutting concerns (soft delete, tenant filter)
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

export class BaseRepository {
  /** @returns {import('@prisma/client').PrismaClient[string]} */
  get model() {
    throw new Error('BaseRepository.model must be overridden in subclass');
  }

  /**
   * Find a single record by primary key.
   * @param {string} id
   * @param {object} [include]
   */
  async findById(id, include = undefined) {
    return this.model.findUnique({ where: { id }, ...(include && { include }) });
  }

  /**
   * Find first record matching where clause.
   */
  async findOne(where, include = undefined) {
    return this.model.findFirst({ where, ...(include && { include }) });
  }

  /**
   * Paginated findMany with consistent response shape.
   *
   * @returns {{ data: T[], total: number, page: number, limit: number, totalPages: number }}
   */
  async findMany({ where = {}, include = undefined, orderBy = undefined, page = 1, limit = 20, select = undefined } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await prisma.$transaction([
      this.model.findMany({
        where,
        ...(include && { include }),
        ...(select && { select }),
        ...(orderBy && { orderBy }),
        skip,
        take: safeLimit,
      }),
      this.model.count({ where }),
    ]);

    return {
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  /**
   * Create a record.
   */
  async create(data, include = undefined) {
    return this.model.create({ data, ...(include && { include }) });
  }

  /**
   * Update a record by PK.
   */
  async update(id, data, include = undefined) {
    return this.model.update({ where: { id }, data, ...(include && { include }) });
  }

  /**
   * Soft-delete: set deletedAt if the model supports it, otherwise hard-delete.
   */
  async delete(id) {
    try {
      // Try soft delete first
      return await this.model.update({ where: { id }, data: { deletedAt: new Date() } });
    } catch {
      // Fall back to hard delete if model has no deletedAt
      return this.model.delete({ where: { id } });
    }
  }

  /**
   * Hard delete — use explicitly when soft-delete is not appropriate.
   */
  async hardDelete(id) {
    return this.model.delete({ where: { id } });
  }

  /**
   * Run multiple operations in a single Prisma transaction.
   * @param {Function} fn - receives (tx: PrismaClient) and returns a promise
   */
  async transaction(fn) {
    return prisma.$transaction(fn);
  }

  /**
   * Check existence without loading the full record.
   */
  async exists(where) {
    const count = await this.model.count({ where });
    return count > 0;
  }
}
