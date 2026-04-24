-- Follow-up schedule + Critical Journey flagging
--
-- After every consultation the doctor must either schedule a follow-up
-- (7/14/30/60/90 days or a custom offset) or explicitly mark the case
-- as a single visit. AppointmentFollowUp captures that decision in a
-- 1:1 row per Appointment.
--
-- Separately, patients who fail to adhere to their plan (missed meds,
-- missed vital uploads, missed follow-ups, etc.) are auto-flagged into
-- PatientCriticalFlag for the admin "Critical Journey" dashboard section.

-- ── Enums ──────────────────────────────────────────────────────────────
CREATE TYPE "FollowUpInterval" AS ENUM (
    'SEVEN_DAYS',
    'FOURTEEN_DAYS',
    'THIRTY_DAYS',
    'SIXTY_DAYS',
    'NINETY_DAYS',
    'CUSTOM',
    'SINGLE_VISIT'
);

CREATE TYPE "FollowUpStatus" AS ENUM (
    'PENDING',
    'COMPLETED',
    'MISSED',
    'CANCELLED'
);

CREATE TYPE "CriticalStatus" AS ENUM (
    'ACTIVE',
    'RESOLVED'
);

-- CriticalReasonType is stored as a string inside a JSONB `reasons` column
-- (see PatientCriticalFlag.reasons) so we do NOT create a Postgres enum for
-- it. Keeping it in JSON lets the detector evolve reason codes without a
-- schema migration every time.

-- ── AppointmentFollowUp ────────────────────────────────────────────────
CREATE TABLE "AppointmentFollowUp" (
    "id"                       TEXT                NOT NULL,
    "appointmentId"            TEXT                NOT NULL,
    "patientId"                TEXT                NOT NULL,
    "interval"                 "FollowUpInterval"  NOT NULL,
    "daysOffset"               INTEGER,
    "dueDate"                  TIMESTAMP(3),
    "isSingleVisit"            BOOLEAN             NOT NULL DEFAULT false,
    "status"                   "FollowUpStatus"    NOT NULL DEFAULT 'PENDING',
    "notes"                    TEXT,
    "createdById"              TEXT                NOT NULL,
    "completedByAppointmentId" TEXT,
    "missedNotifiedAt"         TIMESTAMP(3),
    "createdAt"                TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3)        NOT NULL,

    CONSTRAINT "AppointmentFollowUp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppointmentFollowUp_appointmentId_key" ON "AppointmentFollowUp"("appointmentId");
CREATE INDEX "AppointmentFollowUp_patientId_status_idx" ON "AppointmentFollowUp"("patientId", "status");
CREATE INDEX "AppointmentFollowUp_dueDate_status_idx" ON "AppointmentFollowUp"("dueDate", "status");
CREATE INDEX "AppointmentFollowUp_status_idx" ON "AppointmentFollowUp"("status");
CREATE INDEX "AppointmentFollowUp_createdById_idx" ON "AppointmentFollowUp"("createdById");

ALTER TABLE "AppointmentFollowUp"
    ADD CONSTRAINT "AppointmentFollowUp_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentFollowUp"
    ADD CONSTRAINT "AppointmentFollowUp_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentFollowUp"
    ADD CONSTRAINT "AppointmentFollowUp_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── PatientCriticalFlag ────────────────────────────────────────────────
-- One row per patient (enforced by unique index). Upsert-based — the
-- detector overwrites the reasons JSON every run. Status transitions
-- (ACTIVE → RESOLVED) are captured with a timestamp + actor for audit.
CREATE TABLE "PatientCriticalFlag" (
    "id"               TEXT             NOT NULL,
    "patientId"        TEXT             NOT NULL,
    "branchId"         TEXT,
    "status"           "CriticalStatus" NOT NULL DEFAULT 'ACTIVE',
    "severity"         TEXT             NOT NULL DEFAULT 'MEDIUM',
    "reasons"          JSONB            NOT NULL DEFAULT '[]'::jsonb,
    "firstDetectedAt"  TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"       TIMESTAMP(3),
    "resolvedById"     TEXT,
    "notes"            TEXT,
    "createdAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "PatientCriticalFlag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PatientCriticalFlag_patientId_key" ON "PatientCriticalFlag"("patientId");
CREATE INDEX "PatientCriticalFlag_status_lastDetectedAt_idx" ON "PatientCriticalFlag"("status", "lastDetectedAt");
CREATE INDEX "PatientCriticalFlag_branchId_status_idx" ON "PatientCriticalFlag"("branchId", "status");
CREATE INDEX "PatientCriticalFlag_severity_status_idx" ON "PatientCriticalFlag"("severity", "status");

ALTER TABLE "PatientCriticalFlag"
    ADD CONSTRAINT "PatientCriticalFlag_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PatientCriticalFlag"
    ADD CONSTRAINT "PatientCriticalFlag_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PatientCriticalFlag"
    ADD CONSTRAINT "PatientCriticalFlag_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── FeatureRegistry ────────────────────────────────────────────────────
-- Both features are core to every tenant (they replace ad-hoc/manual
-- tracking) so we register them as isCore=true, defaultEnabled=true.
-- Phase "CLINICAL_WORKFLOW" groups them with existing workflow features.
INSERT INTO "FeatureRegistry" (
    "id", "key", "displayName", "description", "phase", "minPlan",
    "isCore", "defaultEnabled", "createdAt", "updatedAt"
) VALUES
(
    gen_random_uuid()::text,
    'FOLLOWUP_REQUIRED_ON_COMPLETION',
    'Follow-up required on consultation completion',
    'Requires clinicians to assign a follow-up schedule (7/14/30/60/90 days or single-visit) when completing any consultation. Prevents COMPLETED status without a follow-up decision.',
    'CLINICAL_WORKFLOW',
    'STARTER',
    TRUE,
    TRUE,
    NOW(),
    NOW()
),
(
    gen_random_uuid()::text,
    'CRITICAL_JOURNEY_DASHBOARD',
    'Critical Journey admin dashboard',
    'Automatically flags patients who miss medications, skip required vital uploads, or miss scheduled follow-ups. Surfaces the list with specific reasons in the admin "Critical Journey" section.',
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
-- so the UI reflects the new features immediately (no wait for nightly
-- FeatureRegistrySync job).
INSERT INTO "HospitalFeatureFlag" (
    "id", "hospitalId", "featureKey", "enabled", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    h."id",
    fr."key",
    TRUE,
    NOW(),
    NOW()
FROM "Hospital" h
CROSS JOIN "FeatureRegistry" fr
WHERE h."status" <> 'DECOMMISSIONED'
  AND fr."key" IN ('FOLLOWUP_REQUIRED_ON_COMPLETION', 'CRITICAL_JOURNEY_DASHBOARD')
ON CONFLICT ("hospitalId", "featureKey") DO NOTHING;
