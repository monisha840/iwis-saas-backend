import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function simulateCheckIn() {
    try {
        const userId = 'e59cf40c-0ee6-4f3e-b72c-3f4143259ffa'; // The user from diag-patients.js
        const data = {
            painLevel: 5,
            sleepHours: 8,
            mood: 'HAPPY',
            notes: 'Test simulation'
        };

        console.log('Finding patient...');
        const patient = await prisma.patient.findUnique({
            where: { userId }
        });

        if (!patient) {
            console.log('Patient not found');
            return;
        }

        console.log('Found patient:', patient.id);

        // Check for existing check-in today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const existing = await prisma.dailyCheckIn.findFirst({
            where: {
                patientId: patient.id,
                createdAt: { gte: today }
            }
        });

        if (existing) {
            console.log('Already checked in today:', existing.id);
            // We'll proceed anyway by using a dummy patient or deleting this one for test?
            // No, let's just see if the fields match.
        }

        console.log('Creating check-in...');
        const checkIn = await prisma.dailyCheckIn.create({
            data: {
                ...data,
                patientId: patient.id
            }
        });

        console.log('Check-in created:', checkIn.id);

        console.log('Updating zenPoints...');
        await prisma.patient.update({
            where: { id: patient.id },
            data: { zenPoints: { increment: 10 } }
        });

        console.log('Simulation successful!');

    } catch (err) {
        console.error('Simulation failed:', err);
    } finally {
        await prisma.$disconnect();
    }
}

simulateCheckIn();
