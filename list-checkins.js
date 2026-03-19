import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function listCheckIns() {
    try {
        const checkIns = await prisma.dailyCheckIn.findMany({
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: { patient: { select: { fullName: true } } }
        });
        console.log('--- Recent Check-ins ---');
        console.table(checkIns.map(c => ({
            id: c.id,
            patient: c.patient.fullName,
            mood: c.mood,
            pain: c.painLevel,
            sleep: c.sleepHours,
            at: c.createdAt
        })));
    } catch (err) {
        console.error(err);
    } finally {
        await prisma.$disconnect();
    }
}

listCheckIns();
