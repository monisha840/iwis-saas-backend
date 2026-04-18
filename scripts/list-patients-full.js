
import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        const patients = await prisma.patient.findMany({
            include: {
                user: {
                    select: {
                        email: true,
                    }
                }
            }
        });

        console.log('Patients in database:');
        console.log(JSON.stringify(patients, null, 2));

    } catch (error) {
        console.error('Error fetching patients:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
