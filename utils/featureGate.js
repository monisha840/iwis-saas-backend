/**
 * Two-tier feature gate (spec §5).
 *
 * Layer 1 — Hospital gate: is the feature registered AND enabled for the hospital?
 *           Core features bypass the enabled flag check but still hit Layer 2.
 *           Unregistered keys fail OPEN so newly-built features stay usable until
 *           their FeatureRegistry row is migrated — matches the frontend rule in
 *           useTenantFeatures (three-state: registered / enabled / unknown).
 * Layer 2 — Branch/role gate: existing FeatureFlag model (allowedBranches/allowedRoles).
 */
import prisma from '../lib/prisma.js';

export async function isFeatureAvailable(hospitalId, branchId, featureKey, role) {
  if (!featureKey) return false;

  // SUPER_ADMIN bypasses all feature gates.
  if (role === 'SUPER_ADMIN') return true;

  if (!hospitalId) return false;

  // Layer 1a: is this key even registered? If not, fail OPEN — the feature's code
  // path exists but its FeatureRegistry row hasn't been seeded yet (common during
  // incremental rollouts where the migration lags behind the deploy).
  const registry = await prisma.featureRegistry.findUnique({
    where: { key: featureKey },
    select: { isCore: true, defaultEnabled: true },
  });
  if (!registry) return true;

  // Core features are always on, regardless of the flag row.
  if (!registry.isCore) {
    // Layer 1b: hospital-level flag must exist and be enabled.
    const hospitalFlag = await prisma.hospitalFeatureFlag.findUnique({
      where: { hospitalId_featureKey: { hospitalId, featureKey } },
      select: { enabled: true },
    });
    if (!hospitalFlag) {
      // No flag row seeded yet — fall back to registry defaults so newly-added
      // features are accessible until the nightly sync/migration backfills rows.
      if (!registry.defaultEnabled) return false;
    } else if (!hospitalFlag.enabled) {
      return false;
    }
  }

  // Layer 2: branch/role gate (legacy FeatureFlag model).
  // DEPRECATED (Phase 2c): the per-hospital decision is Layer 1 above
  // (FeatureRegistry + HospitalFeatureFlag). This legacy read only adds
  // branch/role refinement (allowedBranches/allowedRoles), defaults OPEN, and is
  // slated for removal once that granularity moves into the per-hospital model.
  // If no branch-level flag row exists, default to OPEN (existing behavior).
  const branchFlag = await prisma.featureFlag.findUnique({ where: { key: featureKey } });
  if (!branchFlag) return true;
  if (!branchFlag.enabled) return false;

  const allowedRoles = branchFlag.allowedRoles ?? [];
  const allowedBranches = branchFlag.allowedBranches ?? [];

  const roleOk = allowedRoles.length === 0 || (role && allowedRoles.includes(role));
  const branchOk = allowedBranches.length === 0 || (branchId && allowedBranches.includes(branchId));

  return roleOk && branchOk;
}

/**
 * Express middleware factory. Usage:
 *   router.get('/foo', authMiddleware, requireFeature('MY_FEATURE'), handler)
 */
export function requireFeature(featureKey) {
  return async (req, res, next) => {
    try {
      const ok = await isFeatureAvailable(
        req.user?.hospitalId,
        req.user?.branchId,
        featureKey,
        req.user?.role,
      );
      if (!ok) {
        return res.status(403).json({
          error: { code: 'FEATURE_DISABLED', message: `Feature "${featureKey}" is not enabled.` },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
