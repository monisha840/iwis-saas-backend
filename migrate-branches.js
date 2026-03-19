import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Multi-Branch Data Migration ---');

    try {
        // 1. Create Default Branch
        const mainBranch = await prisma.branch.upsert({
            where: { id: 'default-branch-id' }, // Fixed ID for easier reference in migration
            update: {},
            create: {
                id: 'default-branch-id',
                name: 'Main Clinic',
                address: 'Main St, City',
                phone: '1234567890',
                email: 'main@clinic.com',
                isActive: true
            }
        });
        console.log(`✓ Default Branch established: ${mainBranch.name}`);

        const branchId = mainBranch.id;

        // 2. Migrate Users
        const users = await prisma.user.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${users.count} Users`);

        // 3. Migrate Patients
        const patients = await prisma.patient.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${patients.count} Patients`);

        // 4. Migrate Operational Models
        const appointments = await prisma.appointment.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${appointments.count} Appointments`);

        const prescriptions = await prisma.prescription.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${prescriptions.count} Prescriptions`);

        const orders = await prisma.pharmacyOrder.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${orders.count} Pharmacy Orders`);

        const dispenses = await prisma.pharmacyDispense.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${dispenses.count} Pharmacy Dispenses`);

        const stocks = await prisma.medicineStock.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${stocks.count} Medicine Stocks`);

        const triage = await prisma.triageSession.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${triage.count} Triage Sessions`);

        const invoices = await prisma.invoice.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${invoices.count} Invoices`);

        const payments = await prisma.payment.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${payments.count} Payments`);

        const convos = await prisma.conversation.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${convos.count} Conversations`);

        const videoPrescriptions = await prisma.videoPrescription.updateMany({
            where: { branchId: null },
            data: { branchId }
        });
        console.log(`✓ Migrated ${videoPrescriptions.count} Video Prescriptions`);

        console.log('\n--- Migration Completed Successfully ---');

    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
