
import { PharmacyService } from '../services/pharmacy.service.js';
import prisma from '../lib/prisma.js';

const ayurvedicMedicines = [
    {
        name: 'Ashwagandha Tablets',
        sku: 'AYU-001',
        category: 'Ayurvedic',
        type: 'Tablet',
        brand: 'Al-Shifa',
        price: 15.0,
        stock: 100,
        description: 'Vitality and stress relief.'
    },
    {
        name: 'Triphala Churna',
        sku: 'AYU-002',
        category: 'Ayurvedic',
        type: 'Powder',
        brand: 'Al-Shifa',
        price: 10.0,
        stock: 50,
        description: 'Digestive health.'
    },
    {
        name: 'Brahmi Syrup',
        sku: 'AYU-003',
        category: 'Ayurvedic',
        type: 'Syrup',
        brand: 'Al-Shifa',
        price: 20.0,
        stock: 30,
        description: 'Memory and cognitive support.'
    },
    {
        name: 'Giloy Tablets',
        sku: 'AYU-004',
        category: 'Ayurvedic',
        type: 'Tablet',
        brand: 'Al-Shifa',
        price: 12.0,
        stock: 80,
        description: 'Immunity booster.'
    },
    {
        name: 'Arjuna Capsules',
        sku: 'AYU-005',
        category: 'Ayurvedic',
        type: 'Capsule',
        brand: 'Al-Shifa',
        price: 18.0,
        stock: 40,
        description: 'Heart health.'
    },
    {
        name: 'Neem Capsules',
        sku: 'AYU-006',
        category: 'Ayurvedic',
        type: 'Capsule',
        brand: 'Al-Shifa',
        price: 14.0,
        stock: 60,
        description: 'Blood purifier and skin health.'
    }
];

async function seed() {
    console.log('--- Seeding Ayurvedic Medicines ---');

    // Get a default branch if it exists, otherwise use null
    const branch = await prisma.branch.findFirst();
    const branchId = branch?.id || null;

    for (const med of ayurvedicMedicines) {
        try {
            const result = await PharmacyService.addMedicine({ ...med, branchId });
            console.log(`Successfully added: ${result.name} (${result.sku})`);
        } catch (error) {
            if (error.status === 409) {
                console.log(`Skipped: ${med.name} (${med.sku}) - Already exists`);
            } else {
                console.error(`Error adding ${med.name}:`, error.message);
            }
        }
    }

    console.log('--- Seeding Completed ---');
    await prisma.$disconnect();
}

seed();
