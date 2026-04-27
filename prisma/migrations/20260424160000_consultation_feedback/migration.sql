-- Structured 4-question feedback captured after a consultation is marked COMPLETED.
-- One record per appointment (see UNIQUE on appointmentId). XP is calculated
-- server-side at submission time and credited to the doctor via
-- ClinicianXPService, so xpAwarded is an immutable snapshot — do not update it
-- later if the grading rules change.

CREATE TYPE "FeedbackMcqOption" AS ENUM ('A', 'B', 'C', 'D');

CREATE TABLE "ConsultationFeedback" (
    "id"                   TEXT NOT NULL,
    "appointmentId"        TEXT NOT NULL,
    "patientId"            TEXT NOT NULL,
    "doctorId"             TEXT NOT NULL,
    "branchId"             TEXT,
    "faceScaleEmotional"   INTEGER,
    "faceScaleConfidence"  INTEGER,
    "mcqListening"         "FeedbackMcqOption",
    "mcqReturn"            "FeedbackMcqOption",
    "xpAwarded"            INTEGER NOT NULL DEFAULT 0,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"          TIMESTAMP(3),

    CONSTRAINT "ConsultationFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConsultationFeedback_appointmentId_key" ON "ConsultationFeedback"("appointmentId");
CREATE INDEX "ConsultationFeedback_doctorId_idx"    ON "ConsultationFeedback"("doctorId");
CREATE INDEX "ConsultationFeedback_patientId_idx"   ON "ConsultationFeedback"("patientId");
CREATE INDEX "ConsultationFeedback_branchId_idx"    ON "ConsultationFeedback"("branchId");
CREATE INDEX "ConsultationFeedback_createdAt_idx"   ON "ConsultationFeedback"("createdAt");

ALTER TABLE "ConsultationFeedback"
    ADD CONSTRAINT "ConsultationFeedback_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConsultationFeedback"
    ADD CONSTRAINT "ConsultationFeedback_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConsultationFeedback"
    ADD CONSTRAINT "ConsultationFeedback_doctorId_fkey"
    FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConsultationFeedback"
    ADD CONSTRAINT "ConsultationFeedback_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
