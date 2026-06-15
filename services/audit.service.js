/**
 * AuditService — persists structured audit trails to the AuditLog table.
 *
 * Covers all critical mutations:
 *   DELETE operations, blocking availability, approving/cancelling appointments,
 *   user role changes, pharmacy dispenses, and any action flagged via the helper.
 *
 * The AuditLog schema already exists — this service provides the write path.
 *
 * Usage:
 *   await AuditService.log({ userId, action, entityType, entityId, oldData, newData });
 *
 * Or in a route/controller:
 *   await AuditService.log(req, 'DELETE_APPOINTMENT', 'Appointment', id, oldRecord);
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { getCurrentTenant } from '../lib/tenantContext.js';

export class AuditService {
  /**
   * Write a single audit entry.
   *
   * @param {Object} opts
   * @param {string|null}  opts.userId      - ID of the acting user (null for system)
   * @param {string}       opts.action      - e.g. 'DELETE_APPOINTMENT', 'BLOCK_AVAILABILITY'
   * @param {string}       opts.entityType  - Prisma model name, e.g. 'Appointment'
   * @param {string|null}  opts.entityId    - PK of the affected record
   * @param {object|null}  opts.oldData     - Snapshot before mutation
   * @param {object|null}  opts.newData     - Snapshot after mutation (or diff)
   * @param {object}       opts.meta        - Extra context (IP, userAgent, etc.)
   */
  static async log({ userId = null, action, entityType, entityId = null, oldData = null, newData = null, meta = {}, hospitalId = undefined }) {
    try {
      // Always stamp the tenant for a complete per-hospital audit trail
      // (healthcare compliance). Prefer an explicit hospitalId (e.g. a
      // SUPER_ADMIN acting on a specific hospital); otherwise use the current
      // request tenant. Stays null for genuine system/no-tenant actions.
      const tenantId = hospitalId ?? getCurrentTenant() ?? undefined;
      await prisma.auditLog.create({
        data: {
          userId,
          action,
          entityType,
          entityId,
          oldData: oldData ?? undefined,
          newData: newData ?? undefined,
          hospitalId: tenantId,
        },
      });

      logger.audit(action, userId, entityId, { entityType, ...meta });
    } catch (err) {
      // Audit failure must never crash the main flow — log and continue
      logger.error('[AuditService] Failed to write audit log', err, { action, entityType, entityId });
    }
  }

  /**
   * Convenience: log a "delete" action — captures old record automatically.
   */
  static async logDelete({ userId, entityType, entityId, record, meta }) {
    return AuditService.log({
      userId,
      action: `DELETE_${entityType.toUpperCase()}`,
      entityType,
      entityId,
      oldData: record,
      meta,
    });
  }

  /**
   * Convenience: log an "update" action with before/after snapshots.
   */
  static async logUpdate({ userId, entityType, entityId, oldData, newData, action, meta }) {
    return AuditService.log({
      userId,
      action: action || `UPDATE_${entityType.toUpperCase()}`,
      entityType,
      entityId,
      oldData,
      newData,
      meta,
    });
  }

  /**
   * Convenience: log a status transition (e.g. appointment approval/rejection).
   */
  static async logStatusChange({ userId, entityType, entityId, oldStatus, newStatus, meta }) {
    return AuditService.log({
      userId,
      action: `STATUS_CHANGE_${entityType.toUpperCase()}`,
      entityType,
      entityId,
      oldData: { status: oldStatus },
      newData: { status: newStatus },
      meta,
    });
  }

  /**
   * Retrieve audit trail for a specific entity.
   */
  static async getTrail({ entityType, entityId, limit = 50 }) {
    return prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: {
          select: { id: true, email: true, role: true },
        },
      },
    });
  }

  /**
   * Retrieve the user-level activity log for admin dashboards.
   */
  static async getUserActivity({ userId, limit = 100, action }) {
    return prisma.auditLog.findMany({
      where: {
        userId,
        ...(action && { action }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Recent system-wide audit events for the admin dashboard "Activity Feed".
   *
   * Optionally hospital-scoped by joining through `user.hospitalId`. For events
   * with no userId (system actions) we surface them tenant-agnostically so the
   * feed never silently drops them.
   *
   * Returns a denormalised, dashboard-friendly shape so the frontend can render
   * each row without extra lookups.
   */
  static async getRecentActivity({ hospitalId = null, limit = 20, entityTypes } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const where = {};
    if (Array.isArray(entityTypes) && entityTypes.length) {
      where.entityType = { in: entityTypes };
    }
    if (hospitalId) {
      where.OR = [
        { userId: null },
        { user: { hospitalId } },
      ];
    }
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: cap,
      include: {
        user: {
          select: {
            id: true, email: true, role: true,
            doctor: { select: { fullName: true } },
            therapist: { select: { fullName: true } },
            patient: { select: { fullName: true } },
          },
        },
      },
    });
    return rows.map((r) => {
      const actorName = r.user
        ? (r.user.doctor?.fullName ||
           r.user.therapist?.fullName ||
           r.user.patient?.fullName ||
           r.user.email)
        : 'System';
      return {
        id:         r.id,
        action:     r.action,
        entityType: r.entityType,
        entityId:   r.entityId,
        createdAt:  r.createdAt,
        actor:      { id: r.user?.id || null, name: actorName, role: r.user?.role || 'SYSTEM' },
        oldData:    r.oldData,
        newData:    r.newData,
      };
    });
  }
}
