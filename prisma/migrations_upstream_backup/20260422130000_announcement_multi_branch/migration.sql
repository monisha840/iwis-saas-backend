-- Converts Announcement → Branch from single-optional FK to implicit M2M so
-- an announcement can target multiple specific branches. Empty set retains
-- the "all branches" semantics that `branchId = NULL` had before.
--
-- Prisma implicit-M2M table convention: two columns "A"/"B" referencing the
-- alphabetically-first/second model names. "Announcement" < "Branch", so
-- A = announcementId, B = branchId.

CREATE TABLE "_AnnouncementTargetBranches" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_AnnouncementTargetBranches_AB_pkey" PRIMARY KEY ("A","B")
);

CREATE INDEX "_AnnouncementTargetBranches_B_index"
    ON "_AnnouncementTargetBranches"("B");

ALTER TABLE "_AnnouncementTargetBranches"
    ADD CONSTRAINT "_AnnouncementTargetBranches_A_fkey"
    FOREIGN KEY ("A") REFERENCES "Announcement"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_AnnouncementTargetBranches"
    ADD CONSTRAINT "_AnnouncementTargetBranches_B_fkey"
    FOREIGN KEY ("B") REFERENCES "Branch"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing single-branch announcements
INSERT INTO "_AnnouncementTargetBranches" ("A", "B")
SELECT "id", "branchId" FROM "Announcement" WHERE "branchId" IS NOT NULL;

-- Drop the old FK + index + column
ALTER TABLE "Announcement" DROP CONSTRAINT IF EXISTS "Announcement_branchId_fkey";
DROP INDEX IF EXISTS "Announcement_branchId_idx";
ALTER TABLE "Announcement" DROP COLUMN "branchId";
