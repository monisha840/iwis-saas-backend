/**
 * auditLog middleware — automatically records audit entries for critical HTTP mutations.
 *
 * Mount on specific routers (DELETE, sensitive PUTs) rather than globally
 * to avoid noisy logs for read-only endpoints.
 *
 * Usage in a route file:
 *   import { auditAction } from '../middleware/auditLog.js';
 *
 *   router.delete('/:id',
 *     authMiddleware,
 *     roleMiddleware(['ADMIN']),
 *     auditAction('DELETE_APPOINTMENT', 'Appointment', (req) => req.params.id),
 *     async (req, res, next) => { ... }
 *   );
 */

import { AuditService } from '../services/audit.service.js';
import logger from '../lib/logger.js';

/**
 * Factory that creates an audit middleware for a specific action.
 *
 * @param {string}   action         - Audit action label, e.g. 'DELETE_APPOINTMENT'
 * @param {string}   entityType     - Prisma model name, e.g. 'Appointment'
 * @param {Function} getEntityId    - Extracts entityId from req, e.g. (req) => req.params.id
 * @param {Function} [getOldData]   - Optionally supply the before-snapshot. Async-safe.
 */
export function auditAction(action, entityType, getEntityId, getOldData = null) {
  return async (req, res, next) => {
    // Intercept the response to capture the after-state
    const originalJson = res.json.bind(res);
    let responseBody = null;

    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };

    // Capture before-state if supplier provided
    let oldData = null;
    if (getOldData) {
      try {
        oldData = await getOldData(req);
      } catch (e) {
        logger.warn('[auditLog] Failed to capture oldData', { action, entityType });
      }
    }

    // After response is sent, write the audit log (non-blocking)
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const entityId = getEntityId ? getEntityId(req) : null;
        AuditService.log({
          userId: req.user?.id ?? null,
          action,
          entityType,
          entityId,
          oldData,
          newData: responseBody,
          meta: {
            method: req.method,
            url: req.originalUrl,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          },
        }).catch((err) => logger.error('[auditLog] Background write failed', err));
      }
    });

    next();
  };
}

/**
 * Convenience wrappers for the most common critical actions.
 */
export const auditDelete = (entityType, getId = (req) => req.params.id, getOldData = null) =>
  auditAction(`DELETE_${entityType.toUpperCase()}`, entityType, getId, getOldData);

export const auditApprove = (entityType, getId = (req) => req.params.id) =>
  auditAction(`APPROVE_${entityType.toUpperCase()}`, entityType, getId);

export const auditBlockSlot = (getId = (req) => req.params.id) =>
  auditAction('BLOCK_AVAILABILITY', 'BlockedSlot', getId);
