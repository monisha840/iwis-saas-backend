-- F04 · Predictive Dosha Imbalance Engine — nightly forecast history table.
-- Idempotent so a same-session re-apply via the pooler is safe.

CREATE TABLE IF NOT EXISTS "DoshaForecast" (
    "id"              TEXT         NOT NULL,
    "patientId"       TEXT         NOT NULL,
    "generatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "daysUntilSymp"   INTEGER      NOT NULL,
    "confidence"      DOUBLE PRECISION NOT NULL,
    "dominantDosha"   TEXT         NOT NULL,
    "imbalanceType"   TEXT         NOT NULL,
    "triggerFactors"  TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "alertEmitted"    BOOLEAN      NOT NULL DEFAULT false,
    "alertEmittedAt"  TIMESTAMP(3),
    "resolved"        BOOLEAN      NOT NULL DEFAULT false,
    "resolvedAt"      TIMESTAMP(3),

    CONSTRAINT "DoshaForecast_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DoshaForecast_patientId_generatedAt_idx"
    ON "DoshaForecast" ("patientId", "generatedAt");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'DoshaForecast_patientId_fkey'
    ) THEN
        ALTER TABLE "DoshaForecast"
            ADD CONSTRAINT "DoshaForecast_patientId_fkey"
            FOREIGN KEY ("patientId") REFERENCES "Patient"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
