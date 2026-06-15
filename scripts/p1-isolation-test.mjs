// scripts/p1-isolation-test.mjs
//
// Phase 1 (P1-T5) isolation PROOF. Designed to FAIL if scoping were missing.
// Exercises a hospitalId-scoped model (AuditLog) through the real scoped client
// + runWithTenant, and asserts cross-tenant reads return ZERO rows.
//
//   node scripts/p1-isolation-test.mjs
//
// Creates a throwaway second hospital + branch + admin and two tagged AuditLog
// rows (one per hospital), proves isolation, then deletes ALL test data.
// The demo hospital (#1) is never modified beyond its own tagged row, which is
// removed in cleanup.
import prisma, { prismaBase } from '../lib/prisma.js';   // scoped + unscoped clients
import { runWithTenant } from '../lib/tenantContext.js';
import bcrypt from 'bcrypt';

const TAG = 'P1_ISOLATION_TEST';
let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS ✅' : 'FAIL ❌'}  ${name}`); };

// run a scoped operation as a given tenant (async form so ALS context propagates)
const asTenant = (hid, fn) => runWithTenant(hid, async () => fn());

async function main() {
  console.log('\n=== P1 tenant-isolation proof (model: AuditLog) ===\n');

  // H1 = demo hospital
  const h1 = await prismaBase.hospital.findFirst({ where: { slug: 'demo-wellness-hospital' }, select: { id: true } });
  if (!h1) throw new Error('demo hospital not found — seed it first');

  // H2 = throwaway second hospital (created unscoped, explicit ids)
  const h2 = await prismaBase.hospital.create({
    data: { name: 'Isolation Test Hospital', slug: 'iso-test-hospital', contactEmail: 'iso@iso-test.test', plan: 'STARTER', status: 'ACTIVE' },
  });
  const h2Branch = await prismaBase.branch.create({ data: { hospitalId: h2.id, name: 'Iso Main' } });
  const h2Admin = await prismaBase.user.create({
    data: { hospitalId: h2.id, branchId: h2Branch.id, email: 'iso-admin@iso-test.test', password: await bcrypt.hash('Iso@12345', 12), role: 'ADMIN_DOCTOR' },
  });
  console.log(`H1 (demo)=${h1.id}\nH2 (iso) =${h2.id}\n`);

  try {
    // Create one tagged AuditLog in each hospital THROUGH the scoped client.
    // The extension must stamp hospitalId from the active tenant.
    const r1 = await asTenant(h1.id, () => prisma.auditLog.create({ data: { action: TAG, entityType: TAG } }));
    const r2 = await asTenant(h2.id, () => prisma.auditLog.create({ data: { action: TAG, entityType: TAG } }));
    check('create stamps hospitalId from tenant (H1)', r1.hospitalId === h1.id);
    check('create stamps hospitalId from tenant (H2)', r2.hospitalId === h2.id);

    // Reads as H1: see only H1's tagged row, never H2's.
    const h1view = await asTenant(h1.id, () => prisma.auditLog.findMany({ where: { entityType: TAG }, select: { id: true, hospitalId: true } }));
    check('H1 sees its own tagged row', h1view.some(r => r.id === r1.id));
    check('H1 CANNOT see H2 row (cross-tenant read = 0)', h1view.every(r => r.id !== r2.id) && h1view.every(r => r.hospitalId === h1.id));

    // Reads as H2: mirror.
    const h2view = await asTenant(h2.id, () => prisma.auditLog.findMany({ where: { entityType: TAG }, select: { id: true, hospitalId: true } }));
    check('H2 sees its own tagged row', h2view.some(r => r.id === r2.id));
    check('H2 CANNOT see H1 row (cross-tenant read = 0)', h2view.every(r => r.id !== r1.id) && h2view.every(r => r.hospitalId === h2.id));

    // findUnique by H2's id while scoped to H1 must return null (extendedWhereUnique).
    const stolen = await asTenant(h1.id, () => prisma.auditLog.findUnique({ where: { id: r2.id } }));
    check('H1 findUnique on H2 row returns null', stolen === null);

    // count as H1 = 1, as H2 = 1
    const c1 = await asTenant(h1.id, () => prisma.auditLog.count({ where: { entityType: TAG } }));
    const c2 = await asTenant(h2.id, () => prisma.auditLog.count({ where: { entityType: TAG } }));
    check('H1 count = 1 (only its own)', c1 === 1);
    check('H2 count = 1 (only its own)', c2 === 1);

    // SUPER_ADMIN / unscoped sees BOTH.
    const all = await runWithTenant(null, async () => prisma.auditLog.count({ where: { entityType: TAG } }));
    check('SUPER_ADMIN (no tenant) sees BOTH rows', all === 2);
  } finally {
    // Cleanup — remove ALL test data (unscoped), restore demo hospital to pristine.
    await prismaBase.auditLog.deleteMany({ where: { entityType: TAG } });
    await prismaBase.user.delete({ where: { id: h2Admin.id } }).catch(() => {});
    await prismaBase.branch.delete({ where: { id: h2Branch.id } }).catch(() => {});
    await prismaBase.hospital.delete({ where: { id: h2.id } }).catch(() => {});
    const leftover = await prismaBase.auditLog.count({ where: { entityType: TAG } });
    const h2gone = (await prismaBase.hospital.count({ where: { slug: 'iso-test-hospital' } })) === 0;
    check('cleanup removed all tagged rows', leftover === 0);
    check('cleanup removed test hospital #2', h2gone);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await prismaBase.$disconnect().catch(() => {}); });
