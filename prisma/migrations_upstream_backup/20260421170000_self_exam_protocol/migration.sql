-- Self-Examination Protocol (IWIS Ayurvedic pre-consultation workflow).
-- Typed tables for longitudinal tracking; no free-text where an enum will do.
-- Stool (Mala) is captured as structured texture/colour/habit fields ONLY —
-- no photo column, no image upload route. Clinical direction: the texture
-- data is what the Vaidya uses.

-- ─── Enums ─────────────────────────────────────────────────────────────

CREATE TYPE "SelfExamStatus" AS ENUM (
    'DRAFT',
    'SUBMITTED',
    'REVIEWED'
);

CREATE TYPE "PainZone" AS ENUM (
    'HEAD_MIGRAINE',
    'NECK',
    'SHOULDER',
    'CHEST',
    'LOWER_BACK',
    'ABDOMEN',
    'KNEE',
    'WRIST_HAND',
    'GENERALISED_MUSCLE'
);

CREATE TYPE "PainCharacter" AS ENUM (
    'THROBBING',
    'PRESSING',
    'STABBING',
    'DULL',
    'BURNING',
    'SHARP',
    'ACHING',
    'CRAMPING',
    'GRINDING',
    'HEAVY',
    'TIGHT',
    'COLICKY',
    'BLOATING'
);

CREATE TYPE "TongueCoatingColor" AS ENUM (
    'NONE',
    'WHITE',
    'YELLOW',
    'RED'
);

CREATE TYPE "TongueCoatingThickness" AS ENUM (
    'NONE',
    'THIN',
    'THICK'
);

CREATE TYPE "StoolConsistency" AS ENUM (
    'HARD_PELLETS',
    'FORMED',
    'SOFT',
    'LOOSE',
    'WATERY',
    'MUCOUSY'
);

CREATE TYPE "StoolColour" AS ENUM (
    'BROWN',
    'PALE',
    'YELLOW_GREEN',
    'DARK'
);

CREATE TYPE "StoolMealRelation" AS ENUM (
    'BEFORE_MEALS',
    'AFTER_MEALS',
    'BOTH',
    'NONE'
);

CREATE TYPE "UrineColour" AS ENUM (
    'PALE',
    'NORMAL_YELLOW',
    'DARK_YELLOW',
    'BROWN'
);

CREATE TYPE "RoMJoint" AS ENUM (
    'NECK',
    'SHOULDER_LEFT',
    'SHOULDER_RIGHT',
    'KNEE_LEFT',
    'KNEE_RIGHT'
);

CREATE TYPE "RoMDirection" AS ENUM (
    'NECK_ROTATE_LEFT',
    'NECK_ROTATE_RIGHT',
    'NECK_FLEX',
    'NECK_EXTEND',
    'NECK_LATERAL_LEFT',
    'NECK_LATERAL_RIGHT',
    'SHOULDER_FLEX_OVERHEAD',
    'SHOULDER_ABDUCT',
    'SHOULDER_CROSS_BODY',
    'SHOULDER_BEHIND_BACK',
    'SHOULDER_EXTERNAL_ROT',
    'SHOULDER_INTERNAL_ROT',
    'KNEE_FLEX',
    'KNEE_EXTEND'
);

CREATE TYPE "PhysicalObservationType" AS ENUM (
    'POSTURE_FULL_BODY',
    'FACE_EYE',
    'HAND_FLAT',
    'KNEE_COMPARE',
    'SHOULDER_SYMMETRY',
    'GENERAL_APPEARANCE'
);

CREATE TYPE "PrakritiType" AS ENUM (
    'VATA',
    'PITTA',
    'KAPHA',
    'VATA_PITTA',
    'PITTA_KAPHA',
    'VATA_KAPHA',
    'TRIDOSHA'
);

CREATE TYPE "AgniType" AS ENUM (
    'MANDAGNI',
    'TIKSHNA',
    'VISHAMA',
    'SAMA'
);

CREATE TYPE "AppetiteLevel" AS ENUM (
    'STRONG',
    'MODERATE',
    'WEAK',
    'IRREGULAR'
);

CREATE TYPE "SleepPosition" AS ENUM (
    'BACK',
    'LEFT_SIDE',
    'RIGHT_SIDE',
    'STOMACH',
    'MIXED'
);


-- ─── Parent submission ─────────────────────────────────────────────────

CREATE TABLE "SelfExamSubmission" (
    "id"                  TEXT PRIMARY KEY,
    "triageSessionId"     TEXT UNIQUE,
    "patientId"           TEXT NOT NULL,
    "appointmentId"       TEXT,
    "branchId"            TEXT,
    "hospitalId"          TEXT,
    "painZones"           "PainZone"[] NOT NULL DEFAULT '{}',
    "status"              "SelfExamStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt"         TIMESTAMP(3),
    "reviewedAt"          TIMESTAMP(3),
    "reviewedByUserId"    TEXT,
    "reviewNotes"         TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfExamSubmission_triageSessionId_fkey"
        FOREIGN KEY ("triageSessionId") REFERENCES "TriageSession"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SelfExamSubmission_patientId_fkey"
        FOREIGN KEY ("patientId") REFERENCES "Patient"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SelfExamSubmission_appointmentId_fkey"
        FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SelfExamSubmission_branchId_fkey"
        FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SelfExamSubmission_hospitalId_fkey"
        FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SelfExamSubmission_reviewedByUserId_fkey"
        FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "SelfExamSubmission_patientId_createdAt_idx"
    ON "SelfExamSubmission"("patientId", "createdAt");
CREATE INDEX "SelfExamSubmission_branchId_status_idx"
    ON "SelfExamSubmission"("branchId", "status");
CREATE INDEX "SelfExamSubmission_hospitalId_status_idx"
    ON "SelfExamSubmission"("hospitalId", "status");
CREATE INDEX "SelfExamSubmission_appointmentId_idx"
    ON "SelfExamSubmission"("appointmentId");
CREATE INDEX "SelfExamSubmission_status_idx"
    ON "SelfExamSubmission"("status");


-- ─── Symptom history (Nidana & Purvarupa), one row per zone ────────────

CREATE TABLE "SymptomHistoryEntry" (
    "id"                         TEXT PRIMARY KEY,
    "submissionId"               TEXT NOT NULL,
    "painZone"                   "PainZone" NOT NULL,
    "subLocation"                TEXT,
    "characters"                 "PainCharacter"[] NOT NULL DEFAULT '{}',
    "triggers"                   TEXT[] NOT NULL DEFAULT '{}',
    "relievingFactors"           TEXT[] NOT NULL DEFAULT '{}',
    "timing"                     TEXT[] NOT NULL DEFAULT '{}',
    "severity"                   INTEGER NOT NULL,
    "radiatesTo"                 TEXT,
    "associatedSymptoms"         TEXT[] NOT NULL DEFAULT '{}',
    "warningSignsBeforeEpisode"  TEXT[] NOT NULL DEFAULT '{}',
    "injuryHistory"              TEXT,
    "occupationContext"          TEXT,
    "freeText"                   TEXT,
    "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SymptomHistoryEntry_severity_check"
        CHECK ("severity" >= 0 AND "severity" <= 10),
    CONSTRAINT "SymptomHistoryEntry_submissionId_fkey"
        FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SymptomHistoryEntry_submissionId_painZone_key"
    ON "SymptomHistoryEntry"("submissionId", "painZone");
CREATE INDEX "SymptomHistoryEntry_painZone_idx"
    ON "SymptomHistoryEntry"("painZone");


-- ─── Tongue observation (Jihva) — 3-day log ────────────────────────────

CREATE TABLE "TongueObservation" (
    "id"                   TEXT PRIMARY KEY,
    "submissionId"         TEXT NOT NULL,
    "patientId"            TEXT NOT NULL,
    "dayIndex"             INTEGER NOT NULL,
    "observedOn"           TIMESTAMP(3) NOT NULL,
    "photoUrl"             TEXT,
    "coatingColor"         "TongueCoatingColor" NOT NULL,
    "coatingThickness"     "TongueCoatingThickness" NOT NULL,
    "dryness"              BOOLEAN NOT NULL DEFAULT false,
    "cracks"               BOOLEAN NOT NULL DEFAULT false,
    "tremor"               BOOLEAN NOT NULL DEFAULT false,
    "correlatedPainLevel"  INTEGER,
    "notes"                TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TongueObservation_dayIndex_check"
        CHECK ("dayIndex" >= 1 AND "dayIndex" <= 7),
    CONSTRAINT "TongueObservation_correlatedPainLevel_check"
        CHECK ("correlatedPainLevel" IS NULL OR ("correlatedPainLevel" >= 0 AND "correlatedPainLevel" <= 10)),
    CONSTRAINT "TongueObservation_submissionId_fkey"
        FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TongueObservation_patientId_fkey"
        FOREIGN KEY ("patientId") REFERENCES "Patient"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TongueObservation_submissionId_dayIndex_key"
    ON "TongueObservation"("submissionId", "dayIndex");
CREATE INDEX "TongueObservation_patientId_observedOn_idx"
    ON "TongueObservation"("patientId", "observedOn");


-- ─── Stool log (Mala) — 3-day, NO PHOTOS; texture + habit only ─────────

CREATE TABLE "StoolLog" (
    "id"                      TEXT PRIMARY KEY,
    "submissionId"            TEXT NOT NULL,
    "patientId"               TEXT NOT NULL,
    "dayIndex"                INTEGER NOT NULL,
    "observedOn"              TIMESTAMP(3) NOT NULL,
    "consistency"             "StoolConsistency" NOT NULL,
    "colour"                  "StoolColour" NOT NULL,
    "frequencyPerDay"         INTEGER NOT NULL,
    "daysSinceLastMovement"   INTEGER,
    "strainingEffort"         INTEGER NOT NULL,
    "incompleteEvacuation"    BOOLEAN NOT NULL DEFAULT false,
    "bloatingGas"             BOOLEAN NOT NULL DEFAULT false,
    "bloodPresent"            BOOLEAN NOT NULL DEFAULT false,
    "mucusPresent"            BOOLEAN NOT NULL DEFAULT false,
    "undigestedFood"          BOOLEAN NOT NULL DEFAULT false,
    "relationshipToMeal"      "StoolMealRelation" NOT NULL DEFAULT 'NONE',
    "notes"                   TEXT,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoolLog_dayIndex_check"
        CHECK ("dayIndex" >= 1 AND "dayIndex" <= 7),
    CONSTRAINT "StoolLog_strainingEffort_check"
        CHECK ("strainingEffort" >= 1 AND "strainingEffort" <= 5),
    CONSTRAINT "StoolLog_frequencyPerDay_check"
        CHECK ("frequencyPerDay" >= 0 AND "frequencyPerDay" <= 20),
    CONSTRAINT "StoolLog_submissionId_fkey"
        FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StoolLog_patientId_fkey"
        FOREIGN KEY ("patientId") REFERENCES "Patient"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StoolLog_submissionId_dayIndex_key"
    ON "StoolLog"("submissionId", "dayIndex");
CREATE INDEX "StoolLog_patientId_observedOn_idx"
    ON "StoolLog"("patientId", "observedOn");


-- ─── Urine log (Mutra) — 3-day ─────────────────────────────────────────

CREATE TABLE "UrineLog" (
    "id"              TEXT PRIMARY KEY,
    "submissionId"    TEXT NOT NULL,
    "patientId"       TEXT NOT NULL,
    "dayIndex"        INTEGER NOT NULL,
    "observedOn"      TIMESTAMP(3) NOT NULL,
    "colour"          "UrineColour" NOT NULL,
    "frequencyPerDay" INTEGER NOT NULL,
    "burning"         BOOLEAN NOT NULL DEFAULT false,
    "urgency"         BOOLEAN NOT NULL DEFAULT false,
    "painCorrelation" BOOLEAN NOT NULL DEFAULT false,
    "notes"           TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UrineLog_dayIndex_check"
        CHECK ("dayIndex" >= 1 AND "dayIndex" <= 7),
    CONSTRAINT "UrineLog_frequencyPerDay_check"
        CHECK ("frequencyPerDay" >= 0 AND "frequencyPerDay" <= 30),
    CONSTRAINT "UrineLog_submissionId_fkey"
        FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UrineLog_patientId_fkey"
        FOREIGN KEY ("patientId") REFERENCES "Patient"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UrineLog_submissionId_dayIndex_key"
    ON "UrineLog"("submissionId", "dayIndex");
CREATE INDEX "UrineLog_patientId_observedOn_idx"
    ON "UrineLog"("patientId", "observedOn");


-- ─── Range of motion (neck / shoulder / knee) ──────────────────────────

CREATE TABLE "RoMMeasurement" (
    "id"           TEXT PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "joint"        "RoMJoint" NOT NULL,
    "direction"    "RoMDirection" NOT NULL,
    "angleDegrees" DOUBLE PRECISION,
    "restriction"  TEXT,
    "painScore"    INTEGER NOT NULL,
    "crepitus"     BOOLEAN NOT NULL DEFAULT false,
    "catchOrSharp" BOOLEAN NOT NULL DEFAULT false,
    "notes"        TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoMMeasurement_painScore_check"
        CHECK ("painScore" >= 0 AND "painScore" <= 10),
    CONSTRAINT "RoMMeasurement_submissionId_fkey"
        FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RoMMeasurement_submissionId_joint_direction_key"
    ON "RoMMeasurement"("submissionId", "joint", "direction");


-- ─── Physical observation (posture / face / hand / knee compare etc.) ──

CREATE TABLE "PhysicalObservation" (
    "id"              TEXT PRIMARY KEY,
    "submissionId"    TEXT NOT NULL,
    "observationType" "PhysicalObservationType" NOT NULL,
    "painZone"        "PainZone",
    "photoFrontUrl"   TEXT,
    "photoSideUrl"    TEXT,
    "photoBackUrl"    TEXT,
    "photoExtraUrl"   TEXT,
    "details"         JSONB NOT NULL DEFAULT '{}',
    "notes"           TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhysicalObservation_submissionId_fkey"
        FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PhysicalObservation_submissionId_type_key"
    ON "PhysicalObservation"("submissionId", "observationType");


-- ─── Voice observation (Sabda) — muscle pain / fibromyalgia pattern ────

CREATE TABLE "VoiceObservation" (
    "id"              TEXT PRIMARY KEY,
    "submissionId"    TEXT NOT NULL,
    "dayIndex"        INTEGER NOT NULL DEFAULT 1,
    "morningRecUrl"   TEXT,
    "eveningRecUrl"   TEXT,
    "fatigueNotes"    TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceObservation_dayIndex_check"
        CHECK ("dayIndex" >= 1 AND "dayIndex" <= 7),
    CONSTRAINT "VoiceObservation_submissionId_fkey"
        FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "VoiceObservation_submissionId_dayIndex_key"
    ON "VoiceObservation"("submissionId", "dayIndex");


-- ─── Digestive profile (Ahara Shakti) — at most one per submission ─────

CREATE TABLE "DigestiveProfile" (
    "id"                       TEXT PRIMARY KEY,
    "submissionId"             TEXT NOT NULL UNIQUE,
    "agniType"                 "AgniType",
    "appetiteLevel"            "AppetiteLevel",
    "bloatingAfterMeals"       BOOLEAN NOT NULL DEFAULT false,
    "bloatingDurationMins"     INTEGER,
    "heartburnPerWeek"         INTEGER,
    "waterIntakeGlasses"       INTEGER,
    "coldFoodAggravates"       BOOLEAN NOT NULL DEFAULT false,
    "foodTriggers"             TEXT[] NOT NULL DEFAULT '{}',
    "incompatibleCombinations" TEXT[] NOT NULL DEFAULT '{}',
    "notes"                    TEXT,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigestiveProfile_submissionId_fkey"
        FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);


-- ─── Lifestyle context (Satmya) — pillow / screen / injury / sleep ─────

CREATE TABLE "LifestyleContext" (
    "id"                   TEXT PRIMARY KEY,
    "submissionId"         TEXT NOT NULL UNIQUE,
    "pillowType"           TEXT,
    "pillowFirmness"       TEXT,
    "sleepPosition"        "SleepPosition",
    "sleepHours"           DOUBLE PRECISION,
    "screenHoursPerDay"    INTEGER,
    "occupation"           TEXT,
    "pastInjuries"         TEXT,
    "regularExercise"      TEXT,
    "stressEventsPast6mo"  TEXT,
    "notes"                TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifestyleContext_submissionId_fkey"
        FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);


-- ─── Constitution profile (Prakriti + Satva + Agni) — one per patient ──

CREATE TABLE "ConstitutionProfile" (
    "id"             TEXT PRIMARY KEY,
    "patientId"      TEXT NOT NULL UNIQUE,
    "prakriti"       "PrakritiType",
    "satvaRating"    INTEGER,
    "agniType"       "AgniType",
    "quizAnswers"    JSONB,
    "lastUpdatedBy"  TEXT,
    "completedAt"    TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConstitutionProfile_satvaRating_check"
        CHECK ("satvaRating" IS NULL OR ("satvaRating" >= 1 AND "satvaRating" <= 10)),
    CONSTRAINT "ConstitutionProfile_patientId_fkey"
        FOREIGN KEY ("patientId") REFERENCES "Patient"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);


-- ─── FeatureRegistry row so the feature is plan-gate-able per hospital ─
-- Adding as STARTER/isCore so it's on by default for all tenants without
-- an extra config step.

INSERT INTO "FeatureRegistry"
    ("id", "key", "displayName", "description", "phase", "minPlan", "isCore", "defaultEnabled", "addedInVersion", "updatedAt")
VALUES
    (
      gen_random_uuid()::text,
      'SELF_EXAM_PROTOCOL',
      'Ayurvedic Self-Examination Protocol',
      'Pre-consultation self-assessment captured by the patient before the Vaidya appointment: tongue photo log, stool texture log (structured, no images), urine log, range-of-motion, posture / hand / face photos, Prakriti/Satva/Agni quiz. Auto-initialised from each triage.',
      'TRIAGE_V2', 'STARTER', true, true, '2026-04-21', CURRENT_TIMESTAMP
    )
ON CONFLICT ("key") DO UPDATE SET
    "displayName"    = EXCLUDED."displayName",
    "description"    = EXCLUDED."description",
    "phase"          = EXCLUDED."phase",
    "minPlan"        = EXCLUDED."minPlan",
    "isCore"         = EXCLUDED."isCore",
    "defaultEnabled" = EXCLUDED."defaultEnabled",
    "addedInVersion" = EXCLUDED."addedInVersion",
    "updatedAt"      = CURRENT_TIMESTAMP;

-- Backfill hospital-level flags for all active tenants so the kit surfaces
-- immediately without waiting for the nightly registry sync job.
INSERT INTO "HospitalFeatureFlag" ("id", "hospitalId", "featureKey", "enabled", "enabledAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    h."id",
    'SELF_EXAM_PROTOCOL',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Hospital" h
WHERE h."status" <> 'DECOMMISSIONED'
ON CONFLICT ("hospitalId", "featureKey") DO NOTHING;
