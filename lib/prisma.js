
import { PrismaClient } from '@prisma/client';
import logger from './logger.js';

/**
 * Prisma singleton — enforces a single connection pool per process.
 *
 * Connection-pool tuning:
 *   DB_POOL_SIZE    → connection_limit  (default 10)
 *   DB_POOL_TIMEOUT → pool_timeout in seconds (default 10)
 *   These are appended as query params to DATABASE_URL at runtime so the
 *   Prisma engine picks them up without touching the .env value itself.
 *
 * • In development: query logging enabled so slow/missing-index queries surface early.
 * • In production:  only error events are forwarded to the structured logger.
 * • Graceful shutdown: SIGINT/SIGTERM disconnect the client before the process exits to flush
 *   in-flight queries and avoid leaving idle connections in the pool (critical for horizontal
 *   scaling behind a connection pooler such as pgBouncer / Supabase pooler).
 */

// ── Build the pooled DATABASE_URL ────────────────────────────────────────────
function buildDatasourceUrl() {
  const baseUrl = process.env.DATABASE_URL || '';
  if (!baseUrl) return baseUrl;

  const poolSize = process.env.DB_POOL_SIZE || '10';
  const poolTimeout = process.env.DB_POOL_TIMEOUT || '10';

  const url = new URL(baseUrl);

  // Only set if not already provided in the URL
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', poolSize);
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', poolTimeout);
  }

  return url.toString();
}

// ── Log configuration ────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV !== 'production';

const logConfig = isDev
  ? [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'query' },
    ]
  : [{ emit: 'event', level: 'error' }];

// ── Singleton guard ──────────────────────────────────────────────────────────
const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log: logConfig,
    errorFormat: isDev ? 'colorless' : 'minimal',
    datasourceUrl: buildDatasourceUrl(),
  });

if (!globalForPrisma.__prisma) {
  globalForPrisma.__prisma = prisma;
}

// ── Forward Prisma events to the structured logger ───────────────────────────
prisma.$on('error', (e) => {
  logger.error('[Prisma] DB Error', new Error(e.message), { target: e.target, timestamp: e.timestamp });
});

prisma.$on('warn', (e) => {
  logger.warn('[Prisma] DB Warning', { message: e.message, timestamp: e.timestamp });
});

// Query logging in dev — restricted to slow queries by default so a normal
// dev session doesn't flood the console with hundreds of fast SELECTs.
//   - PRISMA_QUERY_LOG_THRESHOLD_MS (default 50) → only log queries that take
//     longer than the threshold. Set to 0 to log every query.
//   - PRISMA_QUERY_LOG=verbose → bypass the threshold entirely.
if (isDev) {
  const verbose = process.env.PRISMA_QUERY_LOG === 'verbose';
  const thresholdMs = parseInt(process.env.PRISMA_QUERY_LOG_THRESHOLD_MS ?? '50', 10);
  prisma.$on('query', (e) => {
    if (!verbose && e.duration < thresholdMs) return;
    logger.info('[Prisma] Query', { query: e.query, duration: `${e.duration}ms`, params: e.params });
  });
}

// ── Graceful shutdown — prevent zombie connections on SIGTERM / SIGINT ────────
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
