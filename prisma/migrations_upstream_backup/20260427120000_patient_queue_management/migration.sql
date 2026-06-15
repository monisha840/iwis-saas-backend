-- Live patient queue / arrival tracking — adds arrival fields to Appointment
-- and creates the QueueEntry model. Both rows are written in the same
-- transaction by queueService.* so they cannot drift.

-- 1. Extend Appointment with arrival/queue tracking fields. All nullable
--    except arrivalStatus, which defaults to 'NOT_ARRIVED' to keep the
--    rest of the system reading sensible values for legacy rows.
ALTER TABLE "Appointment"
  ADD COLUMN "arrivalStatus"         TEXT      NOT NULL DEFAULT 'NOT_ARRIVED',
  ADD COLUMN "arrivedAt"             TIMESTAMP(3),
  ADD COLUMN "consultationStartedAt" TIMESTAMP(3),
  ADD COLUMN "consultationEndedAt"   TIMESTAMP(3),
  ADD COLUMN "queuePosition"         INTEGER,
  ADD COLUMN "absentContactedAt"     TIMESTAMP(3);

-- 2. QueueEntry — live queue record for a doctor on a given day.
CREATE TABLE "QueueEntry" (
  "id"                     TEXT          NOT NULL,
  "appointmentId"          TEXT          NOT NULL,
  "doctorId"               TEXT          NOT NULL,
  "branchId"               TEXT          NOT NULL,
  "date"                   DATE          NOT NULL,
  "queuePosition"          INTEGER       NOT NULL,
  "arrivalStatus"          TEXT          NOT NULL DEFAULT 'NOT_ARRIVED',
  "arrivedAt"              TIMESTAMP(3),
  "consultationStartedAt"  TIMESTAMP(3),
  "consultationEndedAt"    TIMESTAMP(3),
  "absentContactedAt"      TIMESTAMP(3),
  "contactNote"            TEXT,
  "contactedById"          TEXT,
  "createdAt"              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "QueueEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QueueEntry_appointmentId_key" ON "QueueEntry"("appointmentId");
CREATE INDEX "QueueEntry_doctorId_date_branchId_idx" ON "QueueEntry"("doctorId", "date", "branchId");
CREATE INDEX "QueueEntry_branchId_date_idx" ON "QueueEntry"("branchId", "date");
CREATE INDEX "QueueEntry_date_arrivalStatus_idx" ON "QueueEntry"("date", "arrivalStatus");

ALTER TABLE "QueueEntry"
  ADD CONSTRAINT "QueueEntry_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QueueEntry"
  ADD CONSTRAINT "QueueEntry_doctorId_fkey"
  FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "QueueEntry"
  ADD CONSTRAINT "QueueEntry_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
