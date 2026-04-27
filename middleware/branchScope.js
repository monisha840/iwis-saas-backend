/**
 * branchScope middleware — strict per-branch data isolation for DOCTOR users.
 *
 * Every DOCTOR is permanently scoped to the branch in their JWT (req.user.branchId).
 * They must never see, query, modify, or interact with data from a different branch
 * across any feature, API, or UI surface.
 *
 * This module exports three primitives:
 *
 *   1. requireBranchScoped — route middleware. For DOCTOR requests:
 *        • sets req.branchId from the JWT (never from query/body)
 *        • silently overrides any client-supplied branchId
 *        • audits any mismatch as SUSPICIOUS_ACCESS_ATTEMPT
 *      Other roles pass through with req.branchId === undefined.
 *
 *   2. assertBranchOwnership(entityBranchId, req, opts) — used inside route
 *      handlers after fetching an entity to verify the entity's branchId
 *      matches the doctor's. Returns true if OK, false otherwise. When false,
 *      records a CROSS_BRANCH_ACCESS_ATTEMPT audit and the caller should
 *      respond with branchAccessDenied(res).
 *
 *   3. branchAccessDenied(res) — returns the canonical 403 envelope:
 *        { error: { code: 'BRANCH_ACCESS_DENIED', message: '...' } }
 *
 * ADMIN_DOCTOR is exempt — they retain hospital-scope so cross-branch admin
 * flows (patient assignment, etc.) keep working. Same for ADMIN, SUPER_ADMIN,
 * BRANCH_ADMIN, PHARMACIST, THERAPIST, PATIENT.
 */

import { AuditService } from '../services/audit.service.js';
import logger from '../lib/logger.js';

const SCOPED_ROLES = new Set(['DOCTOR']);

export function isBranchScopedRole(role) {
  return SCOPED_ROLES.has(role);
}

export function branchAccessDenied(res) {
  return res.status(403).json({
    error: {
      code: 'BRANCH_ACCESS_DENIED',
      message: 'You do not have access to data outside your assigned branch.',
    },
  });
}

/**
 * Route middleware. Mount on any router that DOCTOR users can reach.
 * Safe to mount on routers shared with other roles — non-DOCTOR requests
 * are passed through untouched (req.branchId stays undefined).
 */
export function requireBranchScoped(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  if (!isBranchScopedRole(req.user.role)) {
    return next();
  }

  if (!req.user.branchId) {
    // A DOCTOR without a branchId in their JWT is a misconfigured account.
    // The DB CHECK constraint should make this impossible, but defend in depth.
    logger.error('DOCTOR JWT missing branchId — rejecting request', {
      userId: req.user.id,
      route: req.originalUrl,
    });
    return branchAccessDenied(res);
  }

  req.branchId = req.user.branchId;

  // Detect and audit any client-supplied branchId mismatch BEFORE overriding.
  const supplied = pickSuppliedBranchId(req);
  if (supplied != null && String(supplied) !== String(req.user.branchId)) {
    // Fire-and-forget — audit must never block the request.
    AuditService.log({
      userId: req.user.id,
      action: 'SUSPICIOUS_ACCESS_ATTEMPT',
      entityType: 'BranchScope',
      entityId: null,
      newData: {
        route: req.originalUrl,
        method: req.method,
        suppliedBranchId: String(supplied),
        jwtBranchId: req.user.branchId,
      },
    }).catch(() => {});
  }

  // Silently override any client-supplied branchId so downstream handlers that
  // forward query/body fields can't be tricked into a cross-branch query.
  if (req.query && 'branchId' in req.query) {
    req.query.branchId = req.user.branchId;
  }
  if (req.body && typeof req.body === 'object' && 'branchId' in req.body) {
    req.body.branchId = req.user.branchId;
  }

  next();
}

function pickSuppliedBranchId(req) {
  const fromQuery = req.query?.branchId;
  if (fromQuery != null && fromQuery !== '') return fromQuery;
  const fromBody = req.body && typeof req.body === 'object' ? req.body.branchId : null;
  if (fromBody != null && fromBody !== '') return fromBody;
  return null;
}

/**
 * Validate that the loaded entity belongs to the doctor's branch.
 *
 * Usage in a route handler:
 *
 *   const appt = await prisma.appointment.findUnique({ where: { id }, select: { ..., branchId: true } });
 *   if (!appt) return res.status(404).json({ error: 'Not found' });
 *   if (!assertBranchOwnership(appt.branchId, req, { entityType: 'Appointment', entityId: id })) {
 *     return branchAccessDenied(res);
 *   }
 *
 * For non-DOCTOR roles always returns true (no enforcement).
 */
export function assertBranchOwnership(entityBranchId, req, opts = {}) {
  if (!req.user || !isBranchScopedRole(req.user.role)) return true;
  if (!req.branchId) return false;
  if (entityBranchId && String(entityBranchId) === String(req.branchId)) return true;

  AuditService.log({
    userId: req.user.id,
    action: 'CROSS_BRANCH_ACCESS_ATTEMPT',
    entityType: opts.entityType || 'Unknown',
    entityId: opts.entityId || null,
    newData: {
      route: req.originalUrl,
      method: req.method,
      entityBranchId: entityBranchId ? String(entityBranchId) : null,
      jwtBranchId: req.branchId,
    },
  }).catch(() => {});

  return false;
}
