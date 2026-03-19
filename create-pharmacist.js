import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    const email = 'pharmacist@iwis.com';
    const password = 'Pharmacist@123';
    const role = 'PHARMACIST';
    const fullName = 'Pharma Specialist';

    const hashedPassword = await bcrypt.hash(password, 10);

    try {
        const user = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
                role,
                pharmacist: {
                    create: {
                        fullName,
                        qualification: 'B.Pharm',
                        yearsExperience: 5
                    }
                }
            }
        });
        console.log(`✓ Pharmacist created: ${email}`);
        console.log(`  Password: ${password}`);
    } catch (error) {
        if (error.code === 'P2002') {
            console.log('✓ Pharmacist already exists');
        } else {
            console.error('Error creating pharmacist:', error);
        }
    } finally {
        await prisma.$disconnect();
    }
}

main();
