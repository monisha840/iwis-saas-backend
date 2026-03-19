import { PrismaClient } from '@prisma/client';
import { inventoryService } from './services/inventory.service.js';

const prisma = new PrismaClient();

async function runTest() {
    console.log('--- STARTING INVENTORY FLOW TEST ---');

    try {
        // 1. Setup Mock Medicine
        const medicineName = 'Test Medicine ' + Date.now();
        const medicine = await prisma.medicine.create({
            data: {
                name: medicineName,
                price: 100,
                brand: 'Test Brand',
                category: 'Tablet'
            }
        });
        console.log(`Created medicine: ${medicineName}`);

        // 2. Add Stock
        const stock = await prisma.medicineStock.create({
            data: {
                medicineId: medicine.id,
                batchNumber: 'B001',
                expiryDate: new Date('2027-01-01'),
                quantity: 15,
                minStock: 5
            }
        });
        console.log(`Added 15 units of stock (minStock: 5)`);

        // 3. Check Stock (Prescription Flow Simulate)
        console.log('--- Simulating Prescription Stock Check ---');
        const stockStatusBefore = await inventoryService.checkStockByMedicineName(medicineName);
        console.log('Stock Status:', stockStatusBefore);
        if (!stockStatusBefore.available || stockStatusBefore.quantity !== 15) {
            throw new Error('Initial stock check failed');
        }

        // 4. Deduct Stock (Dispense Flow Simulate)
        console.log('--- Simulating Dispense Stock Deduction (12 units) ---');
        await prisma.$transaction(async (tx) => {
            await inventoryService.deductStock(tx, [
                { medicineId: medicine.id, quantity: 12 }
            ]);
        });

        // 5. Verify Deduction and Low Stock Alert
        const stockStatusAfter = await inventoryService.checkStockByMedicineName(medicineName);
        console.log('Stock Status After Deduction:', stockStatusAfter);
        if (stockStatusAfter.quantity !== 3) {
            throw new Error(`Deduction failed. Expected 3, got ${stockStatusAfter.quantity}`);
        }
        if (!stockStatusAfter.lowStock) {
            throw new Error('Low stock flag should be true');
        }
        console.log('Success: Stock correctly deducted and low stock detected.');

        // 6. Bulk Check Low Stock
        console.log('--- Checking Bulk Low Stock Method ---');
        const lowStockList = await inventoryService.getLowStockMedicines();
        const found = lowStockList.find(m => m.id === medicine.id);
        if (!found) {
            throw new Error('Medicine not found in low stock list');
        }
        console.log('Success: Medicine found in bulk low stock list.');

        console.log('--- ALL TESTS PASSED ---');

    } catch (error) {
        console.error('TEST FAILED:', error);
    } finally {
        // Cleanup if possible (optional)
        // await prisma.medicineStock.deleteMany({ where: { medicineId: medicine.id } });
        // await prisma.medicine.delete({ where: { id: medicine.id } });
        await prisma.$disconnect();
    }
}

runTest();
