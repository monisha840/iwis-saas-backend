
import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        const doctors = [
            { email: 'doctor@iwis.com', fullName: 'Dr. Iwis Professional' },
            { email: 'admin@admin.com', fullName: 'Dr. Admin User' },
            { email: 'support@sirahdigital.in', fullName: 'Dr. Support Team' },
            { email: 'admindoctor@iwis.com', fullName: 'Dr. Admin Doctor' },
        ];

        for (const d of doctors) {
            const user = await prisma.user.findUnique({
                where: { email: d.email },
                include: { doctor: true }
            });

            if (user && user.doctor) {
                await prisma.doctor.update({
                    where: { id: user.doctor.id },
                    data: { fullName: d.fullName }
                });
                console.log(`Updated doctor: ${d.email} -> ${d.fullName}`);
            }
        }

        const therapists = [
            { email: 'therapist@iwis.com', fullName: 'Therapist Iwis' },
        ];

        for (const t of therapists) {
            const user = await prisma.user.findUnique({
                where: { email: t.email },
                include: { therapist: true }
            });

            if (user && user.therapist) {
                await prisma.therapist.update({
                    where: { id: user.therapist.id },
                    data: { fullName: t.fullName }
                });
                console.log(`Updated therapist: ${t.email} -> ${t.fullName}`);
            }
        }

    } catch (error) {
        console.error('Error updating staff names:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
