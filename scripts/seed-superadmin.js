/**
 * IWIS Super Admin — seed CLI (spec §12 Q5)
 * ─────────────────────────────────────────
 * Creates the first SUPER_ADMIN user for the platform. Subsequent SUPER_ADMIN
 * users must be created from within an existing SUPER_ADMIN session — this
 * script refuses to run a second time (exits 0 if a SUPER_ADMIN already exists)
 * unless --force is passed.
 *
 * Environment overrides (preferred for CI/ops):
 *   SUPERADMIN_EMAIL       — default: superadmin@sirah.digital
 *   SUPERADMIN_PASSWORD    — default: SuperAdmin@1234 (CHANGE ON FIRST LOGIN)
 *
 * Run: node scripts/seed-superadmin.js
 *      node scripts/seed-superadmin.js --force
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const force = process.argv.includes('--force');

const SALT_ROUNDS = 12;

async function main() {
  const email = process.env.SUPERADMIN_EMAIL || 'superadmin@sirah.digital';
  const password = process.env.SUPERADMIN_PASSWORD || 'SuperAdmin@1234';

  const existingSuper = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
  if (existingSuper && !force) {
    console.log(`[seed-superadmin] A SUPER_ADMIN already exists (${existingSuper.email}). Skipping.`);
    console.log(`[seed-superadmin] Pass --force to create another one.`);
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role === 'SUPER_ADMIN') {
      console.log(`[seed-superadmin] User ${email} already exists and is SUPER_ADMIN. Nothing to do.`);
      return;
    }
    console.error(`[seed-superadmin] User ${email} exists with role ${existing.role}. Aborting.`);
    process.exit(1);
  }

  const hashed = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email,
      password: hashed,
      role: 'SUPER_ADMIN',
      mfaEnabled: false,            // MFA enrolled on first login (spec §6.1)
      emailVerifiedAt: new Date(),  // pre-verified via CLI provisioning
      hospitalId: null,             // SUPER_ADMIN is platform-level, not tenant
    },
  });

  console.log('─────────────────────────────────────────────────────────');
  console.log('  SUPER_ADMIN seeded');
  console.log('─────────────────────────────────────────────────────────');
  console.log(`  email:    ${user.email}`);
  console.log(`  password: ${password}`);
  console.log('  CHANGE THIS PASSWORD IMMEDIATELY ON FIRST LOGIN.');
  console.log('  Enable MFA from the account settings page on first login.');
  console.log('─────────────────────────────────────────────────────────');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
