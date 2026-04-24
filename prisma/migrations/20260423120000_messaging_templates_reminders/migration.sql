-- ─── Messaging Templates & Configurable Reminders ─────────────────────────────
-- Adds:
--   1. MessageTemplate — hospital-scoped reusable template library
--   2. ReminderSetting — per-hospital daily check-in broadcast config
--   3. ReminderDeliveryLog — per-attempt audit trail for any reminder
--   4. Appointment columns — per-appointment template override + inline body
--
-- Also inserts a row into FeatureRegistry so hospitals can toggle the whole
-- subsystem via the existing super-admin feature flag UI.

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE "MessageTemplateCategory" AS ENUM (
        'DAILY_CHECKIN',
        'APPOINTMENT_CONFIRMATION',
        'APPOINTMENT_REMINDER',
        'CUSTOM'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "DeliveryChannel" AS ENUM (
        'WHATSAPP',
        'SMS',
        'EMAIL',
        'IN_APP'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "ReminderKind" AS ENUM (
        'DAILY_CHECKIN',
        'APPOINTMENT_CONFIRMATION',
        'APPOINTMENT_REMINDER'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "DeliveryStatus" AS ENUM (
        'SENT',
        'FAILED',
        'SKIPPED',
        'FALLBACK'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── MessageTemplate ─────────────────────────────────────────────────────────
CREATE TABLE "MessageTemplate" (
    "id"             TEXT PRIMARY KEY,
    "hospitalId"     TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "category"       "MessageTemplateCategory" NOT NULL,
    "body"           TEXT NOT NULL,
    "subject"        TEXT,
    "channels"       "DeliveryChannel"[] NOT NULL DEFAULT ARRAY['WHATSAPP']::"DeliveryChannel"[],
    "placeholders"   JSONB NOT NULL DEFAULT '[]'::jsonb,
    "isDefault"      BOOLEAN NOT NULL DEFAULT false,
    "isActive"       BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageTemplate_hospital_fk" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE,
    CONSTRAINT "MessageTemplate_creator_fk" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL,
    CONSTRAINT "MessageTemplate_editor_fk" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL
);

CREATE INDEX "MessageTemplate_hospitalId_idx" ON "MessageTemplate" ("hospitalId");
CREATE INDEX "MessageTemplate_hospital_category_idx" ON "MessageTemplate" ("hospitalId", "category");
CREATE INDEX "MessageTemplate_isActive_idx" ON "MessageTemplate" ("isActive");
CREATE UNIQUE INDEX "MessageTemplate_hospital_name_uq" ON "MessageTemplate" ("hospitalId", "name");

-- Only one default-per-category-per-hospital
CREATE UNIQUE INDEX "MessageTemplate_hospital_category_default_uq"
    ON "MessageTemplate" ("hospitalId", "category")
    WHERE "isDefault" = true;

-- ── ReminderSetting ─────────────────────────────────────────────────────────
CREATE TABLE "ReminderSetting" (
    "id"                           TEXT PRIMARY KEY,
    "hospitalId"                   TEXT NOT NULL UNIQUE,
    "dailyReminderEnabled"         BOOLEAN NOT NULL DEFAULT true,
    "dailyReminderTime"            TEXT NOT NULL DEFAULT '07:30', -- HH:MM (24h) in hospital's timezone
    "dailyReminderChannels"        "DeliveryChannel"[] NOT NULL DEFAULT ARRAY['WHATSAPP','IN_APP']::"DeliveryChannel"[],
    "dailyReminderTemplateId"      TEXT,
    "dailyReminderInlineBody"      TEXT, -- used if templateId is null
    "skipIfAlreadyCheckedIn"       BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt"                    TIMESTAMP(3),
    "lastRunTargetCount"           INT,
    "lastRunSuccessCount"          INT,
    "createdAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReminderSetting_hospital_fk" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE,
    CONSTRAINT "ReminderSetting_template_fk" FOREIGN KEY ("dailyReminderTemplateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL
);

-- ── ReminderDeliveryLog ─────────────────────────────────────────────────────
CREATE TABLE "ReminderDeliveryLog" (
    "id"             TEXT PRIMARY KEY,
    "hospitalId"     TEXT,
    "patientUserId"  TEXT,
    "appointmentId"  TEXT,
    "kind"           "ReminderKind" NOT NULL,
    "channel"        "DeliveryChannel" NOT NULL,
    "status"         "DeliveryStatus" NOT NULL,
    "target"         TEXT,             -- phone / email / userId actually used
    "externalId"     TEXT,             -- provider message id (Evolution, Twilio, Nodemailer)
    "errorMessage"   TEXT,
    "body"           TEXT,
    "templateId"     TEXT,             -- snapshot of which template rendered this
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReminderDeliveryLog_hospital_fk" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL,
    CONSTRAINT "ReminderDeliveryLog_user_fk" FOREIGN KEY ("patientUserId") REFERENCES "User"("id") ON DELETE SET NULL,
    CONSTRAINT "ReminderDeliveryLog_appointment_fk" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL,
    CONSTRAINT "ReminderDeliveryLog_template_fk" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL
);

CREATE INDEX "ReminderDeliveryLog_hospital_kind_idx" ON "ReminderDeliveryLog" ("hospitalId", "kind");
CREATE INDEX "ReminderDeliveryLog_appointment_idx" ON "ReminderDeliveryLog" ("appointmentId");
CREATE INDEX "ReminderDeliveryLog_user_idx" ON "ReminderDeliveryLog" ("patientUserId");
CREATE INDEX "ReminderDeliveryLog_createdAt_idx" ON "ReminderDeliveryLog" ("createdAt");

-- ── Appointment — per-appointment template override ────────────────────────
ALTER TABLE "Appointment"
    ADD COLUMN "customReminderTemplateId" TEXT,
    ADD COLUMN "customReminderBody"       TEXT,
    ADD COLUMN "customReminderChannels"   "DeliveryChannel"[] NOT NULL DEFAULT ARRAY[]::"DeliveryChannel"[],
    ADD COLUMN "customReminderSubject"    TEXT,
    ADD COLUMN "customReminderUpdatedAt"  TIMESTAMP(3),
    ADD COLUMN "customReminderUpdatedById" TEXT;

ALTER TABLE "Appointment"
    ADD CONSTRAINT "Appointment_customReminderTemplate_fk"
        FOREIGN KEY ("customReminderTemplateId")
        REFERENCES "MessageTemplate"("id")
        ON DELETE SET NULL;

ALTER TABLE "Appointment"
    ADD CONSTRAINT "Appointment_customReminderEditor_fk"
        FOREIGN KEY ("customReminderUpdatedById")
        REFERENCES "User"("id")
        ON DELETE SET NULL;

CREATE INDEX "Appointment_customReminderTemplateId_idx" ON "Appointment" ("customReminderTemplateId");

-- ── FeatureRegistry row ─────────────────────────────────────────────────────
INSERT INTO "FeatureRegistry" ("id", "key", "displayName", "description", "phase", "minPlan", "isCore", "defaultEnabled", "createdAt", "updatedAt")
VALUES (
    gen_random_uuid()::text,
    'MESSAGING_TEMPLATES',
    'Customizable Message Templates',
    'Per-hospital reusable message templates with placeholders, configurable daily check-in reminders, and per-appointment custom messaging with fallback delivery across WhatsApp / SMS / Email.',
    'COMMUNICATIONS',
    'STARTER',
    true,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO UPDATE SET
    "displayName"    = EXCLUDED."displayName",
    "description"    = EXCLUDED."description",
    "phase"          = EXCLUDED."phase",
    "minPlan"        = EXCLUDED."minPlan",
    "isCore"         = EXCLUDED."isCore",
    "defaultEnabled" = EXCLUDED."defaultEnabled",
    "updatedAt"      = CURRENT_TIMESTAMP;

-- Backfill HospitalFeatureFlag so the UI surfaces it immediately
INSERT INTO "HospitalFeatureFlag" ("id", "hospitalId", "featureKey", "enabled", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    h."id",
    'MESSAGING_TEMPLATES',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Hospital" h
WHERE h."status" != 'DECOMMISSIONED'
ON CONFLICT ("hospitalId", "featureKey") DO NOTHING;
