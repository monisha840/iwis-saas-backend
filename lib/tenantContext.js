/**
 * Per-request tenant context via AsyncLocalStorage.
 *
 * Each incoming request runs in its own async "lane". The auth layer tags the
 * lane with the caller's hospitalId via `runWithTenant(...)`, and the Prisma
 * client extension (lib/prisma.js) reads it with `getCurrentTenant()` to scope
 * every query automatically — no need to thread hospitalId through call sites.
 *
 * IMPORTANT:
 *   - When no tenant is set (getCurrentTenant() === null) the Prisma extension
 *     does NOT filter. That is intentional: SUPER_ADMIN, background jobs, scripts,
 *     and the pre-auth login flow run unscoped.
 *   - SUPER_ADMIN is wired to run with a null tenant, so it sees all hospitals.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with the given hospitalId bound to the current async context.
 * Pass null/undefined to run unscoped (SUPER_ADMIN / system).
 * @param {string|null|undefined} hospitalId
 * @param {Function} fn
 */
export function runWithTenant(hospitalId, fn) {
  return storage.run({ hospitalId: hospitalId ?? null }, fn);
}

/** @returns {string|null} the current request's hospitalId, or null if unscoped. */
export function getCurrentTenant() {
  const store = storage.getStore();
  return store ? store.hospitalId : null;
}

export { storage as tenantStorage };
