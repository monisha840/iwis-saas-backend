-- IWIS Competitor Feature Additions v1.1
-- See IWIS_Competitor_Feature_Additions.md

-- ── Feature 0: Branch Capacity ─────────────────────────────────────────────
ALTER TABLE "Branch"
  ADD COLUMN IF NOT EXISTS "totalBeds" INTEGER,
  ADD COLUMN IF NOT EXISTS "availableBeds" INTEGER,
  ADD COLUMN IF NOT EXISTS "totalRooms" INTEGER,
  ADD COLUMN IF NOT EXISTS "totalTherapyRooms" INTEGER,
  ADD COLUMN IF NOT EXISTS "ipdEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "opdEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "operatingHoursFrom" TEXT,
  ADD COLUMN IF NOT EXISTS "operatingHoursTo" TEXT;

-- ── Feature 7: WhatsApp preferences ────────────────────────────────────────
ALTER TABLE "NotificationPreference"
  ADD COLUMN IF NOT EXISTS "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "whatsappNumber" TEXT;

-- ── Feature 6 / 1: Appointment extensions ──────────────────────────────────
ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "therapyRoomId" TEXT,
  ADD COLUMN IF NOT EXISTS "groupSessionId" TEXT,
  ADD COLUMN IF NOT EXISTS "isGroupBooking" BOOLEAN NOT NULL DEFAULT false;

-- ── Enums ──────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "TherapyRoomType" AS ENUM ('SHIRODHARA','ABHYANGA','PANCHAKARMA_GENERAL','STEAM','CONSULTATION','GROUP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DoshaType" AS ENUM ('VATA','PITTA','KAPHA','TRIDOSHA'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DietCategory" AS ENUM ('SATTVIC','RAJASIC','TAMASIC'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "MealTime" AS ENUM ('MORNING_EMPTY','BREAKFAST','MID_MORNING','LUNCH','EVENING','DINNER','BEDTIME'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PhotoCategory" AS ENUM ('SKIN_CONDITION','SWELLING_OEDEMA','WOUND_HEALING','WEIGHT_CHANGE','GENERAL_PROGRESS'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PhotoStage" AS ENUM ('BEFORE','DURING','AFTER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AyurvedicSkill" AS ENUM ('ABHYANGA','SHIRODHARA','PANCHAKARMA_GENERAL','BASTI','VIRECHANA','NASYA','KIZHI','NJAVARA','PIZHICHIL','MARMA_THERAPY','YOGA_THERAPY','NATUROPATHY'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "Proficiency" AS ENUM ('CERTIFIED','EXPERIENCED','LEARNING'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "EnrolmentStatus" AS ENUM ('ACTIVE','COMPLETED','CANCELLED','PAUSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "GroupSessionStatus" AS ENUM ('OPEN','FULL','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── TherapyRoom ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TherapyRoom" (
  "id"        TEXT PRIMARY KEY,
  "branchId"  TEXT NOT NULL REFERENCES "Branch"("id"),
  "name"      TEXT NOT NULL,
  "type"      "TherapyRoomType" NOT NULL,
  "capacity"  INTEGER NOT NULL DEFAULT 1,
  "isActive"  BOOLEAN NOT NULL DEFAULT true,
  "notes"     TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "TherapyRoom_branchId_idx" ON "TherapyRoom"("branchId");
CREATE INDEX IF NOT EXISTS "TherapyRoom_type_idx"     ON "TherapyRoom"("type");

CREATE TABLE IF NOT EXISTS "TherapyRoomBooking" (
  "id"            TEXT PRIMARY KEY,
  "roomId"        TEXT NOT NULL REFERENCES "TherapyRoom"("id") ON DELETE CASCADE,
  "appointmentId" TEXT NOT NULL UNIQUE REFERENCES "Appointment"("id") ON DELETE CASCADE,
  "date"          TIMESTAMP(3) NOT NULL,
  "startTime"     TEXT NOT NULL,
  "endTime"       TEXT NOT NULL,
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "TherapyRoomBooking_roomId_date_idx" ON "TherapyRoomBooking"("roomId","date");
CREATE INDEX IF NOT EXISTS "TherapyRoomBooking_date_idx"        ON "TherapyRoomBooking"("date");

-- ── DietPrescription ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DietPrescription" (
  "id"          TEXT PRIMARY KEY,
  "patientId"   TEXT NOT NULL REFERENCES "Patient"("id") ON DELETE CASCADE,
  "doctorId"    TEXT NOT NULL REFERENCES "Doctor"("id"),
  "journeyId"   TEXT,
  "title"       TEXT NOT NULL,
  "doshaTarget" "DoshaType"   NOT NULL,
  "category"    "DietCategory" NOT NULL,
  "startDate"   TIMESTAMP(3) NOT NULL,
  "endDate"     TIMESTAMP(3),
  "notes"       TEXT,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "DietPrescription_patientId_idx" ON "DietPrescription"("patientId");
CREATE INDEX IF NOT EXISTS "DietPrescription_doctorId_idx"  ON "DietPrescription"("doctorId");
CREATE INDEX IF NOT EXISTS "DietPrescription_isActive_idx"  ON "DietPrescription"("isActive");

CREATE TABLE IF NOT EXISTS "DietMeal" (
  "id"                 TEXT PRIMARY KEY,
  "dietPrescriptionId" TEXT NOT NULL REFERENCES "DietPrescription"("id") ON DELETE CASCADE,
  "mealTime"           "MealTime" NOT NULL,
  "foods"              JSONB NOT NULL,
  "avoidFoods"         JSONB NOT NULL,
  "instructions"       TEXT
);
CREATE INDEX IF NOT EXISTS "DietMeal_dietPrescriptionId_idx" ON "DietMeal"("dietPrescriptionId");

CREATE TABLE IF NOT EXISTS "DietAdherenceLog" (
  "id"                 TEXT PRIMARY KEY,
  "dietPrescriptionId" TEXT NOT NULL REFERENCES "DietPrescription"("id") ON DELETE CASCADE,
  "patientId"          TEXT NOT NULL REFERENCES "Patient"("id") ON DELETE CASCADE,
  "date"               TIMESTAMP(3) NOT NULL,
  "mealTime"           "MealTime" NOT NULL,
  "followed"           BOOLEAN NOT NULL,
  "notes"              TEXT,
  "loggedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "DietAdherenceLog_dpId_date_idx" ON "DietAdherenceLog"("dietPrescriptionId","date");
CREATE INDEX IF NOT EXISTS "DietAdherenceLog_patient_date_idx" ON "DietAdherenceLog"("patientId","date");

-- ── ClinicalPhoto ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ClinicalPhoto" (
  "id"          TEXT PRIMARY KEY,
  "patientId"   TEXT NOT NULL REFERENCES "Patient"("id") ON DELETE CASCADE,
  "uploadedById" TEXT NOT NULL,
  "journeyId"   TEXT REFERENCES "TreatmentJourney"("id"),
  "phaseId"     TEXT REFERENCES "JourneyPhase"("id"),
  "category"    "PhotoCategory" NOT NULL,
  "stage"       "PhotoStage" NOT NULL,
  "bodyRegion"  TEXT,
  "notes"       TEXT,
  "filePath"    TEXT NOT NULL,
  "takenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ClinicalPhoto_patientId_idx" ON "ClinicalPhoto"("patientId");
CREATE INDEX IF NOT EXISTS "ClinicalPhoto_journeyId_idx" ON "ClinicalPhoto"("journeyId");
CREATE INDEX IF NOT EXISTS "ClinicalPhoto_category_idx"  ON "ClinicalPhoto"("category");

-- ── TherapistSkill ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TherapistSkill" (
  "id"          TEXT PRIMARY KEY,
  "therapistId" TEXT NOT NULL REFERENCES "Therapist"("id") ON DELETE CASCADE,
  "skill"       "AyurvedicSkill" NOT NULL,
  "proficiency" "Proficiency" NOT NULL,
  "certifiedAt" TIMESTAMP(3),
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "TherapistSkill_therapistId_skill_key" ON "TherapistSkill"("therapistId","skill");
CREATE INDEX IF NOT EXISTS "TherapistSkill_skill_idx" ON "TherapistSkill"("skill");

-- ── TreatmentPackage ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TreatmentPackage" (
  "id"           TEXT PRIMARY KEY,
  "branchId"     TEXT NOT NULL REFERENCES "Branch"("id"),
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "durationDays" INTEGER NOT NULL,
  "price"        DOUBLE PRECISION NOT NULL,
  "taxPercent"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "components"   JSONB NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "TreatmentPackage_branchId_idx" ON "TreatmentPackage"("branchId");
CREATE INDEX IF NOT EXISTS "TreatmentPackage_isActive_idx" ON "TreatmentPackage"("isActive");

CREATE TABLE IF NOT EXISTS "PackageEnrolment" (
  "id"            TEXT PRIMARY KEY,
  "packageId"     TEXT NOT NULL REFERENCES "TreatmentPackage"("id"),
  "patientId"     TEXT NOT NULL REFERENCES "Patient"("id"),
  "invoiceId"     TEXT UNIQUE REFERENCES "Invoice"("id"),
  "startDate"     TIMESTAMP(3) NOT NULL,
  "endDate"       TIMESTAMP(3) NOT NULL,
  "status"        "EnrolmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "sessionsTotal" INTEGER NOT NULL,
  "sessionsUsed"  INTEGER NOT NULL DEFAULT 0,
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PackageEnrolment_patientId_idx" ON "PackageEnrolment"("patientId");
CREATE INDEX IF NOT EXISTS "PackageEnrolment_packageId_idx" ON "PackageEnrolment"("packageId");
CREATE INDEX IF NOT EXISTS "PackageEnrolment_status_idx"    ON "PackageEnrolment"("status");

CREATE TABLE IF NOT EXISTS "PackageSessionLog" (
  "id"            TEXT PRIMARY KEY,
  "enrolmentId"   TEXT NOT NULL REFERENCES "PackageEnrolment"("id") ON DELETE CASCADE,
  "appointmentId" TEXT REFERENCES "Appointment"("id"),
  "sessionType"   TEXT NOT NULL,
  "conductedAt"   TIMESTAMP(3) NOT NULL,
  "conductedById" TEXT NOT NULL REFERENCES "Therapist"("id"),
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PackageSessionLog_enrolmentId_idx"   ON "PackageSessionLog"("enrolmentId");
CREATE INDEX IF NOT EXISTS "PackageSessionLog_conductedById_idx" ON "PackageSessionLog"("conductedById");

-- ── GroupSession ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "GroupSession" (
  "id"          TEXT PRIMARY KEY,
  "branchId"    TEXT NOT NULL REFERENCES "Branch"("id"),
  "therapistId" TEXT NOT NULL REFERENCES "Therapist"("id"),
  "roomId"      TEXT REFERENCES "TherapyRoom"("id"),
  "title"       TEXT NOT NULL,
  "sessionType" TEXT NOT NULL,
  "date"        TIMESTAMP(3) NOT NULL,
  "startTime"   TEXT NOT NULL,
  "endTime"     TEXT NOT NULL,
  "maxCapacity" INTEGER NOT NULL,
  "status"      "GroupSessionStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "GroupSession_branchId_date_idx"    ON "GroupSession"("branchId","date");
CREATE INDEX IF NOT EXISTS "GroupSession_therapistId_date_idx" ON "GroupSession"("therapistId","date");
CREATE INDEX IF NOT EXISTS "GroupSession_status_idx"           ON "GroupSession"("status");

-- Back-reference FK on Appointment for groupSessionId
DO $$ BEGIN
  ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_groupSessionId_fkey"
    FOREIGN KEY ("groupSessionId") REFERENCES "GroupSession"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
