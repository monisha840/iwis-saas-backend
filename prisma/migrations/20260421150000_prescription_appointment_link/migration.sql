-- Link prescriptions to the appointment they were authored in.
-- Enables reliable visit-summary prescription lookup without date-window heuristics.

ALTER TABLE "Prescription" ADD COLUMN IF NOT EXISTS "appointmentId" TEXT;

CREATE INDEX IF NOT EXISTS "Prescription_appointmentId_idx"
    ON "Prescription"("appointmentId");

-- SetNull on delete: if an appointment is hard-deleted, the prescription
-- record survives with a null link rather than being cascade-removed.
ALTER TABLE "Prescription"
    ADD CONSTRAINT "Prescription_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
