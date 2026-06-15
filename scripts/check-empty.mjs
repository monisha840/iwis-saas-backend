import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const h = await prisma.hospital.count();
const b = await prisma.branch.count();
const u = await prisma.user.count();
console.log(`Hospital: ${h} | Branch: ${b} | User: ${u}`);
await prisma.$disconnect();
