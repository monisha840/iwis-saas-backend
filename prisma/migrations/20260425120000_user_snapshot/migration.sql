-- Flattened, role-agnostic snapshot of every user. Kept in sync via
-- UserService.upsertSnapshot() on user create / update / soft-delete so
-- the admin export endpoint can serve a single denormalised query.

CREATE TABLE "UserSnapshot" (
    "userId"      TEXT NOT NULL,
    "fullName"    TEXT,
    "email"       TEXT NOT NULL,
    "role"        TEXT NOT NULL,
    "branchId"    TEXT,
    "branchName"  TEXT,
    "hospitalId"  TEXT,
    "phoneNumber" TEXT,
    "status"      TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserSnapshot_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserSnapshot"
    ADD CONSTRAINT "UserSnapshot_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "UserSnapshot_role_idx"       ON "UserSnapshot"("role");
CREATE INDEX "UserSnapshot_branchId_idx"   ON "UserSnapshot"("branchId");
CREATE INDEX "UserSnapshot_hospitalId_idx" ON "UserSnapshot"("hospitalId");
CREATE INDEX "UserSnapshot_status_idx"     ON "UserSnapshot"("status");

-- Backfill from current state. Pull the role-specific fullName/phoneNumber
-- via LEFT JOINs so unknown role tables produce NULLs cleanly.
INSERT INTO "UserSnapshot" (
    "userId", "fullName", "email", "role", "branchId", "branchName",
    "hospitalId", "phoneNumber", "status", "createdAt", "updatedAt"
)
SELECT
    u."id"                                                                       AS "userId",
    COALESCE(d."fullName", t."fullName", p."fullName", ph."fullName", NULL)      AS "fullName",
    u."email"                                                                    AS "email",
    u."role"::text                                                               AS "role",
    u."branchId"                                                                 AS "branchId",
    b."name"                                                                     AS "branchName",
    u."hospitalId"                                                               AS "hospitalId",
    p."phoneNumber"                                                              AS "phoneNumber",
    CASE WHEN u."deletedAt" IS NOT NULL THEN 'DELETED' ELSE 'ACTIVE' END          AS "status",
    u."createdAt"                                                                AS "createdAt",
    NOW()                                                                        AS "updatedAt"
FROM "User" u
LEFT JOIN "Doctor"     d  ON d."userId"  = u."id"
LEFT JOIN "Therapist"  t  ON t."userId"  = u."id"
LEFT JOIN "Patient"    p  ON p."userId"  = u."id"
LEFT JOIN "Pharmacist" ph ON ph."userId" = u."id"
LEFT JOIN "Branch"     b  ON b."id"      = u."branchId"
ON CONFLICT ("userId") DO NOTHING;
