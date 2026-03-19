
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function cleanup() {
    console.log('--- Cleaning up test availability data ---');
    try {
        const result = await prisma.blockedSlot.deleteMany({
            where: {
                reason: {
                    contains: 'Verification'
                }
            }
        });
        console.log(`Deleted ${result.count} test blocks.`);
    } catch (error) {
        console.error('Cleanup failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

cleanup();
