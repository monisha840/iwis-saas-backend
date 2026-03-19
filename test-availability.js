
import { PrismaClient } from '@prisma/client';
import { AvailabilityService } from './services/availability.service.js';

const prisma = new PrismaClient();

async function runTest() {
    console.log('--- Starting Availability Verification ---');

    try {
        // 1. Get a Doctor and a Therapist
        const doctor = await prisma.doctor.findFirst();
        const therapist = await prisma.therapist.findFirst();

        if (!doctor || !therapist) {
            console.error('Test failed: Could not find a doctor and a therapist in the database.');
            process.exit(1);
        }

        console.log(`Testing with Doctor ID: ${doctor.id} and Therapist ID: ${therapist.id}`);

        // 2. Clear existing blocks for these profiles to have a clean slate (optional but recommended for test)
        await prisma.blockedSlot.deleteMany({
            where: {
                OR: [
                    { doctorId: doctor.id },
                    { therapistId: therapist.id }
                ]
            }
        });

        // 3. Test: Create block for Doctor
        console.log('Test 1: Creating block for Doctor...');
        const docBlock = await AvailabilityService.createBlock({
            doctorId: doctor.id,
            date: new Date().toISOString(),
            startTime: '10:00',
            endTime: '11:00',
            reason: 'Verification Test Doc'
        });
        console.log('Success: Block created for Doctor');

        // 4. Test: Create block for Therapist
        console.log('Test 2: Creating block for Therapist...');
        const therBlock = await AvailabilityService.createBlock({
            therapistId: therapist.id,
            date: new Date().toISOString(),
            startTime: '14:00',
            endTime: '15:00',
            reason: 'Verification Test Ther'
        });
        console.log('Success: Block created for Therapist');

        // 5. Test: Overlap Validation (Doctor)
        console.log('Test 3: Testing overlap validation for Doctor...');
        try {
            await AvailabilityService.createBlock({
                doctorId: doctor.id,
                date: new Date().toISOString(),
                startTime: '10:30',
                endTime: '11:30',
                reason: 'Should Fail'
            });
            console.error('FAILED: Overlap validation did not catch duplicate slot!');
        } catch (err) {
            console.log(`Success: Overlap validation caught error: ${err.message}`);
        }

        // 6. Test: Check Availability (Doctor)
        console.log('Test 4: Testing checkAvailability for Doctor...');
        const checkDoc = await AvailabilityService.checkAvailability(doctor.id, new Date().toISOString(), '10:15', '10:45');
        if (!checkDoc.available) {
            console.log(`Success: checkAvailability correctly identified overlap. Reason: ${checkDoc.reason}`);
        } else {
            console.error('FAILED: checkAvailability said available when it should be blocked!');
        }

        // 7. Test: Check Availability (Therapist)
        console.log('Test 5: Testing checkAvailability for Therapist...');
        const checkTher = await AvailabilityService.checkAvailability(therapist.id, new Date().toISOString(), '14:15', '14:45');
        if (!checkTher.available) {
            console.log(`Success: checkAvailability correctly identified overlap for Therapist. Reason: ${checkTher.reason}`);
        } else {
            console.error('FAILED: checkAvailability for Therapist said available when it should be blocked!');
        }

        console.log('--- Verification Completed Successfully ---');

    } catch (error) {
        console.error('--- Verification Failed ---');
        console.error(error);
    } finally {
        await prisma.$disconnect();
    }
}

runTest();
