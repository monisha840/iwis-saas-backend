import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import { PharmacyService } from './services/pharmacy.service.js';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Medicine Ordering System Test ---');

    try {
        // 1. Setup entities
        const patient = await prisma.user.findFirst({ where: { role: 'PATIENT' }, include: { patient: true } });
        const admin = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'ADMIN_DOCTOR'] } } });
        const pharmacist = await prisma.user.findFirst({ where: { role: 'PHARMACIST' } });
        const medicine = await prisma.medicine.findFirst({ include: { stocks: true } });

        if (!patient || !admin || !pharmacist || !medicine) {
            console.error('Missing test data.');
            return;
        }

        const initialStock = medicine.stocks.reduce((sum, s) => sum + s.quantity, 0);
        console.log(`Using Patient: ${patient.email}, Admin: ${admin.email}, Medicine: ${medicine.name} (Stock: ${initialStock})`);

        // 2. Admin creates order
        console.log('\n2. Creating order...');
        const order = await PharmacyService.createOrder(admin.id, {
            patientId: patient.patient.id,
            urgency: 'URGENT',
            items: [{ medicineId: medicine.id, quantity: 2 }],
            notes: 'Test order'
        });
        console.log(`✓ Order created: ${order.id}. Status: ${order.status}, Total: ${order.totalAmount}`);

        // 3. Pharmacist approves order
        console.log('\n3. Approving order...');
        await PharmacyService.updateOrderStatus(pharmacist.id, order.id, 'APPROVED');
        let updatedOrder = await prisma.pharmacyOrder.findUnique({ where: { id: order.id } });
        console.log(`✓ Status updated to: ${updatedOrder.status}`);

        // 4. Pharmacist delivers order (triggers dispense)
        console.log('\n4. Delivering order (fulfillment)...');
        await PharmacyService.updateOrderStatus(pharmacist.id, order.id, 'DELIVERED');
        updatedOrder = await prisma.pharmacyOrder.findUnique({ where: { id: order.id } });
        console.log(`✓ Status updated to: ${updatedOrder.status}`);

        // 5. Verify outcomes
        console.log('\n5. Verifying outcomes...');

        // Check dispense record
        const dispense = await prisma.pharmacyDispense.findFirst({
            where: { orderId: order.id },
            include: { items: true }
        });
        if (dispense) {
            console.log(`✓ Dispense record found. Total: ${dispense.totalAmount}`);
        } else {
            console.error('✗ Dispense record NOT found!');
        }

        // Check inventory
        const updatedMedicine = await prisma.medicine.findUnique({ where: { id: medicine.id }, include: { stocks: true } });
        const finalStock = updatedMedicine.stocks.reduce((sum, s) => sum + s.quantity, 0);
        console.log(`Final Stock: ${finalStock} (Expected: ${initialStock - 2})`);

        if (finalStock === initialStock - 2) {
            console.log('✓ Inventory correctly updated.');
        } else {
            console.error('✗ Inventory mismatch!');
        }

        console.log('\n--- Test Completed Successfully ---');

    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
