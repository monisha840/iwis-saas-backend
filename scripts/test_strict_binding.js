import prisma from '../lib/prisma.js';
import { notificationService } from '../services/notification.service.js';

async function testStrictBinding() {
    console.log('🧪 Testing Strict Real-Data Binding Enforcement...\n');

    try {
        const patient = await prisma.patient.findFirst();
        const branch = await prisma.branch.findFirst();

        if (!patient || !branch) {
            console.error('❌ Error: Missing required DB records for test.');
            return;
        }

        console.log('--- CASE 1: Validation Failure (Missing Phone) ---');
        // Create an appointment for a patient with NO phone number preserved in the record
        // By using a mock object that simulates a missing mobileWith91 after formatting

        const mockAppointment = {
            id: 'test-strict-failure',
            patientId: patient.id,
            consultationType: 'DOCTOR',
            consultationMode: 'OFFLINE',
            status: 'ACCEPTED',
            createdAt: new Date(),
            updatedAt: new Date(),
            branch: { name: 'Test Branch' },
            patient: { fullName: 'Test Patient', phoneNumber: '' }, // EMPTY PHONE
            doctor: { fullName: 'Dr. Test' }
        };

        const payload = notificationService.constructWebhookPayload(mockAppointment);
        const validation = notificationService.validatePayload(payload);

        console.log('Payload Mobile:', payload.mobileWith91);
        if (!validation.success && validation.missing.includes('mobileWith91')) {
            console.log('✅ SUCCESS: Webhook BLOCKED as expected due to missing mobile number.');
        } else {
            console.error('❌ FAIL: Webhook should have been blocked for missing real mobile data.');
        }

        console.log('\n--- CASE 2: No Hardcoded Fallbacks ---');
        const mockNoName = { ...mockAppointment, patient: { ...mockAppointment.patient, fullName: '' } };
        const payloadNoName = notificationService.constructWebhookPayload(mockNoName);
        console.log('Patient Name in Payload:', payloadNoName.patientName);

        if (payloadNoName.patientName === null) {
            console.log('✅ SUCCESS: No "Patient" fallback found. Value is null as requested.');
        } else {
            console.error('❌ FAIL: Found fallback or non-null value for missing name.');
        }

    } catch (error) {
        console.error('❌ Test Error:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

testStrictBinding();
