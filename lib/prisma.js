
import { PrismaClient } from '@prisma/client';
import logger from './logger.js';

/**
 * Prisma singleton — enforces a single connection pool per process.
 *
 * • In development: query logging enabled so slow/missing-index queries surface early.
 * • In production:  only error events are forwarded to the structured logger.
 * • Graceful shutdown: SIGINT/SIGTERM disconnect the client before the process exits to flush
 *   in-flight queries and avoid leaving idle connections in the pool (critical for horizontal
 *   scaling behind a connection pooler such as pgBouncer / Supabase pooler).
 */

const logConfig =
  process.env.NODE_ENV === 'production'
    ? [{ emit: 'event', level: 'error' }]
    : [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
        // Uncomment next line to log every query in dev (very verbose):
        // { emit: 'event', level: 'query' },
      ];

const prisma = new PrismaClient({
  log: logConfig,
  errorFormat: process.env.NODE_ENV === 'production' ? 'minimal' : 'colorless',
});

// Forward Prisma events to the structured logger
prisma.$on('error', (e) => {
  logger.error('[Prisma] DB Error', new Error(e.message), { target: e.target, timestamp: e.timestamp });
});

prisma.$on('warn', (e) => {
  logger.warn('[Prisma] DB Warning', { message: e.message, timestamp: e.timestamp });
});

// query-level events are only enabled above if explicitly un-commented
if (process.env.DB_LOG_QUERIES === 'true') {
  prisma.$on('query', (e) => {
    logger.info('[Prisma] Query', { query: e.query, duration: `${e.duration}ms`, params: e.params });
  });
}

// Graceful shutdown — prevent zombie connections on SIGTERM / SIGINT
async function disconnectPrisma() {
  try {
    await prisma.$disconnect();
    logger.info('[Prisma] Disconnected from database');
  } catch (err) {
    logger.error('[Prisma] Failed to disconnect', err);
  }
}

process.on('SIGTERM', disconnectPrisma);
process.on('SIGINT', disconnectPrisma);

export default prisma;
