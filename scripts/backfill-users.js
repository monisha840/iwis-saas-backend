// Script to backfill Doctor and Patient tables for existing users
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Backfill doctors
  const doctorUsers = await prisma.user.findMany({ where: { role: 'DOCTOR' } });
  for (const user of doctorUsers) {
    const exists = await prisma.doctor.findUnique({ where: { userId: user.id } });
    if (!exists) {
      await prisma.doctor.create({ data: { userId: user.id } });
      console.log(`Backfilled doctor for user: ${user.email}`);
    }
  }

  // Backfill patients
  const patientUsers = await prisma.user.findMany({ where: { role: 'PATIENT' } });
  for (const user of patientUsers) {
    const exists = await prisma.patient.findUnique({ where: { userId: user.id } });
    if (!exists) {
      await prisma.patient.create({ data: { userId: user.id } });
      console.log(`Backfilled patient for user: ${user.email}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
