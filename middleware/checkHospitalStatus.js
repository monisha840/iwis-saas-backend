/**
 * checkHospitalStatus — runs after authMiddleware.
 * For any non-SUPER_ADMIN request, verifies the user's hospital is ACTIVE.
 * Blocks suspended / decommissioned / pending-setup tenants from hitting any API.
 *
 * Spec §8, §9.
 */
import prisma from '../lib/prisma.js';

// Small in-memory cache to avoid hitting Prisma on every request.
// Keyed by hospitalId → { status, checkedAt }. TTL = 15s.
const cache = new Map();
const TTL_MS = 15 * 1000;

async function fetchStatus(hospitalId) {
  const cached = cache.get(hospitalId);
  if (cached && Date.now() - cached.checkedAt < TTL_MS) {
    return cached.status;
  }
  const hospital = await prisma.hospital.findUnique({
    where: { id: hospitalId },
    select: { status: true },
  });
  const status = hospital?.status ?? null;
  cache.set(hospitalId, { status, checkedAt: Date.now() });
  return status;
}

export function invalidateHospitalStatusCache(hospitalId) {
  if (hospitalId) cache.delete(hospitalId);
  else cache.clear();
}

export async function checkHospitalStatus(req, res, next) {
  try {
    if (!req.user) return next();
    if (req.user.role === 'SUPER_ADMIN') return next();

    let hospitalId = req.user.hospitalId;

    // Grace path: old access tokens issued before hospitalId was part of the
    // JWT claims won't have it set. Look up the user once; next refresh will
    // bake it into the token and this lookup is skipped.
    if (hospitalId === undefined || hospitalId === null) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { hospitalId: true },
      });
      hospitalId = user?.hospitalId ?? null;
      req.user.hospitalId = hospitalId;
    }

    if (!hospitalId) {
      return res.status(403).json({
        error: { code: 'NO_HOSPITAL', message: 'User is not linked to a hospital.' },
      });
    }

    const status = await fetchStatus(hospitalId);
    if (status !== 'ACTIVE') {
      return res.status(403).json({
        error: {
          code: 'HOSPITAL_SUSPENDED',
          message: 'Your hospital account is not active. Please contact your administrator.',
        },
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}
