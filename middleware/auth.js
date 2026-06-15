import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import logger from '../lib/logger.js';
import prisma from '../lib/prisma.js';
import { AuthService } from '../services/auth.service.js';
import { checkHospitalStatus } from './checkHospitalStatus.js';
import { runWithTenant } from '../lib/tenantContext.js';

export function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });

  jwt.verify(token, config.jwt.secret, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });

    if (user.purpose && user.purpose !== 'access') {
      return res.status(401).json({ error: 'Invalid token purpose' });
    }

    // JTI blacklist check (best-effort — if Redis is down, allow through)
    if (user.jti) {
      try {
        const blacklisted = await AuthService.isJtiBlacklisted(user.jti);
        if (blacklisted) {
          return res.status(401).json({ error: 'Token has been revoked' });
        }
      } catch {
        // Redis unavailable — allow through
      }
    }

    try {
      const dbUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { tokensRevokedAt: true },
      });
      if (dbUser?.tokensRevokedAt && user.iat && user.iat * 1000 < dbUser.tokensRevokedAt.getTime()) {
        return res.status(401).json({ error: 'Token has been revoked' });
      }
    } catch {
      // DB unavailable — allow through
    }

    // IP binding: warn if token IP differs from request IP (do not block)
    const requestIp = req.ip || req.connection?.remoteAddress;
    if (user.ip && user.ip !== requestIp) {
      logger.warn('Token IP mismatch', {
        userId: user.id,
        tokenIp: user.ip,
        requestIp,
        requestId: req.id
      });
    }

    req.user = user;
    // Hospital status gate — SUPER_ADMIN bypasses; suspended tenants 403.
    // Then bind the resolved hospitalId to the async context so the Prisma
    // extension auto-scopes every downstream query. SUPER_ADMIN leaves
    // hospitalId unset → runWithTenant(null) → unscoped (sees all hospitals).
    // The wrapper forwards errors so checkHospitalStatus's error path isn't lost.
    checkHospitalStatus(req, res, (err) =>
      err ? next(err) : runWithTenant(req.user.hospitalId ?? null, next)
    );
  });
}

// Accepts either variadic args — roleMiddleware('DOCTOR', 'ADMIN_DOCTOR') — or a
// single array — roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR']). Both are in use
// across the codebase. Previously the signature was `(roles)`, which silently
// kept only the first positional arg and matched roles as a substring — e.g.
// `'DOCTOR'.includes('ADMIN_DOCTOR')` returned false, rejecting admin-doctors.
export function roleMiddleware(...args) {
  const roles = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

export async function resolvePatientId(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Missing token' });
    if (req.user.patientId) return next();
    const patient = await prisma.patient.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: 'Patient profile not found' });
    req.user.patientId = patient.id;
    next();
  } catch (err) {
    next(err);
  }
}

/** Resolve req.user.doctorProfileId from User.id → Doctor.id. Required by
 *  routes that scope to "the calling doctor" — e.g. their own queue. Skips
 *  the lookup if already populated. Roles without a doctor profile are
 *  passed through unchanged so middleware order is forgiving. */
export async function resolveDoctorId(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Missing token' });
    if (req.user.doctorProfileId) return next();
    if (req.user.role !== 'DOCTOR' && req.user.role !== 'ADMIN_DOCTOR') return next();
    const doctor = await prisma.doctor.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (doctor) req.user.doctorProfileId = doctor.id;
    next();
  } catch (err) {
    next(err);
  }
}

/** Resolve req.user.branchId from User.branchId. Already in the JWT for
 *  most users, but kept as a fallback for tokens issued before
 *  branch-scoping was added. */
export async function resolveBranchId(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Missing token' });
    if (req.user.branchId !== undefined) return next();
    const u = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { branchId: true },
    });
    req.user.branchId = u?.branchId ?? null;
    next();
  } catch (err) {
    next(err);
  }
}

export const authenticateToken = authMiddleware;
export const authorizeRoles = roleMiddleware;
