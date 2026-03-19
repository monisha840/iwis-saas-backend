import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
    try {
        const users = await prisma.user.findMany();
        console.log('Users in database:');
        users.forEach(u => {
            console.log(`- Email: ${u.email}, Role: ${u.role}, ID: ${u.id}`);
        });
    } catch (error) {
        console.error('Error fetching users:', error);
    } finally {
        await prisma.$disconnect();
    }
}
main();
