-- Journey + Feedback System
-- 1. New FeedbackSentiment enum
-- 2. ConsultationFeedback: rating-based flow fields, role-agnostic clinician,
--    nullable doctor for THERAPIST submissions, acknowledgement fields.
-- 3. JourneyFeedback: rating-based flow fields, role-agnostic primary clinician,
--    acknowledgement fields.
-- 4. JourneyPhase.durationDays default 7.
-- 5. Prescription.journeyId — link to atomically-created TreatmentJourney.

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "FeedbackSentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ConsultationFeedback: relax doctorId, add new flow columns
ALTER TABLE "ConsultationFeedback"
    ALTER COLUMN "doctorId" DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS "clinicianId"      TEXT,
    ADD COLUMN IF NOT EXISTS "clinicianRole"    "Role",
    ADD COLUMN IF NOT EXISTS "rating"           INTEGER,
    ADD COLUMN IF NOT EXISTS "sentiment"        "FeedbackSentiment",
    ADD COLUMN IF NOT EXISTS "categories"       TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "feedbackText"     TEXT,
    ADD COLUMN IF NOT EXISTS "xpRewardClaimed"  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "acknowledgedById" TEXT,
    ADD COLUMN IF NOT EXISTS "acknowledgedAt"   TIMESTAMP(3);

-- Drop and re-add doctorId FK with ON DELETE SET NULL (since the column is now nullable).
-- Use IF EXISTS to tolerate any pre-existing drift in the FK constraint name.
ALTER TABLE "ConsultationFeedback" DROP CONSTRAINT IF EXISTS "ConsultationFeedback_doctorId_fkey";
ALTER TABLE "ConsultationFeedback"
    ADD CONSTRAINT "ConsultationFeedback_doctorId_fkey"
    FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ConsultationFeedback_clinicianId_idx" ON "ConsultationFeedback"("clinicianId");

-- JourneyFeedback: add new flow columns + primary clinician
ALTER TABLE "JourneyFeedback"
    ADD COLUMN IF NOT EXISTS "primaryClinicianId" TEXT,
    ADD COLUMN IF NOT EXISTS "overallRating"      INTEGER,
    ADD COLUMN IF NOT EXISTS "outcomeRating"      INTEGER,
    ADD COLUMN IF NOT EXISTS "adherenceRating"    INTEGER,
    ADD COLUMN IF NOT EXISTS "sentiment"          "FeedbackSentiment",
    ADD COLUMN IF NOT EXISTS "highlights"         TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "feedbackText"       TEXT,
    ADD COLUMN IF NOT EXISTS "wouldRecommend"     BOOLEAN,
    ADD COLUMN IF NOT EXISTS "xpRewardClaimed"    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "acknowledgedById"   TEXT,
    ADD COLUMN IF NOT EXISTS "acknowledgedAt"     TIMESTAMP(3);

ALTER TABLE "JourneyFeedback" DROP CONSTRAINT IF EXISTS "JourneyFeedback_primaryClinicianId_fkey";
ALTER TABLE "JourneyFeedback"
    ADD CONSTRAINT "JourneyFeedback_primaryClinicianId_fkey"
    FOREIGN KEY ("primaryClinicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "JourneyFeedback_primaryClinicianId_idx" ON "JourneyFeedback"("primaryClinicianId");

-- JourneyPhase.durationDays gets a default of 7
ALTER TABLE "JourneyPhase" ALTER COLUMN "durationDays" SET DEFAULT 7;

-- Prescription.journeyId — link to atomic journey creation
ALTER TABLE "Prescription"
    ADD COLUMN IF NOT EXISTS "journeyId" TEXT;

ALTER TABLE "Prescription" DROP CONSTRAINT IF EXISTS "Prescription_journeyId_fkey";
ALTER TABLE "Prescription"
    ADD CONSTRAINT "Prescription_journeyId_fkey"
    FOREIGN KEY ("journeyId") REFERENCES "TreatmentJourney"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Prescription_journeyId_idx" ON "Prescription"("journeyId");
