-- F03 · Multimodal Diagnostic AI — extend existing TongueObservation to
-- accept patient-side daily check-in captures + GPT-4o vision analysis.
-- Idempotent so a same-session re-apply via the pooler is safe.

-- 1) Relax the legacy NOT NULL columns so check-in records (which have no
--    SelfExamSubmission / dayIndex / observedOn) can coexist with self-exam
--    records in the same table.
ALTER TABLE "TongueObservation" ALTER COLUMN "submissionId"     DROP NOT NULL;
ALTER TABLE "TongueObservation" ALTER COLUMN "dayIndex"         DROP NOT NULL;
ALTER TABLE "TongueObservation" ALTER COLUMN "observedOn"       DROP NOT NULL;
ALTER TABLE "TongueObservation" ALTER COLUMN "coatingColor"     DROP NOT NULL;
ALTER TABLE "TongueObservation" ALTER COLUMN "coatingThickness" DROP NOT NULL;

-- 2) Drop the legacy unique constraint on (submissionId, dayIndex) — with
--    nullable columns Postgres still allows multiple NULLs, but Prisma will
--    re-generate the constraint as a composite if we leave it, mismatching
--    our intent. The check-in path uniqueness is enforced by checkInId @unique.
DROP INDEX IF EXISTS "TongueObservation_submissionId_dayIndex_key";

-- 3) Add F03 columns. observedAt has a default so existing rows backfill
--    cleanly without a separate UPDATE.
ALTER TABLE "TongueObservation"
    ADD COLUMN IF NOT EXISTS "checkInId"          TEXT,
    ADD COLUMN IF NOT EXISTS "observedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS "aiCoatingColour"    TEXT,
    ADD COLUMN IF NOT EXISTS "aiCoatingThickness" TEXT,
    ADD COLUMN IF NOT EXISTS "aiMoisture"         TEXT,
    ADD COLUMN IF NOT EXISTS "doshaIndication"    TEXT,
    ADD COLUMN IF NOT EXISTS "confidence"         DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "analysisNotes"      TEXT,
    ADD COLUMN IF NOT EXISTS "rawAnalysis"        TEXT,
    ADD COLUMN IF NOT EXISTS "alertEmitted"       BOOLEAN NOT NULL DEFAULT false;

-- 4) Backfill observedAt for any pre-existing rows so analytics can use a
--    single time column across both paths. Use observedOn if present,
--    otherwise the row's createdAt.
UPDATE "TongueObservation"
   SET "observedAt" = COALESCE("observedOn", "createdAt", CURRENT_TIMESTAMP)
 WHERE "observedAt" = CURRENT_TIMESTAMP
       AND "createdAt" < CURRENT_TIMESTAMP - INTERVAL '1 second';

-- 5) Unique constraint on checkInId so a single check-in can never receive
--    two distinct observations (matches the @@unique in schema.prisma).
CREATE UNIQUE INDEX IF NOT EXISTS "TongueObservation_checkInId_key"
    ON "TongueObservation" ("checkInId")
    WHERE "checkInId" IS NOT NULL;

-- 6) New time-index for the F03 path queries.
CREATE INDEX IF NOT EXISTS "TongueObservation_patientId_observedAt_idx"
    ON "TongueObservation" ("patientId", "observedAt");

-- 7) FK to DailyCheckIn (ON DELETE SET NULL so deleting a check-in
--    doesn't cascade-destroy its observation).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'TongueObservation_checkInId_fkey'
    ) THEN
        ALTER TABLE "TongueObservation"
            ADD CONSTRAINT "TongueObservation_checkInId_fkey"
            FOREIGN KEY ("checkInId") REFERENCES "DailyCheckIn"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
