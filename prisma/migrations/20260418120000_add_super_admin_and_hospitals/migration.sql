-- ── IWIS Super Admin: Phase A.1 — add SUPER_ADMIN role value ────────────────
-- ALTER TYPE ADD VALUE must run in its own migration; the new value cannot be
-- referenced in the same transaction it was added (Postgres constraint).

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
