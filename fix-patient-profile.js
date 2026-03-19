import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixMissingPatientProfiles() {
    try {
        console.log('🔍 Checking for users without patient profiles...');

        // Find all users with PATIENT role
        const patients = await prisma.user.findMany({
            where: { role: 'PATIENT' },
            include: { patient: true },
        });

        console.log(`📊 Found ${patients.length} users with PATIENT role`);

        // Count users missing patient profiles
        const missingProfiles = patients.filter(u => !u.patient);
        console.log(`⚠️  ${missingProfiles.length} users missing patient profiles`);

        if (missingProfiles.length === 0) {
            console.log('✅ All patient users have profiles!');
            await prisma.$disconnect();
            return;
        }

        // Fix missing profiles
        console.log('🔧 Creating missing patient profiles...');
        for (const user of missingProfiles) {
            const created = await prisma.patient.create({
                data: {
                    userId: user.id,
                },
            });
            console.log(`   ✅ Created patient profile for ${user.email} (ID: ${created.id})`);
        }

        console.log('✨ All missing patient profiles created successfully!');
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

fixMissingPatientProfiles();
