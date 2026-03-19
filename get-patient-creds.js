import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function getPatientCredentials() {
    try {
        const patient = await prisma.patient.findFirst({
            include: { user: true }
        });

        if (patient) {
            console.log('\n=== PATIENT CREDENTIALS ===');
            console.log('Email:', patient.user.email);
            console.log('Full Name:', patient.fullName);
            console.log('Role:', patient.user.role);
            console.log('Patient ID:', patient.id);
            console.log('User ID:', patient.userId);
            console.log('\nNote: Password is hashed in database.');
            console.log('If using seed data, the password is typically: "password123" or "patient123"');
            console.log('===========================\n');
        } else {
            console.log('No patient found in database.');
        }
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

getPatientCredentials();
