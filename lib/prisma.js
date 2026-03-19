
import { PrismaClient } from '@prisma/client';

// Singleton pattern: reuse the same PrismaClient instance across all modules.
// This prevents "MaxClientsInSessionMode" errors from too many connections.
const prisma = new PrismaClient();

export default prisma;
