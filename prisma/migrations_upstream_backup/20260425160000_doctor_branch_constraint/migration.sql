-- Branch isolation: every DOCTOR user must be permanently scoped to a branch.
-- A NULL branchId for a DOCTOR would defeat the requireBranchScoped middleware
-- (the middleware would 403 every request). Enforce at the DB so a buggy code
-- path or seed script can never produce a doctor without a branch.
--
-- If this migration fails to apply, backfill the offending rows first:
--   SELECT id, email FROM "User" WHERE role = 'DOCTOR' AND "branchId" IS NULL;
-- Then re-run `prisma migrate deploy`.

ALTER TABLE "User"
    ADD CONSTRAINT "User_doctor_requires_branch"
    CHECK (role <> 'DOCTOR' OR "branchId" IS NOT NULL);
