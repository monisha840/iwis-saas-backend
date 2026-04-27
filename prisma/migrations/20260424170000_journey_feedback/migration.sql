-- Treatment-journey completion feedback flow.
--
-- When a TreatmentJourney is marked COMPLETED, the patient is shown a
-- 7-stage full-screen feedback experience the next time they open the
-- app. Their responses generate up to 7 XP credited to the lead doctor
-- (and proportionally split with co-treaters when applicable).
--
-- Two new tables:
--   - JourneyFeedback     : 1:1 with TreatmentJourney
--   - ThankYouCard        : optional patient-authored note to the doctor
--
-- One column added to Appointment for co-treater attribution math.
-- One FeatureRegistry row + per-tenant flag backfill.

-- ── journeyId on Appointment for co-treater attribution ───────────────
-- Nullable + no backfill. Going forward, the booking flow may attach an
-- appointment to a journey so the feedback service can count "appointments
-- on this journey" per clinician for the 70/30 XP split. Existing rows
-- stay null (treated as "not journey-linked").
ALTER TABLE "Appointment" ADD COLUMN "journeyId" TEXT;
ALTER TABLE "Appointment"
    ADD CONSTRAINT "Appointment_journeyId_fkey"
    FOREIGN KEY ("journeyId") REFERENCES "TreatmentJourney"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Appointment_journeyId_idx" ON "Appointment"("journeyId");

-- ── Enums ──────────────────────────────────────────────────────────────
-- MCQ options reuse the existing FeedbackMcqOption (A/B/C/D) shape from
-- ConsultationFeedback so the frontend control + answer-mapping helpers
-- are shared. Visibility on the thank-you card is its own enum because
-- public/private behaves differently on the doctor recognition panel.
CREATE TYPE "ThankYouCardVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- ── JourneyFeedback ────────────────────────────────────────────────────
-- 1:1 with TreatmentJourney via UNIQUE(journeyId). Single submission only:
-- once `completedAt` is set, the row is final and the flow cannot be
-- re-opened. `xpAwarded` and `xpDistribution` are immutable snapshots —
-- if the XP rules later change, do not retroactively edit these.
CREATE TABLE "JourneyFeedback" (
    "id"                          TEXT          NOT NULL,
    "journeyId"                   TEXT          NOT NULL,
    "patientId"                   TEXT          NOT NULL,
    "leadDoctorId"                TEXT          NOT NULL,
    "branchId"                    TEXT,

    -- 4 operational MCQs (each individually skippable)
    "mcqAppointments"             "FeedbackMcqOption",
    "mcqReminders"                "FeedbackMcqOption",
    "mcqMedications"              "FeedbackMcqOption",
    "mcqFamilyRecommendation"     "FeedbackMcqOption",

    -- Garden / growth metaphor (5 levels mapped to score 1/3/5/7/10)
    "gardenScore"                 INTEGER,

    -- Face-of-care experience (1-5)
    "faceScaleExperience"         INTEGER,

    -- Thank-you card (optional, free-form, capped 2000 chars)
    "thankYouCardText"            TEXT,
    "thankYouCardPublic"          BOOLEAN       NOT NULL DEFAULT false,

    "photosViewed"                BOOLEAN       NOT NULL DEFAULT false,
    "xpAwarded"                   INTEGER       NOT NULL DEFAULT 0,
    "xpDistribution"              JSONB         NOT NULL DEFAULT '{}'::jsonb,

    -- 30-day window for re-entry; silently closes after that.
    "expiresAt"                   TIMESTAMP(3)  NOT NULL,

    -- 72h reminder push tracker (idempotency stamp).
    "reminderSentAt"              TIMESTAMP(3),

    "createdAt"                   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"                 TIMESTAMP(3),

    CONSTRAINT "JourneyFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JourneyFeedback_journeyId_key" ON "JourneyFeedback"("journeyId");
CREATE INDEX "JourneyFeedback_leadDoctorId_idx"   ON "JourneyFeedback"("leadDoctorId");
CREATE INDEX "JourneyFeedback_patientId_idx"      ON "JourneyFeedback"("patientId");
CREATE INDEX "JourneyFeedback_branchId_idx"       ON "JourneyFeedback"("branchId");
CREATE INDEX "JourneyFeedback_completedAt_idx"    ON "JourneyFeedback"("completedAt");
-- Used by the 72h-reminder sweep: pending rows (completedAt NULL) past
-- the reminder threshold, deduped by reminderSentAt NULL.
CREATE INDEX "JourneyFeedback_completedAt_reminderSentAt_idx"
    ON "JourneyFeedback"("completedAt", "reminderSentAt");

ALTER TABLE "JourneyFeedback"
    ADD CONSTRAINT "JourneyFeedback_journeyId_fkey"
    FOREIGN KEY ("journeyId") REFERENCES "TreatmentJourney"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JourneyFeedback"
    ADD CONSTRAINT "JourneyFeedback_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JourneyFeedback"
    ADD CONSTRAINT "JourneyFeedback_leadDoctorId_fkey"
    FOREIGN KEY ("leadDoctorId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JourneyFeedback"
    ADD CONSTRAINT "JourneyFeedback_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── ThankYouCard (privacy-isolated) ───────────────────────────────────
-- Separate from JourneyFeedback so the recognition panel can join only on
-- the visibility-allowed cards without leaking the rest of the feedback
-- payload. recipientDoctorId is denormalised so the panel query stays a
-- single index hit.
CREATE TABLE "ThankYouCard" (
    "id"                  TEXT                       NOT NULL,
    "feedbackId"          TEXT                       NOT NULL,
    "recipientDoctorId"   TEXT                       NOT NULL,
    "content"             TEXT                       NOT NULL,
    "visibility"          "ThankYouCardVisibility"   NOT NULL DEFAULT 'PRIVATE',
    "createdAt"           TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThankYouCard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ThankYouCard_feedbackId_key"      ON "ThankYouCard"("feedbackId");
CREATE INDEX        "ThankYouCard_recipientDoctorId_visibility_createdAt_idx"
    ON "ThankYouCard"("recipientDoctorId", "visibility", "createdAt");

ALTER TABLE "ThankYouCard"
    ADD CONSTRAINT "ThankYouCard_feedbackId_fkey"
    FOREIGN KEY ("feedbackId") REFERENCES "JourneyFeedback"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ThankYouCard"
    ADD CONSTRAINT "ThankYouCard_recipientDoctorId_fkey"
    FOREIGN KEY ("recipientDoctorId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── FeatureRegistry ────────────────────────────────────────────────────
-- Core, defaultEnabled — every tenant gets it on. Phase CLINICAL_WORKFLOW
-- groups it with follow-ups + critical-journey.
INSERT INTO "FeatureRegistry" (
    "id", "key", "displayName", "description", "phase", "minPlan",
    "isCore", "defaultEnabled", "createdAt", "updatedAt"
) VALUES
(
    gen_random_uuid()::text,
    'JOURNEY_FEEDBACK',
    'Treatment journey completion feedback',
    'Full-screen 7-stage feedback experience triggered when a TreatmentJourney is marked COMPLETED. Captures 4 operational MCQs, garden growth metaphor, face-scale, and an optional thank-you card. Awards up to 7 XP to the lead doctor (with proportional split to co-treaters when present).',
    'CLINICAL_WORKFLOW',
    'STARTER',
    TRUE,
    TRUE,
    NOW(),
    NOW()
)
ON CONFLICT ("key") DO UPDATE SET
    "displayName"    = EXCLUDED."displayName",
    "description"    = EXCLUDED."description",
    "phase"          = EXCLUDED."phase",
    "minPlan"        = EXCLUDED."minPlan",
    "isCore"         = EXCLUDED."isCore",
    "defaultEnabled" = EXCLUDED."defaultEnabled",
    "updatedAt"      = NOW();

-- Backfill HospitalFeatureFlag rows for every non-decommissioned tenant
-- so the UI surfaces it immediately (no wait for nightly sync).
INSERT INTO "HospitalFeatureFlag" (
    "id", "hospitalId", "featureKey", "enabled", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    h."id",
    'JOURNEY_FEEDBACK',
    TRUE,
    NOW(),
    NOW()
FROM "Hospital" h
WHERE h."status" <> 'DECOMMISSIONED'
ON CONFLICT ("hospitalId", "featureKey") DO NOTHING;
