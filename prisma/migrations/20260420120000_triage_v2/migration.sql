-- ── Triage v2: red-flags, split confidence, re-triage, clinician override, DB-backed specialty routing

-- TriageSession: new columns
ALTER TABLE "TriageSession"
  ADD COLUMN "inputCompleteness"      DOUBLE PRECISION,
  ADD COLUMN "routingMatchStrength"   DOUBLE PRECISION,
  ADD COLUMN "redFlagsMatched"        TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "redFlagForced"          BOOLEAN        NOT NULL DEFAULT false,
  ADD COLUMN "reviewCount"            INTEGER        NOT NULL DEFAULT 0,
  ADD COLUMN "previousScore"          DOUBLE PRECISION,
  ADD COLUMN "previousUrgencyLevel"   TEXT,
  ADD COLUMN "escalatedAfterUpdate"   BOOLEAN        NOT NULL DEFAULT false,
  ADD COLUMN "heldSlotClinicianId"    TEXT,
  ADD COLUMN "heldSlotDate"           TIMESTAMP(3),
  ADD COLUMN "heldSlotTime"           TEXT,
  ADD COLUMN "reviewedByUserId"       TEXT,
  ADD COLUMN "reviewedAt"             TIMESTAMP(3),
  ADD COLUMN "overriddenUrgencyLevel" TEXT,
  ADD COLUMN "overriddenSpecialty"    TEXT,
  ADD COLUMN "overrideReason"         TEXT;

CREATE INDEX "TriageSession_urgencyLevel_idx"    ON "TriageSession"("urgencyLevel");
CREATE INDEX "TriageSession_reviewedByUserId_idx" ON "TriageSession"("reviewedByUserId");

-- TriageOverride ledger
CREATE TABLE "TriageOverride" (
    "id"                     TEXT          NOT NULL,
    "triageSessionId"        TEXT          NOT NULL,
    "reviewerUserId"         TEXT          NOT NULL,
    "originalUrgencyLevel"   TEXT,
    "overriddenUrgencyLevel" TEXT,
    "originalSpecialty"      TEXT,
    "overriddenSpecialty"    TEXT,
    "reason"                 TEXT,
    "factorDisagreement"     JSONB,
    "createdAt"              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TriageOverride_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TriageOverride_triageSessionId_idx" ON "TriageOverride"("triageSessionId");
CREATE INDEX "TriageOverride_reviewerUserId_idx"  ON "TriageOverride"("reviewerUserId");
CREATE INDEX "TriageOverride_createdAt_idx"       ON "TriageOverride"("createdAt");
ALTER TABLE "TriageOverride"
    ADD CONSTRAINT "TriageOverride_triageSessionId_fkey"
    FOREIGN KEY ("triageSessionId") REFERENCES "TriageSession"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SpecialtyRoute: DB-backed routing vocabulary
CREATE TABLE "SpecialtyRoute" (
    "id"         TEXT          NOT NULL,
    "specialty"  TEXT          NOT NULL,
    "tags"       TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
    "priority"   INTEGER       NOT NULL DEFAULT 0,
    "isActive"   BOOLEAN       NOT NULL DEFAULT true,
    "createdAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3)  NOT NULL,
    CONSTRAINT "SpecialtyRoute_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SpecialtyRoute_specialty_key"           ON "SpecialtyRoute"("specialty");
CREATE INDEX        "SpecialtyRoute_isActive_priority_idx"  ON "SpecialtyRoute"("isActive", "priority");

-- Seed routing vocabulary (exact-tag match; matches the legacy hardcoded set)
INSERT INTO "SpecialtyRoute" ("id", "specialty", "tags", "priority", "updatedAt") VALUES
  (gen_random_uuid()::text, 'Orthopaedic & Joint Care',
   ARRAY['joint','knee','shoulder','hip','back','neck','left-knee','right-knee','left-shoulder','right-shoulder','left-hip','right-hip','lower-back','upper-back','ankle','wrist','elbow'],
   10, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Gastroenterology & Digestive Health',
   ARRAY['abdomen','digestive','bowel','nausea','bloating','stomach','acid','constipation','diarrhoea','stomach pain'],
   10, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Respiratory & Pulmonary Care',
   ARRAY['chest','respiratory','breathing','cough','wheeze','shortness of breath'],
   10, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Mind & Wellness',
   ARRAY['head','stress','anxiety','sleep','mental','depression','panic','insomnia'],
   8, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Dermatology & Skin Care',
   ARRAY['skin','rash','hair','nail','acne','eczema','psoriasis'],
   10, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Women''s Health',
   ARRAY['female','menstrual','pelvic','pregnancy','postpartum','menopause'],
   12, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Metabolic & Endocrine Care',
   ARRAY['metabolic','weight','thyroid','diabetes','hormone'],
   10, CURRENT_TIMESTAMP);
