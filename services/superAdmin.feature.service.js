import prisma from '../lib/prisma.js';
import { SuperAdminAuditService } from './superAdmin.audit.service.js';

const PLAN_RANK = { STARTER: 0, PROFESSIONAL: 1, ENTERPRISE: 2 };

export class SuperAdminFeatureService {
  /**
   * Return all features for a hospital: LEFT JOIN of FeatureRegistry with
   * HospitalFeatureFlag. Features without a flag row yet (added after the
   * hospital was created and before nightly sync) are marked syncPending: true.
   */
  static async getHospitalFeatures(hospitalId) {
    const [hospital, registry, flags] = await Promise.all([
      prisma.hospital.findUnique({ where: { id: hospitalId }, select: { id: true, plan: true } }),
      prisma.featureRegistry.findMany({ orderBy: [{ phase: 'asc' }, { displayName: 'asc' }] }),
      prisma.hospitalFeatureFlag.findMany({
        where: { hospitalId },
        include: { enabledBy: { select: { id: true, email: true } } },
      }),
    ]);
    if (!hospital) {
      const e = new Error('Hospital not found');
      e.status = 404;
      throw e;
    }
    const flagMap = Object.fromEntries(flags.map((f) => [f.featureKey, f]));
    const hospitalPlanRank = PLAN_RANK[hospital.plan] ?? 0;

    return registry.map((f) => {
      const flag = flagMap[f.key];
      const planAllowed = (PLAN_RANK[f.minPlan] ?? 0) <= hospitalPlanRank;
      return {
        key: f.key,
        displayName: f.displayName,
        description: f.description,
        phase: f.phase,
        minPlan: f.minPlan,
        isCore: f.isCore,
        addedInVersion: f.addedInVersion,
        enabled: flag?.enabled ?? (f.isCore ? true : f.defaultEnabled),
        enabledAt: flag?.enabledAt ?? null,
        enabledById: flag?.enabledById ?? null,
        enabledByEmail: flag?.enabledBy?.email ?? null,
        notes: flag?.notes ?? null,
        syncPending: !flag,
        planAllowed,
      };
    });
  }

  static async setHospitalFeature({ actorId, ip, hospitalId, featureKey, enabled, notes }) {
    const hospital = await prisma.hospital.findUnique({ where: { id: hospitalId } });
    if (!hospital) {
      const e = new Error('Hospital not found');
      e.status = 404;
      throw e;
    }
    const feature = await prisma.featureRegistry.findUnique({ where: { key: featureKey } });
    if (!feature) {
      const e = new Error('Unknown feature');
      e.status = 404;
      throw e;
    }

    // Core features can't be toggled off.
    if (feature.isCore && !enabled) {
      const e = new Error('Core features cannot be disabled');
      e.status = 400;
      e.code = 'CORE_FEATURE';
      throw e;
    }

    // Plan gate (spec §4.2)
    const hospitalRank = PLAN_RANK[hospital.plan] ?? 0;
    const featureRank = PLAN_RANK[feature.minPlan] ?? 0;
    if (enabled && featureRank > hospitalRank) {
      const e = new Error(`Feature requires ${feature.minPlan} plan.`);
      e.status = 403;
      e.code = 'PLAN_RESTRICTION';
      throw e;
    }

    const flag = await prisma.hospitalFeatureFlag.upsert({
      where: { hospitalId_featureKey: { hospitalId, featureKey } },
      create: {
        hospitalId,
        featureKey,
        enabled,
        enabledAt: enabled ? new Date() : null,
        enabledById: enabled ? actorId : null,
        notes: notes ?? null,
      },
      update: {
        enabled,
        enabledAt: enabled ? new Date() : null,
        enabledById: enabled ? actorId : null,
        notes: notes ?? undefined,
      },
    });

    await SuperAdminAuditService.log({
      superAdminId: actorId,
      action: enabled ? 'FEATURE_ENABLED' : 'FEATURE_DISABLED',
      hospitalId,
      featureKey,
      details: { notes: notes ?? null },
      ipAddress: ip,
    });

    return flag;
  }

  static async bulkSet({ actorId, ip, hospitalId, changes }) {
    // changes: [{ featureKey, enabled, notes }]
    const results = [];
    for (const change of changes) {
      try {
        const r = await this.setHospitalFeature({ actorId, ip, hospitalId, ...change });
        results.push({ featureKey: change.featureKey, ok: true, flag: r });
      } catch (err) {
        results.push({
          featureKey: change.featureKey,
          ok: false,
          error: { code: err.code ?? 'ERROR', message: err.message },
        });
      }
    }
    return results;
  }

  static async listRegistry() {
    const [features, hospitals, flags] = await Promise.all([
      prisma.featureRegistry.findMany({ orderBy: [{ phase: 'asc' }, { displayName: 'asc' }] }),
      prisma.hospital.count({ where: { status: { not: 'DECOMMISSIONED' } } }),
      prisma.hospitalFeatureFlag.groupBy({
        by: ['featureKey'],
        _count: { _all: true },
        where: { enabled: true, hospital: { status: { not: 'DECOMMISSIONED' } } },
      }),
    ]);
    const enabledByKey = Object.fromEntries(flags.map((f) => [f.featureKey, f._count._all]));
    return features.map((f) => ({
      ...f,
      hospitalCount: hospitals,
      enabledHospitalCount: enabledByKey[f.key] ?? 0,
      globalStatus:
        (enabledByKey[f.key] ?? 0) === 0
          ? 'OFF'
          : (enabledByKey[f.key] ?? 0) >= hospitals
          ? 'ON'
          : 'MIXED',
    }));
  }

  /**
   * Bulk-toggle a feature across every non-decommissioned hospital.
   * - Core features can only be set to enabled=true (never disabled).
   * - Plan-gated features skip hospitals whose plan is below the feature's minPlan.
   */
  static async toggleForAllHospitals({ actorId, ip, featureKey, enabled }) {
    const feature = await prisma.featureRegistry.findUnique({ where: { key: featureKey } });
    if (!feature) {
      const e = new Error('Unknown feature');
      e.status = 404;
      throw e;
    }
    if (feature.isCore && !enabled) {
      const e = new Error('Core features cannot be globally disabled');
      e.status = 400;
      e.code = 'CORE_FEATURE';
      throw e;
    }

    const minRank = PLAN_RANK[feature.minPlan] ?? 0;
    const hospitals = await prisma.hospital.findMany({
      where: { status: { not: 'DECOMMISSIONED' } },
      select: { id: true, plan: true },
    });

    const eligible = hospitals.filter((h) => (PLAN_RANK[h.plan] ?? 0) >= minRank);
    const skipped = hospitals.filter((h) => (PLAN_RANK[h.plan] ?? 0) < minRank);

    const now = new Date();
    // One upsert per hospital (Prisma has no bulk upsert). Run in a transaction.
    await prisma.$transaction(
      eligible.map((h) =>
        prisma.hospitalFeatureFlag.upsert({
          where: { hospitalId_featureKey: { hospitalId: h.id, featureKey } },
          create: {
            hospitalId: h.id,
            featureKey,
            enabled,
            enabledAt: enabled ? now : null,
            enabledById: enabled ? actorId : null,
          },
          update: {
            enabled,
            enabledAt: enabled ? now : null,
            enabledById: enabled ? actorId : null,
          },
        })
      )
    );

    await SuperAdminAuditService.log({
      superAdminId: actorId,
      action: enabled ? 'FEATURE_GLOBAL_ENABLED' : 'FEATURE_GLOBAL_DISABLED',
      featureKey,
      details: {
        appliedTo: eligible.length,
        skippedForPlan: skipped.length,
      },
      ipAddress: ip,
    });

    return {
      featureKey,
      enabled,
      appliedTo: eligible.length,
      skippedForPlan: skipped.length,
      totalHospitals: hospitals.length,
    };
  }

  static async updateRegistryMeta({ actorId, ip, key, patch }) {
    // Only safe metadata fields can be updated via the API. Plan gating / phase / isCore
    // require a migration so the change is in version control (spec §4.3).
    const allowed = ['displayName', 'description', 'addedInVersion'];
    const data = {};
    for (const k of allowed) if (patch[k] !== undefined) data[k] = patch[k];

    const feature = await prisma.featureRegistry.findUnique({ where: { key } });
    if (!feature) {
      const e = new Error('Feature not found');
      e.status = 404;
      throw e;
    }
    const updated = await prisma.featureRegistry.update({ where: { key }, data });

    await SuperAdminAuditService.log({
      superAdminId: actorId,
      action: 'FEATURE_REGISTRY_UPDATED',
      featureKey: key,
      details: { before: pickKeys(feature, allowed), after: pickKeys(updated, allowed) },
      ipAddress: ip,
    });
    return updated;
  }
}

function pickKeys(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k] ?? null;
  return out;
}
