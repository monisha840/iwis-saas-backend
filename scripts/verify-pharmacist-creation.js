
import { UserService } from '../services/user.service.js';
import prisma from '../lib/prisma.js';

async function testPharmacistCreation() {
    console.log('--- Starting Pharmacist Creation Test ---');

    const testEmail = `pharmacist-${Date.now()}@example.com`;
    const branchId = 'default-branch-id'; // using a known valid ID from previous run

    console.log(`Test: Creating Pharmacist with branchId: ${branchId}...`);
    try {
        const user = await UserService.createUser({
            email: testEmail,
            password: 'password123',
            role: 'PHARMACIST',
            fullName: 'Test Pharmacist',
            branchId: branchId
        });
        console.log('Success: Pharmacist created successfully without schema error!');

        // Cleanup
        await prisma.pharmacist.delete({ where: { userId: user.id } });
        await prisma.user.delete({ where: { id: user.id } });
        console.log('Cleanup completed.');
    } catch (err) {
        console.error('FAILED: Pharmacist creation failed:', err.message);
        if (err.message.includes('Unknown argument')) {
            console.error('Root cause: Still passing invalid arguments to Prisma.');
        }
    }

    console.log('\n--- Pharmacist Creation Test Completed ---');
    await prisma.$disconnect();
}

testPharmacistCreation();
