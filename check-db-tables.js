import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    try {
        console.log('Connecting to database...');
        // Query to list tables in PostgreSQL
        const result = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`;
        console.log('Tables in database:');
        console.table(result);

        // Check for both TriageSession and triage_sessions (Prisma might map it differently)
        const triageStartUpper = result.some(r => r.table_name === 'TriageSession');
        const triageStartLower = result.some(r => r.table_name === 'triage_session');

        console.log('TriageSession (exact match) exists:', triageStartUpper);
        console.log('triage_session (snake_case) exists:', triageStartLower);
    } catch (e) {
        console.error('Error querying database:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
