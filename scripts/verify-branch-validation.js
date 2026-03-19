
import { UserService } from '../services/user.service.js';
import { AuthService } from '../services/auth.service.js';
import prisma from '../lib/prisma.js';

async function testValidation() {
    console.log('--- Starting BranchId Validation Test ---');

    const testEmail = `test-${Date.now()}@example.com`;
    const invalidBranchId = 'non-existent-branch-id';

    // Test UserService.createUser with invalid branchId
    console.log('Test 1: UserService.createUser with invalid branchId...');
    try {
        await UserService.createUser({
            email: testEmail,
            password: 'password123',
            role: 'PATIENT',
            fullName: 'Test User',
            branchId: invalidBranchId
        });
        console.error('FAILED: UserService.createUser accepted invalid branchId');
    } catch (err) {
        if (err.status === 400 && err.message.includes('Invalid branchId')) {
            console.log('Success: UserService correctly rejected invalid branchId with 400');
        } else {
            console.error('FAILED: UserService threw unexpected error:', err);
        }
    }

    // Test AuthService.register with invalid branchId
    console.log('\nTest 2: AuthService.register with invalid branchId...');
    const testEmailAuth = `auth-${Date.now()}@example.com`;
    try {
        await AuthService.register({
            email: testEmailAuth,
            password: 'password123',
            role: 'PATIENT',
            branchId: invalidBranchId
        });
        console.error('FAILED: AuthService.register accepted invalid branchId');
    } catch (err) {
        if (err.status === 400 && err.message.includes('Invalid branchId')) {
            console.log('Success: AuthService correctly rejected invalid branchId with 400');
        } else {
            console.error('FAILED: AuthService threw unexpected error:', err);
        }
    }

    // Test with null (should work)
    console.log('\nTest 3: UserService.createUser with null branchId...');
    const testEmailNull = `null-${Date.now()}@example.com`;
    try {
        const user = await UserService.createUser({
            email: testEmailNull,
            password: 'password123',
            role: 'PATIENT',
            fullName: 'Null Branch User',
            branchId: null
        });
        console.log('Success: User created with null branchId');
        // Cleanup
        await prisma.user.delete({ where: { id: user.id } });
    } catch (err) {
        console.error('FAILED: User creation with null branchId failed:', err.message);
    }

    console.log('\n--- Validation Test Completed ---');
    await prisma.$disconnect();
}

testValidation();
