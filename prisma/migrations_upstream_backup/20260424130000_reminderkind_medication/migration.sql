-- ─── ReminderKind enum — add medication reminder kinds ─────────────────────
-- These values are needed so that ReminderDeliveryLog rows written during
-- medication lifecycle sweeps (missed-dose follow-up, 3-day refill reminder,
-- last-day refill reminder) are persisted under their correct semantic kind
-- rather than piggybacking on APPOINTMENT_REMINDER.
--
-- This migration is pure DDL — the ALTER TYPE ADD VALUE statements only add
-- enum members. No runtime code uses them in the same transaction (services
-- will see them on the next connection cycle), so the Postgres constraint
-- "unsafe use of new value of enum type" does not apply.

ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'MEDICATION_MISSED_FOLLOWUP';
ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'MEDICATION_REFILL_3D';
ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'MEDICATION_REFILL_LAST_DAY';
