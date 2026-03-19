
import { notificationService } from './services/notification.service.js';
import { AppointmentService } from './services/appointment.service.js';
import prisma from './lib/prisma.js';

async function testDualConfirmation() {
    console.log('--- STARTING DUAL-CONFIRMATION WORKFLOW TEST ---');

    try {
        // 1. Create a test user (Doctor) and Patient
        const patient = await prisma.patient.findFirst();
        if (!patient) throw new Error('No patient found');

        // 2. Create a fresh test appointment
        console.log('\nStep 1: Creating fresh appointment (Status: PENDING)');
        const appointment = await prisma.appointment.create({
            data: {
                patientId: patient.id,
                date: new Date(),
                status: 'PENDING',
                consultationType: 'COMBINED',
                doctorApproved: false,
                therapistApproved: false,
                notificationSent: false
            }
        });
        const appointmentId = appointment.id;
        console.log(`Created Appointment: ${appointmentId}`);

        // 3. Simulate Doctor Approval
        console.log('\nStep 2: Simulating Doctor Approval...');
        const docUser = { role: 'DOCTOR' };
        await AppointmentService.approveAppointment(appointmentId, docUser);

        // 4. Check if notification was sent (should BE now)
        const afterDoc = await prisma.appointment.findUnique({ where: { id: appointmentId } });
        console.log(`Status after Doc: ${afterDoc.status}`);
        console.log(`Flags: DocApproved: ${afterDoc.doctorApproved}, TherApproved: ${afterDoc.therapistApproved}`);
        console.log(`Notification Sent Flag: ${afterDoc.notificationSent}`);

        if (afterDoc.notificationSent) {
            console.log('SUCCESS: Doctor approval triggered the notification immediately!');
        } else {
            console.error('ERROR: Notification NOT sent after Doctor approval.');
        }

        // 5. Simulate Therapist Approval (Should NOT trigger again)
        console.log('\nStep 3: Simulating Therapist Approval (Should NOT trigger again)...');
        const therUser = { role: 'THERAPIST' };
        await AppointmentService.approveAppointment(appointmentId, therUser);

        // 6. Check if notification was sent (should BE)
        const afterBoth = await prisma.appointment.findUnique({ where: { id: appointmentId } });
        console.log(`Status after Both: ${afterBoth.status}`);
        console.log(`Flags: DocApproved: ${afterBoth.doctorApproved}, TherApproved: ${afterBoth.therapistApproved}`);
        console.log(`Notification Sent Flag: ${afterBoth.notificationSent}`);

        if (afterBoth.notificationSent) {
            console.log('SUCCESS: Dual confirmation triggered the notification!');
        } else {
            console.error('ERROR: Notification was NOT sent even after dual approval.');
        }

        // 7. Test Idempotency (Repeat Therapist approval)
        console.log('\nStep 4: Testing Idempotency (Repeating approval)...');
        await AppointmentService.approveAppointment(appointmentId, therUser);
        console.log('Workflow finished. Check console logs for "Webhook Bypassed" messages if any.');

        // Cleanup
        await prisma.appointment.delete({ where: { id: appointmentId } });
        console.log('\nCleaned up test data.');

    } catch (error) {
        console.error('TEST FAILED:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

testDualConfirmation();
