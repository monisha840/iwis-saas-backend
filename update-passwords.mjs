import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const hash = await bcrypt.hash('Test@1234', 12);

await prisma.user.updateMany({
  where: {
    email: {
      in: [
        'e2e-admin@alshifa.test',
        'e2e-doctor@alshifa.test',
        'e2e-patient@alshifa.test',
        'pharmacist@iwis.com'
      ]
    }
  },
  data: {
    password: hash,
    emailVerifiedAt: new Date()
  }
});

console.log('Done! Passwords updated.');
await prisma.$disconnect();