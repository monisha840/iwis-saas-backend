/*
  Warnings:

  - A unique constraint covering the columns `[sku]` on the table `Medicine` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "ConsultationType" AS ENUM ('DOCTOR', 'THERAPIST', 'COMBINED');

-- DropForeignKey
ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_doctorId_fkey";

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "consultationType" "ConsultationType" NOT NULL DEFAULT 'DOCTOR',
ADD COLUMN     "doctorApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notificationSent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "therapistApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "therapistDate" TIMESTAMP(3),
ALTER COLUMN "doctorId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "MedicationLog" ADD COLUMN     "scheduledTime" TEXT,
ADD COLUMN     "slot" TEXT;

-- AlterTable
ALTER TABLE "Medicine" ADD COLUMN     "sku" TEXT,
ADD COLUMN     "type" TEXT,
ADD COLUMN     "videoUrl" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "priority" "NotificationPriority" NOT NULL DEFAULT 'INFO',
ADD COLUMN     "relatedId" TEXT;

-- AlterTable
ALTER TABLE "Prescription" ADD COLUMN     "sku" TEXT,
ADD COLUMN     "videoUrl" TEXT;

-- CreateTable
CREATE TABLE "LeaderboardConfig" (
    "id" TEXT NOT NULL,
    "appointmentWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "adherenceWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "responseTimeWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "successRateWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "consistencyWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "targetAppointments" INTEGER NOT NULL DEFAULT 50,
    "targetAdherence" DOUBLE PRECISION NOT NULL DEFAULT 90.0,
    "targetSuccessRate" DOUBLE PRECISION NOT NULL DEFAULT 80.0,
    "targetResponseTime" DOUBLE PRECISION NOT NULL DEFAULT 30.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderboardConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardAudit" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantRole" "Role" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "metrics" JSONB NOT NULL,
    "weights" JSONB NOT NULL,
    "sourceRecordIds" JSONB,
    "integrityHash" TEXT,
    "rank" INTEGER,
    "calculationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderboardAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeaderboardAudit_participantId_idx" ON "LeaderboardAudit"("participantId");

-- CreateIndex
CREATE INDEX "LeaderboardAudit_calculationDate_idx" ON "LeaderboardAudit"("calculationDate");

-- CreateIndex
CREATE INDEX "Appointment_branchId_idx" ON "Appointment"("branchId");

-- CreateIndex
CREATE INDEX "Appointment_doctorId_date_idx" ON "Appointment"("doctorId", "date");

-- CreateIndex
CREATE INDEX "Appointment_therapistId_date_idx" ON "Appointment"("therapistId", "date");

-- CreateIndex
CREATE INDEX "Appointment_patientId_status_idx" ON "Appointment"("patientId", "status");

-- CreateIndex
CREATE INDEX "Appointment_status_date_idx" ON "Appointment"("status", "date");

-- CreateIndex
CREATE INDEX "Appointment_branchId_date_idx" ON "Appointment"("branchId", "date");

-- CreateIndex
CREATE INDEX "Appointment_notificationSent_status_idx" ON "Appointment"("notificationSent", "status");

-- CreateIndex
CREATE INDEX "Availability_therapistId_idx" ON "Availability"("therapistId");

-- CreateIndex
CREATE INDEX "Availability_therapistId_dayOfWeek_idx" ON "Availability"("therapistId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "Availability_therapistId_isApproved_idx" ON "Availability"("therapistId", "isApproved");

-- CreateIndex
CREATE INDEX "Conversation_branchId_idx" ON "Conversation"("branchId");

-- CreateIndex
CREATE INDEX "Invoice_branchId_idx" ON "Invoice"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Medicine_sku_key" ON "Medicine"("sku");

-- CreateIndex
CREATE INDEX "MedicineStock_branchId_idx" ON "MedicineStock"("branchId");

-- CreateIndex
CREATE INDEX "Notification_relatedId_type_idx" ON "Notification"("relatedId", "type");

-- CreateIndex
CREATE INDEX "Payment_branchId_idx" ON "Payment"("branchId");

-- CreateIndex
CREATE INDEX "PharmacyDispense_branchId_idx" ON "PharmacyDispense"("branchId");

-- CreateIndex
CREATE INDEX "PharmacyOrder_branchId_idx" ON "PharmacyOrder"("branchId");

-- CreateIndex
CREATE INDEX "Prescription_branchId_idx" ON "Prescription"("branchId");

-- CreateIndex
CREATE INDEX "TriageSession_branchId_idx" ON "TriageSession"("branchId");

-- CreateIndex
CREATE INDEX "User_branchId_idx" ON "User"("branchId");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
