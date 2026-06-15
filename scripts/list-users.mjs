import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const users = await prisma.user.findMany({ select: { email: true, role: true, deletedAt: true } });
console.log(`Total users: ${users.length}`);
for (const u of users) console.log(`  ${u.email} | ${u.role}${u.deletedAt ? ' | DELETED' : ''}`);
await prisma.$disconnect();
