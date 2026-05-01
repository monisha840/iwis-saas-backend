-- Home Therapy feature: location/contact fields on Patient + 4 new tables + 3 new enums.
-- Doctor authors a HomeTherapyRequest during prescription. Admin / branch-admin
-- approves and schedules N HomeTherapySession rows. HOME sessions are GPS-tracked
-- via TherapistLocationPing. Both parties leave HomeTherapyFeedback after each session.

-- ── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE "HomeTherapyStatus" AS ENUM (
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE "SessionModeType" AS ENUM (
  'HOME',
  'HOSPITAL'
);

CREATE TYPE "HomeTherapySessionStatus" AS ENUM (
  'SCHEDULED',
  'THERAPIST_EN_ROUTE',
  'THERAPIST_ARRIVED',
  'IN_SESSION',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW'
);

-- ── Patient: location & contact fields ─────────────────────────────────────
ALTER TABLE "Patient"
  ADD COLUMN "addressLine1"     TEXT,
  ADD COLUMN "addressLine2"     TEXT,
  ADD COLUMN "city"             TEXT,
  ADD COLUMN "state"            TEXT,
  ADD COLUMN "pincode"          TEXT,
  ADD COLUMN "latitude"         DOUBLE PRECISION,
  ADD COLUMN "longitude"        DOUBLE PRECISION,
  ADD COLUMN "primaryPhone"     TEXT,
  ADD COLUMN "alternativePhone" TEXT,
  ADD COLUMN "locationVerified" BOOLEAN NOT NULL DEFAULT false;

-- ── HomeTherapyRequest ────────────────────────────────────────────────────
CREATE TABLE "HomeTherapyRequest" (
  "id"                  TEXT NOT NULL,
  "prescriptionId"      TEXT NOT NULL,
  "patientId"           TEXT NOT NULL,
  "requestingDoctorId"  TEXT NOT NULL,
  "branchId"            TEXT NOT NULL,
  "totalSessions"       INTEGER NOT NULL,
  "sessionMode"         "SessionModeType"[] DEFAULT ARRAY[]::"SessionModeType"[],
  "notes"               TEXT,
  "status"              "HomeTherapyStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "approvedById"        TEXT,
  "approvedByRole"      "Role",
  "approvedAt"          TIMESTAMP(3),
  "rejectedReason"      TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HomeTherapyRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HomeTherapyRequest_patientId_idx"          ON "HomeTherapyRequest" ("patientId");
CREATE INDEX "HomeTherapyRequest_requestingDoctorId_idx" ON "HomeTherapyRequest" ("requestingDoctorId");
CREATE INDEX "HomeTherapyRequest_branchId_status_idx"    ON "HomeTherapyRequest" ("branchId", "status");
CREATE INDEX "HomeTherapyRequest_status_createdAt_idx"   ON "HomeTherapyRequest" ("status", "createdAt");

ALTER TABLE "HomeTherapyRequest"
  ADD CONSTRAINT "HomeTherapyRequest_prescriptionId_fkey"
    FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "HomeTherapyRequest_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "HomeTherapyRequest_requestingDoctorId_fkey"
    FOREIGN KEY ("requestingDoctorId") REFERENCES "Doctor"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "HomeTherapyRequest_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ── HomeTherapySession ────────────────────────────────────────────────────
CREATE TABLE "HomeTherapySession" (
  "id"                   TEXT NOT NULL,
  "requestId"            TEXT NOT NULL,
  "therapistId"          TEXT NOT NULL,
  "patientId"            TEXT NOT NULL,
  "branchId"             TEXT NOT NULL,
  "sessionNumber"        INTEGER NOT NULL,
  "scheduledDate"        TIMESTAMP(3) NOT NULL,
  "scheduledTime"        TEXT NOT NULL,
  "mode"                 "SessionModeType" NOT NULL,
  "status"               "HomeTherapySessionStatus" NOT NULL DEFAULT 'SCHEDULED',
  "therapistDepartedAt"  TIMESTAMP(3),
  "therapistArrivedAt"   TIMESTAMP(3),
  "sessionStartedAt"     TIMESTAMP(3),
  "sessionCompletedAt"   TIMESTAMP(3),
  "therapistFeedbackId"  TEXT,
  "patientFeedbackId"    TEXT,
  "appointmentId"        TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HomeTherapySession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HomeTherapySession_therapistFeedbackId_key" ON "HomeTherapySession" ("therapistFeedbackId");
CREATE UNIQUE INDEX "HomeTherapySession_patientFeedbackId_key"   ON "HomeTherapySession" ("patientFeedbackId");
CREATE UNIQUE INDEX "HomeTherapySession_appointmentId_key"       ON "HomeTherapySession" ("appointmentId");

CREATE INDEX "HomeTherapySession_therapistId_scheduledDate_idx" ON "HomeTherapySession" ("therapistId", "scheduledDate");
CREATE INDEX "HomeTherapySession_patientId_scheduledDate_idx"   ON "HomeTherapySession" ("patientId", "scheduledDate");
CREATE INDEX "HomeTherapySession_branchId_scheduledDate_idx"    ON "HomeTherapySession" ("branchId", "scheduledDate");
CREATE INDEX "HomeTherapySession_status_scheduledDate_idx"      ON "HomeTherapySession" ("status", "scheduledDate");
CREATE INDEX "HomeTherapySession_requestId_sessionNumber_idx"   ON "HomeTherapySession" ("requestId", "sessionNumber");

ALTER TABLE "HomeTherapySession"
  ADD CONSTRAINT "HomeTherapySession_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "HomeTherapyRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "HomeTherapySession_therapistId_fkey"
    FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "HomeTherapySession_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "HomeTherapySession_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── TherapistLocationPing ─────────────────────────────────────────────────
CREATE TABLE "TherapistLocationPing" (
  "id"          TEXT NOT NULL,
  "sessionId"   TEXT NOT NULL,
  "therapistId" TEXT NOT NULL,
  "latitude"    DOUBLE PRECISION NOT NULL,
  "longitude"   DOUBLE PRECISION NOT NULL,
  "accuracy"    DOUBLE PRECISION,
  "timestamp"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TherapistLocationPing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TherapistLocationPing_sessionId_timestamp_idx"   ON "TherapistLocationPing" ("sessionId", "timestamp");
CREATE INDEX "TherapistLocationPing_therapistId_timestamp_idx" ON "TherapistLocationPing" ("therapistId", "timestamp");

ALTER TABLE "TherapistLocationPing"
  ADD CONSTRAINT "TherapistLocationPing_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "HomeTherapySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── HomeTherapyFeedback ───────────────────────────────────────────────────
CREATE TABLE "HomeTherapyFeedback" (
  "id"         TEXT NOT NULL,
  "sessionId"  TEXT NOT NULL,
  "authorRole" "Role" NOT NULL,
  "rating"     INTEGER NOT NULL,
  "sentiment"  "FeedbackSentiment" NOT NULL,
  "notes"      TEXT,
  "tags"       TEXT[] DEFAULT ARRAY[]::TEXT[],
  "xpAwarded"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HomeTherapyFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HomeTherapyFeedback_sessionId_idx"             ON "HomeTherapyFeedback" ("sessionId");
CREATE INDEX "HomeTherapyFeedback_authorRole_createdAt_idx"  ON "HomeTherapyFeedback" ("authorRole", "createdAt");

ALTER TABLE "HomeTherapySession"
  ADD CONSTRAINT "HomeTherapySession_therapistFeedbackId_fkey"
    FOREIGN KEY ("therapistFeedbackId") REFERENCES "HomeTherapyFeedback"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "HomeTherapySession_patientFeedbackId_fkey"
    FOREIGN KEY ("patientFeedbackId") REFERENCES "HomeTherapyFeedback"("id") ON DELETE SET NULL ON UPDATE CASCADE;
