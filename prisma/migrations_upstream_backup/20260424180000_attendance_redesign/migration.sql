-- Attendance redesign.
--
-- Two schema changes in support of deriving accurate attendance statuses
-- from the doctor's declared schedule and marking planned unavailability
-- (leave / WFH / off-hours) without manual intervention:
--
-- 1. AttendanceStatus enum gets a WFH value.
--    LEAVE already exists — it is treated as "approved leave that counts".
--    WFH indicates the clinician is working remotely today and should be
--    counted present for KPIs but distinguished on calendar views.
--
-- 2. BlockedSlot gets a kind column.
--    Clinicians and admins can now tag a blocked window as LEAVE | WFH |
--    OFF | OTHER so the attendance reconciliation job can translate a
--    full-day block into the right attendance status without guessing from
--    a free-text reason. Existing rows default to OTHER.

ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'WFH';

ALTER TABLE "BlockedSlot" ADD COLUMN "kind" TEXT;
UPDATE "BlockedSlot" SET "kind" = 'OTHER' WHERE "kind" IS NULL;
CREATE INDEX "BlockedSlot_kind_idx" ON "BlockedSlot" ("kind");
