// scripts/seed-demo-hospital.mjs
// Adds ONE demo hospital to the FRESH database. Refuses to run if a hospital already exists.
//
// Field/enum choices were verified against prisma/schema.prisma:
//   - Hospital REQUIRED fields: name, slug (@unique), contactEmail
//       (status/plan/country/timezone all have defaults; plan=PROFESSIONAL, status=ACTIVE are valid enum values)
//   - Branch   REQUIRED fields: name, hospitalId
//   - User     REQUIRED fields: email, password, role  (User has NO `name` field; hospitalId/branchId are optional)
//   - Role enum admin value: ADMIN_DOCTOR
//   - Project hashes passwords with `bcrypt` (native) — see services/auth.service.js
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.hospital.count();
  if (existing > 0) {
    console.log(`Found ${existing} hospital(s). This seed is for a FRESH DB only. Aborting.`);
    return;
  }

  const hospital = await prisma.hospital.create({
    data: {
      name: 'Demo Wellness Hospital',
      slug: 'demo-wellness-hospital', // REQUIRED, @unique
      contactEmail: 'admin@demo-hospital.test', // REQUIRED
      plan: 'PROFESSIONAL', // HospitalPlan: STARTER | PROFESSIONAL | ENTERPRISE
      status: 'ACTIVE', // HospitalStatus: ACTIVE | SUSPENDED | PENDING_SETUP | DECOMMISSIONED
      timezone: 'Asia/Kolkata',
      // country defaults to "IN"
    },
  });
  console.log('Hospital created:', hospital.id);

  const branch = await prisma.branch.create({
    data: {
      hospitalId: hospital.id,
      name: 'Main Branch',
    },
  });
  console.log('Branch created:', branch.id);

  const passwordHash = await bcrypt.hash('Demo@12345', 12);
  const admin = await prisma.user.create({
    data: {
      hospitalId: hospital.id,
      branchId: branch.id,
      email: 'admin@demo-hospital.test',
      password: passwordHash,
      role: 'ADMIN_DOCTOR', // valid Role enum value
      emailVerifiedAt: new Date(), // not required for staff login, set for cleanliness
    },
  });
  console.log('Admin user created:', admin.email);

  console.log('\nDemo hospital ready. Login -> admin@demo-hospital.test / Demo@12345');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
