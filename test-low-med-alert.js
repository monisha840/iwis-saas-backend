import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import { PrescriptionService } from './services/prescription.service.js';
import { PharmacyService } from './services/pharmacy.service.js';
import { WellnessService } from './services/wellness.service.js';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Medication Notification System Test ---');

    try {
        // 1. Find or create test entities
        const doctor = await prisma.user.findFirst({ where: { role: 'DOCTOR' }, include: { doctor: true } });
        const patient = await prisma.user.findFirst({ where: { role: 'PATIENT' }, include: { patient: true } });
        const pharmacist = await prisma.user.findFirst({ where: { role: 'PHARMACIST' }, include: { pharmacist: true } });
        const medicine = await prisma.medicine.findFirst();

        if (!doctor || !patient || !pharmacist || !medicine) {
            console.error('Missing required entities for test. Please seed the database.');
            return;
        }

        console.log(`Using Doctor: ${doctor.email}, Patient: ${patient.email}, Pharmacist: ${pharmacist.email}, Medicine: ${medicine.name}`);

        // 1.5 Create appointment to authorize prescribing
        console.log('\n1.5 Creating appointment...');
        await prisma.appointment.create({
            data: {
                patientId: patient.patient.id,
                doctorId: doctor.doctor.id,
                date: new Date(),
                status: 'COMPLETED'
            }
        });
        console.log('✓ Appointment created.');

        // 2. Doctor prescribes medicine
        console.log('\n2. Prescribing medicine...');
        const prescription = await PrescriptionService.addPrescription(
            doctor,
            {
                patientId: patient.patient.id,
                medicationName: medicine.name,
                dosage: '1 tablet',
                frequency: 'Daily',
                duration: '10 days',
                medicineId: medicine.id,
                lowStockThreshold: 3 // Set threshold to 3
            }
        );
        console.log(`✓ Prescription created. Total Quantity: ${prescription.totalQuantity}, Threshold: ${prescription.lowStockThreshold}`);

        // 3. Pharmacist dispenses medicine
        console.log('\n3. Dispensing medicine...');
        await PharmacyService.dispenseMedicines(pharmacist.id, {
            patientId: patient.patient.id,
            prescriptionId: prescription.id,
            items: [{ medicineId: medicine.id, quantity: 5 }] // Dispense 5 units
        });

        const updatedPresc = await prisma.prescription.findUnique({ where: { id: prescription.id } });
        console.log(`✓ Dispensed 5 units. New Total Quantity: ${updatedPresc.totalQuantity}`);

        // 4. Patient logs doses until threshold
        console.log('\n4. Logging doses...');
        for (let i = 1; i <= 3; i++) {
            await WellnessService.submitMedicationLog(patient.id, {
                prescriptionId: prescription.id,
                quantityTaken: 1,
                date: new Date().toISOString(),
                notes: `Dose ${i}`
            });
            const p = await prisma.prescription.findUnique({ where: { id: prescription.id } });
            console.log(`✓ Logged dose ${i}. Remaining: ${p.totalQuantity}`);
        }

        console.log('\nFinal check:');
        const finalPresc = await prisma.prescription.findUnique({ where: { id: prescription.id } });
        console.log(`Remaining: ${finalPresc.totalQuantity}, Threshold: ${finalPresc.lowStockThreshold}`);

        const notifications = await prisma.notification.findMany({
            where: { type: 'SYSTEM_ALERT' },
            orderBy: { createdAt: 'desc' },
            take: 3
        });

        console.log(`\nNotifications triggered (${notifications.length}):`);
        notifications.forEach(n => {
            console.log(`- To UserID ${n.userId.substring(0, 8)}...: [${n.title}] ${n.message}`);
        });

    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
