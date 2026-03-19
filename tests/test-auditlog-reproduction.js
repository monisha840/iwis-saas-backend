import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function test() {
    try {
        const user = await prisma.user.findFirst();
        console.log(`Using user ID: ${user.id}`);

        await prisma.auditLog.create({
            data: {
                user: { connect: { id: user.id } },
                action: 'TEST_ACTION',
                entityType: 'TEST_ENTITY',
                message: 'Test message'
            }
        });
        console.log('Audit log created successfully with user.connect');
    } catch (err) {
        console.error('AuditLog creation FAILED:');
        console.error(err);
    } finally {
        await prisma.$disconnect();
    }
}

test();
