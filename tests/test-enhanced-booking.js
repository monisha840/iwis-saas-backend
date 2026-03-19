
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function testEnhancedBooking() {
    console.log('--- STARTING ENHANCED BOOKING TEST ---');

    try {
        const patient = await prisma.patient.findFirst();
        const doctor = await prisma.doctor.findFirst();
        const therapist = await prisma.therapist.findFirst();

        if (!patient || !doctor || !therapist) {
            console.error('Prerequisites missing: Need at least one patient, doctor, and therapist.');
            return;
        }

        const date = new Date();
        date.setDate(date.getDate() + 1);
        date.setHours(10, 0, 0, 0);

        console.log('\n1. Testing Therapist-Only Online Appointment...');
        const therapistApt = await prisma.appointment.create({
            data: {
                patientId: patient.id,
                therapistId: therapist.id,
                date: date,
                status: 'PENDING',
                consultationType: 'THERAPIST',
                consultationMode: 'ONLINE',
                meetingLink: 'https://meet.jit.si/test-therapist',
            }
        });
        console.log('SUCCESS: Therapist-only appointment created with ID:', therapistApt.id);

        console.log('\n2. Testing Combined Appointment...');
        const combinedApt = await prisma.appointment.create({
            data: {
                patientId: patient.id,
                doctorId: doctor.id,
                therapistId: therapist.id,
                date: new Date(date.getTime() + 3600000), // 1 hour later
                status: 'PENDING',
                consultationType: 'COMBINED',
            }
        });
        console.log('SUCCESS: Combined appointment created with ID:', combinedApt.id);

        console.log('\n--- ALL TESTS COMPLETED SUCCESSFULLY ---');

    } catch (error) {
        console.error('TEST FAILED:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

testEnhancedBooking();
