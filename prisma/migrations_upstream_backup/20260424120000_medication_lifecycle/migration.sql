-- ─── Medication Lifecycle Tracking ──────────────────────────────────────────
-- Adds:
--   1. Prescription lifecycle columns — dispensed/consumed counters, dose frequency,
--      forecast end date, multi-stage reminder timestamps, discontinuation
--   2. NotificationPreference.medicationReminders — opt-out switch
--   3. Three new MessageTemplateCategory enum values for follow-up templates
--   4. FeatureRegistry row + HospitalFeatureFlag backfill
--
-- totalQuantity is retained for back-compat; new counters (dispensedQty /
-- consumedQty) are the source of truth going forward. Forecast math is
-- explained in services/medicationLifecycle.service.js.

-- ── Extend MessageTemplateCategory enum ─────────────────────────────────────
ALTER TYPE "MessageTemplateCategory" ADD VALUE IF NOT EXISTS 'MEDICATION_MISSED_FOLLOWUP';
ALTER TYPE "MessageTemplateCategory" ADD VALUE IF NOT EXISTS 'MEDICATION_REFILL_3D';
ALTER TYPE "MessageTemplateCategory" ADD VALUE IF NOT EXISTS 'MEDICATION_REFILL_LAST_DAY';

-- Note: ReminderKind enum is used by DeliveryService.send.kind; the medication
-- flow uses free-form 'kind' strings passed through to ReminderDeliveryLog
-- as the ReminderKind enum values already cover all currently-persisted kinds.
-- New medication kinds are logged via Notification.type instead of
-- ReminderDeliveryLog to avoid forcing another enum extension.

-- ── Prescription — lifecycle columns ───────────────────────────────────────
ALTER TABLE "Prescription"
    ADD COLUMN IF NOT EXISTS "startDate"             TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "expectedEndDate"       TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "dailyDoseCount"        INTEGER,
    ADD COLUMN IF NOT EXISTS "dispensedQty"          INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "consumedQty"           INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "missedDoseNotifiedAt"  TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "missedDoseStreak"      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "threeDayNotifiedAt"    TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "lastDayNotifiedAt"     TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "discontinuedAt"        TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "discontinuedReason"    TEXT;

-- Back-fill dispensedQty from the legacy totalQuantity — totalQuantity has
-- historically been the aggregate of pharmacy dispenses for that prescription,
-- so it's the correct seed for the new counter. consumedQty stays at 0 and
-- will catch up as MedicationLog entries are created going forward (old logs
-- are not retrofitted; adherence metrics will stabilize within 7 days).
UPDATE "Prescription"
SET "dispensedQty" = "totalQuantity"
WHERE "dispensedQty" = 0 AND "totalQuantity" > 0;

-- Index to keep the forecast cron fast (skips discontinued prescriptions).
CREATE INDEX IF NOT EXISTS "Prescription_lifecycle_idx"
    ON "Prescription" ("discontinuedAt", "expectedEndDate");

-- ── NotificationPreference — medication opt-out ────────────────────────────
ALTER TABLE "NotificationPreference"
    ADD COLUMN IF NOT EXISTS "medicationReminders" BOOLEAN NOT NULL DEFAULT true;

-- ── FeatureRegistry row ─────────────────────────────────────────────────────
INSERT INTO "FeatureRegistry" ("id", "key", "displayName", "description", "phase", "minPlan", "isCore", "defaultEnabled", "createdAt", "updatedAt")
VALUES (
    gen_random_uuid()::text,
    'MEDICATION_LIFECYCLE',
    'Medication Lifecycle Tracking',
    'Tracks prescriptions from prescribe → dispense → consumption → refill. Sends missed-dose follow-ups over WhatsApp (after 2-day streak), in-app refill reminders 3 days before supply runs out, and WhatsApp final nudge on the last day.',
    'CLINICAL',
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

-- Backfill HospitalFeatureFlag so every non-decommissioned tenant gets it on.
INSERT INTO "HospitalFeatureFlag" ("id", "hospitalId", "featureKey", "enabled", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    h."id",
    'MEDICATION_LIFECYCLE',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Hospital" h
WHERE h."status" != 'DECOMMISSIONED'
ON CONFLICT ("hospitalId", "featureKey") DO NOTHING;
