/**
 * Seeds the three test users that the Playwright suite in `alshifa-e2e`
 * expects: `e2e-patient@alshifa.test`, `e2e-doctor@alshifa.test`, and
 * `e2e-admin@alshifa.test`. Idempotent — safe to re-run.
 *
 * Usage: `node scripts/seed-e2e-users.js`
 */

import bcrypt from 'bcrypt';
import prisma from '../lib/prisma.js';

const HASH_ROUNDS = 12;

const USERS = [
    {
        email: process.env.E2E_PATIENT_EMAIL || 'e2e-patient@alshifa.test',
        password: process.env.E2E_PATIENT_PASSWORD || 'E2ePatient@1234',
        role: 'PATIENT',
        fullName: 'E2E Test Patient',
    },
    {
        email: process.env.E2E_DOCTOR_EMAIL || 'e2e-doctor@alshifa.test',
        password: process.env.E2E_DOCTOR_PASSWORD || 'E2eDoctor@1234',
        role: 'DOCTOR',
        fullName: 'E2E Test Doctor',
    },
    {
        email: process.env.E2E_ADMIN_EMAIL || 'e2e-admin@alshifa.test',
        password: process.env.E2E_ADMIN_PASSWORD || 'E2eAdmin@1234',
        role: 'ADMIN',
        fullName: 'E2E Test Admin',
    },
];

async function seedUser(spec) {
    const existing = await prisma.user.findUnique({ where: { email: spec.email } });
    if (existing) {
        console.log(`  ✓ exists: ${spec.email} (${spec.role})`);
        return existing;
    }

    const hashed = await bcrypt.hash(spec.password, HASH_ROUNDS);
    // Attach to the first active branch if one exists — otherwise null is fine.
    const branch = await prisma.branch.findFirst({ where: { isActive: true } });

    const user = await prisma.user.create({
        data: {
            email: spec.email,
            password: hashed,
            role: spec.role,
            emailVerifiedAt: new Date(),
            branchId: branch?.id || null,
            hospitalId: branch?.hospitalId || null,
        },
    });

    // Create the role-specific profile record.
    if (spec.role === 'PATIENT') {
        await prisma.patient.create({
            data: {
                userId: user.id,
                fullName: spec.fullName,
                onboardingCompleted: true,
                branchId: branch?.id || null,
            },
        });
    } else if (spec.role === 'DOCTOR') {
        await prisma.doctor.create({
            data: { userId: user.id, fullName: spec.fullName, specialization: 'GENERAL' },
        });
    }

    console.log(`  + created: ${spec.email} (${spec.role})`);
    return user;
}

async function main() {
    console.log('[seed-e2e-users] Seeding test accounts for Playwright E2E suite…');
    for (const spec of USERS) {
        await seedUser(spec);
    }
    console.log('[seed-e2e-users] Done.');
}

main()
    .catch((err) => {
        console.error('[seed-e2e-users] Failed:', err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
