-- Track the last time the refill-expiry cron notified the patient/clinician
-- for this prescription. Without this, the cron re-sends the same notification
-- every day until the prescription expires.
ALTER TABLE "Prescription" ADD COLUMN "refillNotifiedAt" TIMESTAMP(3);
