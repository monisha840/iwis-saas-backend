-- F05 · Behavioural Nudge Engine — log table for LLM-generated nudges.
-- One row per outbound nudge. Patient daily check-in retroactively stamps
-- checkInCompleted / checkInAt when submitted within the message window.
-- Idempotent so a same-session re-apply via the pooler is safe.

CREATE TABLE IF NOT EXISTS "NudgeLog" (
    "id"               TEXT        NOT NULL,
    "patientId"        TEXT        NOT NULL,
    "sentAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archetype"        TEXT        NOT NULL,
    "messageText"      TEXT        NOT NULL,
    "checkInCompleted" BOOLEAN     NOT NULL DEFAULT false,
    "checkInAt"        TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NudgeLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "NudgeLog_patientId_sentAt_idx"
    ON "NudgeLog" ("patientId", "sentAt");

-- FK only added when missing — Postgres rejects duplicate ADD CONSTRAINT.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'NudgeLog_patientId_fkey'
    ) THEN
        ALTER TABLE "NudgeLog"
            ADD CONSTRAINT "NudgeLog_patientId_fkey"
            FOREIGN KEY ("patientId") REFERENCES "Patient"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
