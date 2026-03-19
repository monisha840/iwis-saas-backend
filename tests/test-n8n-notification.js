
import { notificationService } from './services/notification.service.js';
import prisma from './lib/prisma.js';

async function testN8nNotification() {
    console.log('--- STARTING N8N NOTIFICATION TEST ---');

    try {
        // Find a recent completed or confirmed appointment to use as a template
        const appointment = await prisma.appointment.findFirst({
            include: {
                doctor: true,
                therapist: true,
                patient: true,
                branch: true
            },
            orderBy: { createdAt: 'desc' }
        });

        if (!appointment) {
            console.error('No appointments found to test with.');
            return;
        }

        // Simulate a combined appointment with therapistDate
        const testAppointment = {
            ...appointment,
            consultationType: 'COMBINED',
            therapistId: appointment.therapistId || 'test-therapist-id',
            therapistDate: new Date(new Date(appointment.date).getTime() + 2 * 60 * 60000).toISOString(), // 2 hours later
        };

        // 1. Test Admin Role (Should be bypassed)
        console.log(`\n1. Testing Admin Trigger (Should Bypass):`);
        const bypassSuccess = await notificationService.sendAppointmentConfirmation(testAppointment, 'ADMIN');
        console.log(`Result: ${bypassSuccess ? 'Triggered (ERROR)' : 'Bypassed (CORRECT)'}`);

        // 2. Test Patient Role (Should trigger)
        console.log(`\n2. Testing Patient Trigger (Should Fire):`);
        const fireSuccess = await notificationService.sendAppointmentConfirmation(testAppointment, 'PATIENT');
        console.log(`Result: ${fireSuccess ? 'Triggered (CORRECT)' : 'Bypassed (ERROR)'}`);

        // 3. Test Idempotency (Should bypass second call)
        console.log(`\n3. Testing Idempotency (Should Bypass Duplicate):`);
        const duplicateSuccess = await notificationService.sendAppointmentConfirmation(testAppointment, 'PATIENT');
        console.log(`Result: ${duplicateSuccess ? 'Triggered (ERROR)' : 'Bypassed (CORRECT)'}`);

        // Create a minimal appointment to test strict data binding (should fail or have nulls)
        const minimalAppointment = {
            id: 'minimal-test-id',
            patient: { fullName: null }, // This should trigger the "Data Integrity Error"
            contactDetails: { phoneNumber: '9876543210' },
            date: new Date().toISOString(),
            consultationType: 'DOCTOR',
            consultationMode: 'OFFLINE',
            branch: null // Should be null in payload, not "Main Clinic"
        };

        console.log(`\n4. Testing Strict Data Binding (Missing Patient Name):`);
        const strictFailResult = await notificationService.sendAppointmentConfirmation(minimalAppointment, 'PATIENT');
        console.log(`Result: ${strictFailResult ? 'Triggered (ERROR)' : 'Bypassed/Failed (CORRECT)'}`);

        // Create a valid but minimal record to check null branches/modes
        const validMinimal = {
            ...testAppointment,
            patient: { fullName: 'Minimal Patient' },
            branch: null,
            consultationMode: null
        };

        console.log(`\n5. Testing Strict Data Binding (Valid Nulls):`);
        const validMinimalResult = await notificationService.sendAppointmentConfirmation(validMinimal, 'PATIENT');
        console.log(`Result: ${validMinimalResult ? 'Triggered (CORRECT)' : 'Failed (ERROR)'}`);

        // Wait a bit for the async fetch to log
        await new Promise(resolve => setTimeout(resolve, 3000));

    } catch (error) {
        console.error('TEST FAILED:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

testN8nNotification();
