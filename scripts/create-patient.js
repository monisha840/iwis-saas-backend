
import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    const email = 'patient@iwis';
    const password = 'Patient@123';
    const role = 'PATIENT';

    try {
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            console.log('User already exists:', email);
            return;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
                role,
                patient: {
                    create: {
                        fullName: 'Test Patient',
                    }
                }
            },
        });

        console.log('Created user:', user.email, 'with ID:', user.id);
    } catch (error) {
        console.error('Error creating user:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
