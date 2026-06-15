-- Per-hospital admin overrides for the Self-Exam Protocol (zone → test list).
--
-- The default protocol lives in code (`services/selfExam.protocol.js`:
-- `DEFAULT_ZONE_PROTOCOLS`). Each row here overrides a single pain-zone's
-- config for a single hospital. Config shape mirrors the code-level default:
--   {
--     symptomHistory: { critical?: bool, urgentCareWarning?: bool } | bool,
--     tongue:         { days: int, critical?: bool },
--     stool:          { days: int, critical?: bool },
--     urine:          { days: int },
--     rom:            { joints: RoMJoint[], directions: RoMDirection[] },
--     physicalObservations: PhysicalObservationType[],
--     voice:          { days: int },
--     digestive:      bool,
--     lifestyle:      bool,
--     constitutionQuiz: bool,
--   }
--
-- Absence of a row for a (hospital, zone) pair = use the code-level default.

CREATE TABLE "SelfExamProtocolOverride" (
    "id"          TEXT PRIMARY KEY,
    "hospitalId"  TEXT NOT NULL,
    "painZone"    "PainZone" NOT NULL,
    "config"      JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfExamProtocolOverride_hospitalId_fkey"
        FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SelfExamProtocolOverride_updatedById_fkey"
        FOREIGN KEY ("updatedById") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SelfExamProtocolOverride_hospitalId_painZone_key"
    ON "SelfExamProtocolOverride"("hospitalId", "painZone");

CREATE INDEX "SelfExamProtocolOverride_hospitalId_idx"
    ON "SelfExamProtocolOverride"("hospitalId");
