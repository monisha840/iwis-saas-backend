
import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        const doctors = await prisma.doctor.findMany({
            include: {
                user: {
                    select: {
                        email: true,
                    }
                }
            }
        });

        console.log('Doctors in database:');
        doctors.forEach(d => {
            console.log(`- ID: ${d.id}, Email: ${d.user.email}, FullName: "${d.fullName}"`);
        });

    } catch (error) {
        console.error('Error fetching doctors:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
