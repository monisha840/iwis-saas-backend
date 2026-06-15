-- Tighten referential integrity on TriageOverride.reviewerUserId → User.id.
-- Without this FK, hard-deleting a reviewer would leave dangling override rows.
-- ON DELETE SET NULL keeps the audit trail even if the reviewer account is later removed.

ALTER TABLE "TriageOverride" ALTER COLUMN "reviewerUserId" DROP NOT NULL;

ALTER TABLE "TriageOverride"
  ADD CONSTRAINT "TriageOverride_reviewerUserId_fkey"
  FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
