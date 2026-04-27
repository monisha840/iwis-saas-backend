-- Add structured per-region pain log to DailyCheckIn so the body-map step of
-- the daily check-in can persist a full pain-region array (mirrors
-- TriageSession.painRegions). Nullable for backwards compatibility with
-- existing rows that only have the scalar painLevel.
ALTER TABLE "DailyCheckIn" ADD COLUMN "painRegions" JSONB;
