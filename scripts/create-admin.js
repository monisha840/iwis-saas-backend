// This script creates a default admin user if one does not exist.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = 'admin@admin.com';
  const password = 'Admin@1234';
  const role = 'ADMIN_DOCTOR';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log('Admin user already exists:', email);
    process.exit(0);
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, password: hashed, role },
  });
  console.log('Default admin created:', email, 'Password:', password);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(() => prisma.$disconnect());
