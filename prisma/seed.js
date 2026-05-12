/**
 * Al-Shifa Production Database Seed
 * ─────────────────────────────────
 * • Idempotent — safe to run multiple times (upsert + skip-if-exists guards).
 * • Transactional writes per user to prevent partial inserts.
 * • Restores the five core system accounts after any Prisma migration reset.
 * • Seeds default branch, notification preferences, and therapist availability.
 *
 * Run: node prisma/seed.js
 * Or via Prisma: npx prisma db seed
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BRANCH_ID = 'default-branch-id';
const SALT_ROUNDS = 10;

/**
 * Therapist default availability — Mon–Sat (0=Sun … 6=Sat), 09:00–17:00.
 * All slots are pre-approved so the therapist is visible immediately.
 */
const THERAPIST_DEFAULT_AVAILABILITY = [
  { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }, // Monday
  { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' }, // Tuesday
  { dayOfWeek: 3, startTime: '09:00', endTime: '17:00' }, // Wednesday
  { dayOfWeek: 4, startTime: '09:00', endTime: '17:00' }, // Thursday
  { dayOfWeek: 5, startTime: '09:00', endTime: '17:00' }, // Friday
  { dayOfWeek: 6, startTime: '09:00', endTime: '13:00' }, // Saturday (half-day)
];

// ─── User definitions ─────────────────────────────────────────────────────────

/**
 * Each entry drives both the User row and the linked profile row.
 * Fields not present in the current schema are intentionally omitted.
 */
const SEED_USERS = [
  {
    email: 'admin@admin.com',
    password: 'Admin@1234',
    role: 'ADMIN_DOCTOR',
    profileType: 'doctor',
    profile: {
      fullName: 'Dr. Saleem',
      specialization: 'General Medicine',
      qualification: 'MBBS, MD',
      yearsExperience: 15,
      clinic: 'Al-Shifa Hospital',
    },
  },
  {
    email: 'doctor@iwis.com',
    password: 'Doctor@123',
    role: 'DOCTOR',
    profileType: 'doctor',
    profile: {
      fullName: 'Dr. Rahman',
      specialization: 'Cardiology',
      qualification: 'MBBS, DM (Cardiology)',
      yearsExperience: 10,
      clinic: 'Al-Shifa Hospital',
    },
  },
  {
    email: 'therapist@iwis.com',
    password: 'Therapist@123',
    role: 'THERAPIST',
    profileType: 'therapist',
    profile: {
      fullName: 'Mannikam',
      specialization: 'Physical Therapy',
      qualification: 'BPT, MPT',
      yearsExperience: 7,
      clinic: 'Al-Shifa Hospital',
    },
  },
  {
    email: 'patient@iwis.com',
    password: 'Patient@123',
    role: 'PATIENT',
    profileType: 'patient',
    profile: {
      fullName: 'Chellakannu',
      gender: 'Male',
      age: 40,
      phoneNumber: '+91-9000000001',
      therapyTypes: ['Physical'],
      patientId: 'PAT-0001',
      onboardingCompleted: true,
    },
  },
  {
    email: 'pharmacist@iwis.com',
    password: 'Pharmacist@123',
    role: 'PHARMACIST',
    profileType: 'pharmacist',
    profile: {
      fullName: 'Muthu Kumaran',
      qualification: 'B.Pharm, M.Pharm',
      yearsExperience: 6,
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build the `create` payload for a User's nested profile relation. */
function buildProfileNested(profileType, profileData) {
  switch (profileType) {
    case 'doctor':
      return { doctor: { create: profileData } };
    case 'therapist':
      return { therapist: { create: profileData } };
    case 'patient':
      return { patient: { create: profileData } };
    case 'pharmacist':
      return { pharmacist: { create: profileData } };
    default:
      throw new Error(`Unknown profileType: ${profileType}`);
  }
}

/**
 * Seed default availability slots for a therapist.
 * Uses upsert-by-composite to prevent duplicate rows on re-runs.
 * Prisma has no compound-unique on Availability, so we do a find-or-create.
 */
async function seedTherapistAvailability(therapistId) {
  let created = 0;
  let skipped = 0;

  for (const slot of THERAPIST_DEFAULT_AVAILABILITY) {
    const existing = await prisma.availability.findFirst({
      where: {
        therapistId,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
      },
    });

    if (existing) {
      skipped++;
      continue;
    }

    await prisma.availability.create({
      data: {
        therapistId,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        isApproved: true,
      },
    });
    created++;
  }

  console.log(
    `    ↳ Availability: ${created} created, ${skipped} already present`
  );
}

/** Ensure a NotificationPreference row exists for the user (defaults are fine). */
async function ensureNotificationPreference(userId) {
  const existing = await prisma.notificationPreference.findUnique({
    where: { userId },
  });
  if (!existing) {
    await prisma.notificationPreference.create({
      data: { userId },
    });
  }
}

// ─── Main seed logic ──────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Al-Shifa — Production Database Seed');
  console.log('══════════════════════════════════════════════════════════\n');

  // ── 1. Default Branch ──────────────────────────────────────────────────────
  const branch = await prisma.branch.upsert({
    where: { id: DEFAULT_BRANCH_ID },
    update: {},
    create: {
      id: DEFAULT_BRANCH_ID,
      name: 'Al-Shifa Main Clinic',
      address: 'Main Street, Chennai',
      phone: '044-00000001',
      email: 'main@clinic.com',
      isActive: true,
    },
  });
  console.log(`✔ Branch: "${branch.name}" (${branch.id})`);

  // ── 2. Users + Profiles ────────────────────────────────────────────────────
  console.log('\n📋 Seeding users…\n');

  const results = [];

  for (const userData of SEED_USERS) {
    try {
      // --- Guard: skip if email already registered --------------------------
      const existing = await prisma.user.findUnique({
        where: { email: userData.email },
        include: {
          doctor: true,
          therapist: true,
          patient: true,
          pharmacist: true,
        },
      });

      if (existing) {
        console.log(`⏭  Skipped (exists): ${userData.email}  [${userData.role}]`);

        // Still ensure availability + notification pref are present
        if (existing.therapist) {
          await seedTherapistAvailability(existing.therapist.id);
        }
        await ensureNotificationPreference(existing.id);

        results.push({ email: userData.email, role: userData.role, status: 'skipped' });
        continue;
      }

      // --- Hash password before transaction ---------------------------------
      const hashedPassword = await bcrypt.hash(userData.password, SALT_ROUNDS);

      // --- Transactional create: User + Profile + Branch assignment ---------
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: userData.email,
            password: hashedPassword,
            role: userData.role,
            branchId: DEFAULT_BRANCH_ID,
            ...buildProfileNested(userData.profileType, userData.profile),
          },
          include: {
            doctor: true,
            therapist: true,
            patient: true,
            pharmacist: true,
          },
        });
        return created;
      });

      console.log(`✔ Created: ${user.email}  [${user.role}]`);

      // --- Post-create: availability (therapist only) -----------------------
      if (user.therapist) {
        await seedTherapistAvailability(user.therapist.id);
      }

      // --- Post-create: notification preferences ----------------------------
      await ensureNotificationPreference(user.id);

      results.push({ email: userData.email, role: userData.role, status: 'created' });
    } catch (err) {
      console.error(`✖ Failed: ${userData.email}  — ${err.message}`);
      // Surface Prisma-specific detail for quick debugging
      if (err.code) console.error(`  Prisma code: ${err.code}`, err.meta ?? '');
      results.push({ email: userData.email, role: userData.role, status: 'error' });
    }
  }

  // ── 3. Summary ─────────────────────────────────────────────────────────────
  const created = results.filter((r) => r.status === 'created').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const errors  = results.filter((r) => r.status === 'error').length;

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  Result: ${created} created  |  ${skipped} skipped  |  ${errors} errors`);
  console.log('──────────────────────────────────────────────────────────');

  if (created > 0 || skipped > 0) {
    console.log('\n📝 Login Credentials\n');
    console.log(
      `${'Role'.padEnd(16)} ${'Email'.padEnd(28)} Password`
    );
    console.log('─'.repeat(70));
    for (const u of SEED_USERS) {
      console.log(
        `${u.role.padEnd(16)} ${u.email.padEnd(28)} ${u.password}`
      );
    }
    console.log('─'.repeat(70));
  }

  if (errors > 0) {
    process.exit(1);
  }
}

// ─── Entry-point ──────────────────────────────────────────────────────────────

main()
  .catch((e) => {
    console.error('\n❌ Seed script failed unexpectedly:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
