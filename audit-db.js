import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
    try {
        const user = await prisma.user.findUnique({
            where: { email: 'admin@admin.com' },
            include: { doctor: true, therapist: true, patient: true }
        });
        console.log('Admin user with profiles:', JSON.stringify(user, null, 2));

        const allDoctors = await prisma.doctor.findMany();
        console.log('All doctors count:', allDoctors.length);

        // Check if any doctor is missing a User
        const docUsers = await prisma.user.findMany({
            where: { role: { in: ['DOCTOR', 'ADMIN_DOCTOR'] } },
            include: { doctor: true }
        });
        console.log('Doctors check:');
        docUsers.forEach(u => {
            console.log(`- ${u.email}: ${u.doctor ? 'Has Doctor Record' : 'MISSING Doctor Record'}`);
        });

    } catch (error) {
        console.error('Error during database audit:', error);
    } finally {
        await prisma.$disconnect();
    }
}
main();
