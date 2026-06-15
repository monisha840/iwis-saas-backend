-- PrescribedVital: doctor-prescribed vitals that drive the patient dashboard tiles.

CREATE TABLE IF NOT EXISTS "PrescribedVital" (
    "id"             TEXT NOT NULL,
    "patientId"      TEXT NOT NULL,
    "vitalType"      "VitalType" NOT NULL,
    "frequency"      TEXT NOT NULL DEFAULT 'DAILY',
    "notes"          TEXT,
    "active"         BOOLEAN NOT NULL DEFAULT true,
    "prescribedById" TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrescribedVital_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PrescribedVital_patientId_vitalType_key"
    ON "PrescribedVital"("patientId", "vitalType");

CREATE INDEX IF NOT EXISTS "PrescribedVital_patientId_active_idx"
    ON "PrescribedVital"("patientId", "active");

CREATE INDEX IF NOT EXISTS "PrescribedVital_prescribedById_idx"
    ON "PrescribedVital"("prescribedById");

ALTER TABLE "PrescribedVital"
    ADD CONSTRAINT "PrescribedVital_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrescribedVital"
    ADD CONSTRAINT "PrescribedVital_prescribedById_fkey"
    FOREIGN KEY ("prescribedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
