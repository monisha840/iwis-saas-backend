import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Minimal Seed for Med Test ---');
    try {
        const medicine = await prisma.medicine.upsert({
            where: { id: 'test-med-001' },
            update: {},
            create: {
                id: 'test-med-001',
                name: 'Test Aspirin',
                price: 5.0,
                stocks: {
                    create: {
                        batchNumber: 'B123',
                        expiryDate: new Date('2026-12-31'),
                        quantity: 100,
                        minStock: 10
                    }
                }
            }
        });
        console.log(`✓ Medicine ready: ${medicine.name}`);
    } catch (err) {
        console.error('Seed failed:', err);
    } finally {
        await prisma.$disconnect();
    }
}
main();
