-- Track when the post-appointment CSAT survey notification was dispatched so
-- the 15-minute cron sweep can filter on `csatSentAt IS NULL` and stop
-- duplicating notifications when its time-window drifts.

ALTER TABLE "Appointment" ADD COLUMN "csatSentAt" TIMESTAMP(3);

CREATE INDEX "Appointment_csatSentAt_idx" ON "Appointment"("csatSentAt");
