import { PrismaClient } from '@prisma/client';
import { AppointmentService } from '../services/appointment.service.js';

const prisma = new PrismaClient();

async function runTest() {
    console.log('--- Reassignment Test Start ---');

    try {
        const adminUser = await prisma.user.findFirst({
            where: { role: { in: ['ADMIN', 'ADMIN_DOCTOR'] } }
        });
        if (!adminUser) throw new Error('No admin or admin doctor user found');
        console.log(`Using Admin: ${adminUser.email} (${adminUser.id})`);

        // Test getAvailableStaff
        console.log('\nTesting getAvailableStaff(allBranches=true)...');
        const allStaff = await AppointmentService.getAvailableStaff(adminUser, { allBranches: 'true' });
        console.log(`Found ${allStaff.doctors.length} doctors and ${allStaff.therapists.length} therapists`);

        // Find two different doctors
        const doctor1 = allStaff.doctors[0];
        const doctor2 = allStaff.doctors.find(d => d.id !== doctor1.id);

        if (!doctor1 || !doctor2) {
            console.log('Need at least 2 doctors in DB to test reassignment. Skipping reassignment test.');
            return;
        }
        console.log(`Doctor 1: ${doctor1.fullName} (${doctor1.id}) - Branch: ${doctor1.user.branch?.name}`);
        console.log(`Doctor 2: ${doctor2.fullName} (${doctor2.id}) - Branch: ${doctor2.user.branch?.name}`);

        // Find an existing appointment to reassign
        console.log('\nLooking for an existing appointment to reassign...');
        const existingAppt = await prisma.appointment.findFirst({
            where: { status: { in: ['SCHEDULED', 'CONFIRMED', 'PENDING'] } },
            include: { patient: true }
        });

        if (!existingAppt) {
            console.log('No active appointments found in DB to reassign. Skipping reassignment test.');
            return;
        }
        console.log(`Found appointment ${existingAppt.id} for patient ${existingAppt.patient.fullName}`);
        console.log(`Current Doctor: ${existingAppt.doctorId}`);

        // Perform reassignment
        const targetDoctorId = existingAppt.doctorId === doctor1.id ? doctor2.id : doctor1.id;
        console.log(`Reassigning to Doctor: ${targetDoctorId}`);

        const updated = await AppointmentService.updateAppointment(existingAppt.id, adminUser, {
            doctorId: targetDoctorId
        });

        if (updated.doctorId === targetDoctorId) {
            console.log('SUCCESS: Reassignment successful.');
        } else {
            throw new Error(`Reassignment failed. Doctor ID is still ${updated.doctorId}`);
        }

        // Verify Audit Log
        console.log('\nVerifying audit log entry...');
        const auditLog = await prisma.auditLog.findFirst({
            where: {
                entityId: existingAppt.id,
                action: 'REASSIGN'
            },
            orderBy: { createdAt: 'desc' }
        });

        if (auditLog) {
            console.log('SUCCESS: Reassignment audit log found.');
            console.log('Log Data:', JSON.stringify(auditLog.newData));
        } else {
            console.warn('WARNING: No audit log found. This might happen if oldData and newData match.');
        }

    } catch (error) {
        console.error('TEST FAILED:', error.message);
        if (error.stack) console.error(error.stack);
    } finally {
        await prisma.$disconnect();
    }
}

runTest();
