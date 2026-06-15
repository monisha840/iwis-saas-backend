// scripts/p0-audit.mjs
//
// READ-ONLY Phase-0 isolation audit. Performs NO writes and NO schema changes —
// it only reads Prisma's DMMF metadata and runs count() queries.
//
// What it does:
//   1. Walks Prisma.dmmf.datamodel.models and reports, per model, whether it has
//      a `hospitalId` and/or `branchId` field. Models with NEITHER are printed as
//      the "Phase 1 risk list" (tables not yet tenant-scoped).
//   2. For every model that HAS a `hospitalId` field, runs
//      count({ where: { hospitalId: null } }) and reports any "homeless" rows.
//   3. Prints totals (hospital count + total homeless rows).
//
// Expected on a freshly-seeded IWIS DB: 1 hospital, 0 homeless rows.

import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Prisma client delegate name = model name with the first character lower-cased.
const delegateFor = (name) => name.charAt(0).toLowerCase() + name.slice(1);

async function main() {
  const models = Prisma.dmmf.datamodel.models;

  const withHospitalId = []; // { name, nullable }
  const withBranchId = [];
  const riskList = []; // neither hospitalId nor branchId

  for (const model of models) {
    const hospitalField = model.fields.find((f) => f.name === 'hospitalId');
    const hasHospital = Boolean(hospitalField);
    const hasBranch = model.fields.some((f) => f.name === 'branchId');
    // DMMF: isRequired === true means a NOT NULL column, so it can never be "homeless".
    if (hasHospital) withHospitalId.push({ name: model.name, nullable: !hospitalField.isRequired });
    if (hasBranch) withBranchId.push(model.name);
    if (!hasHospital && !hasBranch) riskList.push(model.name);
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' P0 ISOLATION AUDIT (read-only)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Total models: ${models.length}`);
  console.log(`  with hospitalId: ${withHospitalId.length}`);
  console.log(`  with branchId:   ${withBranchId.length}`);
  console.log(`  with neither:    ${riskList.length}`);

  console.log('\n── Phase 1 risk list (models with NO hospitalId AND NO branchId) ──');
  for (const name of riskList) console.log(`  • ${name}`);

  console.log('\n── Homeless-row check (rows where hospitalId IS NULL) ──');
  let totalHomeless = 0;
  const homelessByModel = [];
  let requiredSkipped = 0;
  for (const { name, nullable } of withHospitalId) {
    // A required (NOT NULL) hospitalId can never be null — structurally 0 homeless.
    if (!nullable) { requiredSkipped++; continue; }
    const delegate = delegateFor(name);
    const client = prisma[delegate];
    if (!client || typeof client.count !== 'function') {
      console.log(`  ? ${name}: no client delegate (skipped)`);
      continue;
    }
    const count = await client.count({ where: { hospitalId: null } });
    if (count > 0) {
      totalHomeless += count;
      homelessByModel.push({ name, count });
      console.log(`  ✗ ${name}: ${count} homeless row(s)`);
    }
  }
  if (homelessByModel.length === 0) {
    console.log('  ✓ none — every nullable-hospitalId model has 0 rows with a null hospital');
  }
  console.log(`  (${requiredSkipped} model(s) have a NOT NULL hospitalId — homeless impossible by constraint)`);

  const hospitalCount = await prisma.hospital.count();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' TOTALS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Hospitals:           ${hospitalCount}`);
  console.log(`  Homeless rows total: ${totalHomeless}`);
  console.log(`  Phase 1 risk models: ${riskList.length}`);
  console.log(
    totalHomeless === 0
      ? '\nRESULT: OK — 0 homeless rows.'
      : '\nRESULT: ATTENTION — homeless rows found (see above).'
  );
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
