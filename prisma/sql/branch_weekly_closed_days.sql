-- Adds `weeklyClosedDays` to Branch — an int[] of weekday ordinals (0 = Sun,
-- 6 = Sat) when the clinic is closed. Empty array = open every day.
--
-- Used by the StaffAttendance nightly reconcile to skip generating ABSENT
-- rows on days the branch isn't operating, addressing the audit finding
-- that Sunday was treated as a scheduled day for every doctor regardless
-- of whether the clinic was actually open that day.
--
-- Idempotent: safe to re-run; `ADD COLUMN IF NOT EXISTS` is a no-op when
-- the column already exists.

ALTER TABLE "Branch"
  ADD COLUMN IF NOT EXISTS "weeklyClosedDays" INTEGER[] NOT NULL DEFAULT '{}'::int[];
