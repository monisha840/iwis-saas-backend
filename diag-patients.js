import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function checkPatients() {
    try {
        const patients = await prisma.patient.findMany({
            select: { id: true, userId: true, zenPoints: true }
        });
        console.table(patients);
    } catch (err) {
        console.error(err);
    } finally {
        await prisma.$disconnect();
    }
}

checkPatients();
