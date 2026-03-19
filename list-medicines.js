
import prisma from './lib/prisma.js';

async function listMedicines() {
    try {
        const medicines = await prisma.medicine.findMany({
            take: 5,
            include: { stocks: true }
        });
        console.log(JSON.stringify(medicines, null, 2));
    } catch (error) {
        console.error(error);
    } finally {
        await prisma.$disconnect();
    }
}

listMedicines();
