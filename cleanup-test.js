import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanup() {
    console.log('Cleaning up test appointments...');
    const result = await prisma.appointment.deleteMany({
        where: {
            status: 'SCHEDULED'
        }
    });
    console.log(`Deleted ${result.count} test appointments.`);
    await prisma.$disconnect();
}

cleanup();
