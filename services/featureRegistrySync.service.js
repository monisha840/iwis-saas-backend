/**
 * Feature Registry Sync (spec §3.6).
 *
 * Ensures every non-decommissioned hospital has a HospitalFeatureFlag row for
 * every FeatureRegistry entry. Runs nightly via BullMQ; can be triggered
 * manually by SUPER_ADMIN through the super-admin dashboard.
 *
 * Never overwrites an existing flag's `enabled` state — only fills gaps.
 */
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

export async function runFeatureRegistrySync() {
  const start = Date.now();
  const features = await prisma.featureRegistry.findMany();
  const hospitals = await prisma.hospital.findMany({
    where: { status: { not: 'DECOMMISSIONED' } },
    select: { id: true },
  });

  let created = 0;
  for (const hospital of hospitals) {
    // Fetch existing flag keys for this hospital in one query.
    const existing = await prisma.hospitalFeatureFlag.findMany({
      where: { hospitalId: hospital.id },
      select: { featureKey: true },
    });
    const existingKeys = new Set(existing.map((e) => e.featureKey));

    const toCreate = features
      .filter((f) => !existingKeys.has(f.key))
      .map((f) => ({
        hospitalId: hospital.id,
        featureKey: f.key,
        enabled: f.isCore || f.defaultEnabled,
        enabledAt: f.isCore || f.defaultEnabled ? new Date() : null,
      }));

    if (toCreate.length > 0) {
      await prisma.hospitalFeatureFlag.createMany({ data: toCreate, skipDuplicates: true });
      created += toCreate.length;
    }
  }

  const durationMs = Date.now() - start;
  logger.info('[FeatureRegistrySync] completed', {
    hospitalCount: hospitals.length,
    featureCount: features.length,
    createdFlagRows: created,
    durationMs,
  });
  return { hospitalCount: hospitals.length, featureCount: features.length, createdFlagRows: created, durationMs };
}
