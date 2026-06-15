// scripts/p1-isolation-test.mjs
//
// Phase 1 isolation PROOF. Designed to FAIL if scoping were missing.
// Covers BOTH:
//   - hospitalId-scoped models (AuditLog) — Phase 1
//   - branchId-only models (Patient)      — Phase 1.5 (branchId gap fix)
// Asserts cross-tenant reads return ZERO rows, then deletes all test data.
//
//   node scripts/p1-isolation-test.mjs
import prisma, { prismaBase } from '../lib/prisma.js';
import { runWithTenant } from '../lib/tenantContext.js';
import bcrypt from 'bcrypt';

const TAG = 'P1_ISOLATION_TEST';      // AuditLog tag
const PTAG = 'P1_ISO_PATIENT';        // Patient tag (fullName)
const PT_EMAILS = ['iso-pt-h1@iso-test.test', 'iso-pt-h2@iso-test.test'];
let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS ✅' : 'FAIL ❌'}  ${name}`); };
const asTenant = (hid, fn) => runWithTenant(hid, async () => fn());

async function main() {
  console.log('\n=== Phase 1 tenant-isolation proof (hospitalId + branchId) ===\n');

  const h1 = await prismaBase.hospital.findFirst({ where: { slug: 'demo-wellness-hospital' }, select: { id: true } });
  if (!h1) throw new Error('demo hospital not found — seed it first');
  const h1Branch = await prismaBase.branch.findFirst({ where: { hospitalId: h1.id }, select: { id: true } });

  const h2 = await prismaBase.hospital.create({ data: { name: 'Isolation Test Hospital', slug: 'iso-test-hospital', contactEmail: 'iso@iso-test.test', plan: 'STARTER', status: 'ACTIVE' } });
  const h2Branch = await prismaBase.branch.create({ data: { hospitalId: h2.id, name: 'Iso Main' } });
  const h2Admin = await prismaBase.user.create({ data: { hospitalId: h2.id, branchId: h2Branch.id, email: 'iso-admin@iso-test.test', password: await bcrypt.hash('Iso@12345', 12), role: 'ADMIN_DOCTOR' } });
  console.log(`H1 (demo)=${h1.id}  branch=${h1Branch.id}\nH2 (iso) =${h2.id}  branch=${h2Branch.id}\n`);

  try {
    // ── hospitalId-scoped model: AuditLog ─────────────────────────────────────
    console.log('-- hospitalId model: AuditLog --');
    const r1 = await asTenant(h1.id, () => prisma.auditLog.create({ data: { action: TAG, entityType: TAG } }));
    const r2 = await asTenant(h2.id, () => prisma.auditLog.create({ data: { action: TAG, entityType: TAG } }));
    check('create stamps hospitalId (H1 & H2)', r1.hospitalId === h1.id && r2.hospitalId === h2.id);
    const a1 = await asTenant(h1.id, () => prisma.auditLog.findMany({ where: { entityType: TAG }, select: { id: true } }));
    check('H1 sees only its AuditLog; cross-tenant read = 0', a1.some(r => r.id === r1.id) && a1.every(r => r.id !== r2.id));
    check('H1 findUnique on H2 AuditLog = null', (await asTenant(h1.id, () => prisma.auditLog.findUnique({ where: { id: r2.id } }))) === null);
    check('SUPER_ADMIN sees BOTH AuditLogs', (await runWithTenant(null, async () => prisma.auditLog.count({ where: { entityType: TAG } }))) === 2);

    // ── branchId-only model: Patient ──────────────────────────────────────────
    console.log('-- branchId model: Patient --');
    const pwd = await bcrypt.hash('Iso@12345', 12);
    const uH1 = await prismaBase.user.create({ data: { hospitalId: h1.id, branchId: h1Branch.id, email: PT_EMAILS[0], password: pwd, role: 'PATIENT' } });
    const pH1 = await prismaBase.patient.create({ data: { userId: uH1.id, branchId: h1Branch.id, fullName: PTAG } });
    const uH2 = await prismaBase.user.create({ data: { hospitalId: h2.id, branchId: h2Branch.id, email: PT_EMAILS[1], password: pwd, role: 'PATIENT' } });
    const pH2 = await prismaBase.patient.create({ data: { userId: uH2.id, branchId: h2Branch.id, fullName: PTAG } });

    const p1 = await asTenant(h1.id, () => prisma.patient.findMany({ where: { fullName: PTAG }, select: { id: true, branchId: true } }));
    check('H1 sees its own patient (branchId scope)', p1.some(r => r.id === pH1.id));
    check('H1 CANNOT see H2 patient (cross-tenant read = 0)', p1.every(r => r.id !== pH2.id));
    const p2 = await asTenant(h2.id, () => prisma.patient.findMany({ where: { fullName: PTAG }, select: { id: true } }));
    check('H2 sees its own patient; CANNOT see H1 patient', p2.some(r => r.id === pH2.id) && p2.every(r => r.id !== pH1.id));
    check('H1 findUnique on H2 patient = null (branchId + extendedWhereUnique)', (await asTenant(h1.id, () => prisma.patient.findUnique({ where: { id: pH2.id } }))) === null);
    const pc1 = await asTenant(h1.id, () => prisma.patient.count({ where: { fullName: PTAG } }));
    const pc2 = await asTenant(h2.id, () => prisma.patient.count({ where: { fullName: PTAG } }));
    check('H1 patient count = 1, H2 patient count = 1', pc1 === 1 && pc2 === 1);
    check('SUPER_ADMIN sees BOTH patients', (await runWithTenant(null, async () => prisma.patient.count({ where: { fullName: PTAG } }))) === 2);
  } finally {
    // Cleanup (unscoped). Patients before their users (FK).
    await prismaBase.auditLog.deleteMany({ where: { entityType: TAG } });
    await prismaBase.patient.deleteMany({ where: { fullName: PTAG } });
    await prismaBase.user.deleteMany({ where: { email: { in: [...PT_EMAILS, 'iso-admin@iso-test.test'] } } });
    await prismaBase.branch.delete({ where: { id: h2Branch.id } }).catch(() => {});
    await prismaBase.hospital.delete({ where: { id: h2.id } }).catch(() => {});
    const leftover = (await prismaBase.auditLog.count({ where: { entityType: TAG } })) + (await prismaBase.patient.count({ where: { fullName: PTAG } }));
    const h2gone = (await prismaBase.hospital.count({ where: { slug: 'iso-test-hospital' } })) === 0;
    check('cleanup removed all test rows + hospital #2', leftover === 0 && h2gone);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await prismaBase.$disconnect().catch(() => {}); });
