
import { PrismaClient } from '@prisma/client';
import { UserService } from './services/user.service.js';
import { AvailabilityService } from './services/availability.service.js';

const prisma = new PrismaClient();

async function runTest() {
    console.log('--- Starting Assignment System Verification ---');

    try {
        // 1. Get test entities
        const patient = await prisma.patient.findFirst({ include: { branch: true } });
        const doctor = await prisma.doctor.findFirst({ include: { user: { include: { branch: true } } } });

        if (!patient || !doctor) {
            console.error('Test failed: Could not find patient or doctor.');
            process.exit(1);
        }

        console.log(`Testing with Patient: ${patient.fullName} (Branch: ${patient.branch?.name})`);
        console.log(`Testing with Doctor: ${doctor.fullName} (Branch: ${doctor.user?.branch?.name})`);

        // 2. Test: Branch List Filtering
        console.log('Test 1: Testing branch-based doctor listing...');
        const branchDoctors = await UserService.listDoctors(patient.branchId);
        const crossBranch = branchDoctors.find(d => d.branchId !== patient.branchId);
        if (crossBranch) {
            console.error('FAILED: listDoctors returned a doctor from a different branch!');
        } else {
            console.log(`Success: Found ${branchDoctors.length} doctors in branch ${patient.branch?.name}`);
        }

        // 3. Test: Availability Slot Generation
        console.log('Test 2: Testing availability slot generation...');
        const slots = await AvailabilityService.getAvailableSlots(doctor.id, new Date());
        console.log(`Success: Found ${slots.length} available slots for Dr. ${doctor.fullName}`);
        console.log('Slots:', slots.slice(0, 3).join(', ') + (slots.length > 3 ? '...' : ''));

        // 4. Test: Cross-branch Assignment (Conditional)
        if (patient.branchId && doctor.user?.branchId && patient.branchId !== doctor.user.branchId) {
            console.log('Test 3: Testing cross-branch assignment restriction...');
            try {
                await UserService.assignPatient({ patientId: patient.id, doctorId: doctor.id });
                console.error('FAILED: Cross-branch assignment should have thrown an error!');
            } catch (err) {
                console.log(`Success: Blocked cross-branch assignment: ${err.message}`);
            }
        } else {
            console.log('Skipping Test 3: Patient and Doctor are in the same branch.');
        }

        console.log('--- Assignment Verification Completed ---');

    } catch (error) {
        console.error('--- Verification Failed ---');
        console.error(error);
    } finally {
        await prisma.$disconnect();
    }
}

runTest();
