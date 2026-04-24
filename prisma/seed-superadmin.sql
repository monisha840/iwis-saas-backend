-- IWIS Super Admin — one-time SUPER_ADMIN seed (raw SQL fallback).
-- Password: SuperAdmin@1234 (CHANGE IMMEDIATELY ON FIRST LOGIN)
-- Skips if a SUPER_ADMIN already exists.
INSERT INTO "User" (
  "id", "email", "password", "role", "emailVerifiedAt",
  "mfaEnabled", "mfaBackupCodes", "hospitalId", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  'superadmin@sirah.digital',
  '$2b$12$bumblffw.attleNUcjfUy.XHrO.kuzkqLZb97O2UVcQMu7vFQ7Z8G',
  'SUPER_ADMIN',
  CURRENT_TIMESTAMP,
  FALSE,
  ARRAY[]::text[],
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "User" WHERE "role" = 'SUPER_ADMIN')
  AND NOT EXISTS (SELECT 1 FROM "User" WHERE "email" = 'superadmin@sirah.digital');
