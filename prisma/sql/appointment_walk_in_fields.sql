-- Adds the walk-in marker + notes columns to Appointment.
-- Idempotent: safe to re-run; uses IF NOT EXISTS so a partial first run
-- can be completed without manual cleanup.
--
-- Why these columns: the walk-in booking handler (routes/appointments.js)
-- has been trying to persist `isWalkIn` and `walkInNotes` since walk-in
-- was added; the columns were never created, so every walk-in save fired
-- a Prisma "unknown field" error. The frontend (AppointmentCard.tsx and
-- appointment-list.tsx) gates the "Walk-In" badge on `appointment.isWalkIn`,
-- so the badge has been silently dead until now.

ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "isWalkIn"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "walkInNotes" TEXT;
