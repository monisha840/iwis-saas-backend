/**
 * Centralised Express error-handling middleware.
 *
 * Replaces the inline handler in index.js so every route/service error is:
 *  1. Structured-logged with full context
 *  2. Returned with a consistent shape  { error, code?, details?, stack? }
 *  3. Never leaks internals in production
 *
 * Mount LAST in index.js:  app.use(errorHandler);
 */

import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import logger from '../lib/logger.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // ── Zod validation ──────────────────────────────────────────────────────────
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    });
  }

  // ── Prisma known errors ──────────────────────────────────────────────────────
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const map = {
      P2002: [409, 'A record with that value already exists', 'DUPLICATE_ENTRY'],
      P2025: [404, 'Record not found', 'NOT_FOUND'],
      P2003: [409, 'Foreign key constraint failed', 'FOREIGN_KEY_VIOLATION'],
      P2014: [409, 'Relation violation', 'RELATION_VIOLATION'],
    };
    const [status = 400, message = 'Database error', code = 'DB_ERROR'] = map[err.code] ?? [];
    logger.warn(`[errorHandler] Prisma ${err.code}`, {
      meta: err.meta,
      url: req.url,
      userId: req.user?.id,
    });
    return res.status(status).json({ error: message, code });
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    logger.warn('[errorHandler] Prisma validation error', { url: req.url });
    return res.status(400).json({ error: 'Invalid data supplied to the database', code: 'DB_VALIDATION_ERROR' });
  }

  // ── Application-level HTTP errors (e.g. thrown as: const e = new Error('...'); e.status = 403) ──
  const status = err.status || err.statusCode || 500;

  // Sanitize request body before logging — strip any sensitive fields
  const SENSITIVE_FIELDS = ['password', 'passwordConfirm', 'currentPassword', 'newPassword', 'token', 'refreshToken', 'secret'];
  const sanitizedBody = req.body ? Object.fromEntries(
    Object.entries(req.body).map(([k, v]) =>
      [k, SENSITIVE_FIELDS.includes(k) ? '[REDACTED]' : v]
    )
  ) : undefined;

  // Log server errors with full stack, client errors briefly
  if (status >= 500) {
    logger.error(`[errorHandler] ${req.method} ${req.url} → ${status}`, err, {
      userId: req.user?.id,
      role: req.user?.role,
      body: sanitizedBody,
    });
  } else {
    logger.warn(`[errorHandler] ${req.method} ${req.url} → ${status}: ${err.message}`, {
      userId: req.user?.id,
    });
  }

  const isProduction = process.env.NODE_ENV === 'production';

  return res.status(status).json({
    error: isProduction && status >= 500 ? 'Internal Server Error' : err.message || 'Internal Server Error',
    code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    // Preserve extra payload fields that services may attach (e.g. suggestedSlot)
    ...(err.suggestedSlot && { suggestedSlot: err.suggestedSlot }),
    ...(!isProduction && status >= 500 && { stack: err.stack }),
  });
}

/**
 * Wrapper: turns an async route handler into one that forwards errors to next().
 * Usage:  router.get('/', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
