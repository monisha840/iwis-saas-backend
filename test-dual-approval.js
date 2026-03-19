
import { PrismaClient } from '@prisma/client';
import { AppointmentService } from './services/appointment.service.js';

const prisma = new PrismaClient();

async function runTest() {
    console.log('--- Starting Dual-Approval Workflow Verification ---');

    try {
        // 1. Setup: Create a test appointment
        const patient = await prisma.patient.findFirst();
        const doctor = await prisma.doctor.findFirst();
        const therapist = await prisma.therapist.findFirst();

        if (!patient || !doctor || !therapist) {
            console.error('Test failed: Required entities (Patient, Doctor, Therapist) not found in DB.');
            process.exit(1);
        }

        console.log(`Creating test appointment...`);
        const apt = await prisma.appointment.create({
            data: {
                patientId: patient.id,
                doctorId: doctor.id,
                therapistId: therapist.id,
                date: new Date(),
                status: 'PENDING',
                branchId: patient.branchId
            }
        });

        console.log(`Initial Status: ${apt.status}`);

        // 2. Test: Doctor Approval
        console.log('\n--- Step 1: Doctor Approves ---');
        const afterDoc = await AppointmentService.approveAppointment(apt.id, { id: 'test', role: 'DOCTOR' });
        console.log(`Status after Doctor: ${afterDoc.status}`);
        console.log(`Flags: docApproved=${afterDoc.doctorApproved}, therApproved=${afterDoc.therapistApproved}`);

        if (afterDoc.status !== 'PENDING_THERAPIST_APPROVAL') {
            console.error('FAILED: Status should be PENDING_THERAPIST_APPROVAL');
        }

        // 3. Test: Therapist Approval
        console.log('\n--- Step 2: Therapist Approves ---');
        const afterTher = await AppointmentService.approveAppointment(apt.id, { id: 'test-ther', role: 'THERAPIST' });
        console.log(`Status after Therapist: ${afterTher.status}`);
        console.log(`Flags: docApproved=${afterTher.doctorApproved}, therApproved=${afterTher.therapistApproved}`);

        if (afterTher.status !== 'ACCEPTED') {
            console.error('FAILED: Status should be ACCEPTED');
        } else {
            console.log('Final Status is ACCEPTED as expected.');
        }

        // 4. Cleanup
        await prisma.appointment.delete({ where: { id: apt.id } });
        console.log('\n--- Test Cleanup Successful ---');
        console.log('--- Dual-Approval Verification Completed Successfully ---');

    } catch (error) {
        console.error('--- Verification Failed ---');
        console.error(error);
    } finally {
        await prisma.$disconnect();
    }
}

runTest();
