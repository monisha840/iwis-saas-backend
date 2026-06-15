-- Home Therapy: optional scheduling interval (in days) between sessions.
-- The doctor sets this on the prescription form when the protocol calls
-- for explicit spacing (1 = daily, 2 = every other day, 7 = weekly).
-- Null when not specified.

ALTER TABLE "HomeTherapyRequest"
  ADD COLUMN "intervalDays" INTEGER;
