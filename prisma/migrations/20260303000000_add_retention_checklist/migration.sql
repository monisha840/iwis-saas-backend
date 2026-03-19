-- CreateEnum
CREATE TYPE "RetentionStatus" AS ENUM ('COMPLETED', 'PARTIAL', 'NOT_FOLLOWED');

-- CreateTable
CREATE TABLE "RetentionChecklist" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "clinicianRole" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "branchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RetentionChecklist_appointmentId_key" ON "RetentionChecklist"("appointmentId");

-- CreateIndex
CREATE INDEX "RetentionChecklist_patientId_idx" ON "RetentionChecklist"("patientId");

-- CreateIndex
CREATE INDEX "RetentionChecklist_appointmentId_idx" ON "RetentionChecklist"("appointmentId");

-- CreateIndex
CREATE INDEX "RetentionChecklist_clinicianId_idx" ON "RetentionChecklist"("clinicianId");

-- CreateIndex
CREATE INDEX "RetentionChecklist_branchId_idx" ON "RetentionChecklist"("branchId");

-- CreateIndex
CREATE INDEX "RetentionChecklist_clinicianId_createdAt_idx" ON "RetentionChecklist"("clinicianId", "createdAt");

-- AddForeignKey
ALTER TABLE "RetentionChecklist" ADD CONSTRAINT "RetentionChecklist_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionChecklist" ADD CONSTRAINT "RetentionChecklist_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
