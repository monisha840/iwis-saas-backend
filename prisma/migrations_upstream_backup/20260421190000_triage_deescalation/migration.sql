-- Track re-triage de-escalation alongside escalation so care teams can see when
-- a patient's urgency dropped after follow-up inputs (previously silent).
ALTER TABLE "TriageSession"
ADD COLUMN "deEscalatedAfterUpdate" BOOLEAN NOT NULL DEFAULT false;
