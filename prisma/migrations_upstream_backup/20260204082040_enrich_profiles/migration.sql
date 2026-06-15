/*
  Warnings:

  - A unique constraint covering the columns `[patientId]` on the table `Patient` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Doctor" ADD COLUMN     "clinic" TEXT,
ADD COLUMN     "fullName" TEXT,
ADD COLUMN     "profilePhoto" TEXT,
ADD COLUMN     "qualification" TEXT,
ADD COLUMN     "specialization" TEXT,
ADD COLUMN     "yearsExperience" INTEGER;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "age" INTEGER,
ADD COLUMN     "dob" TIMESTAMP(3),
ADD COLUMN     "fullName" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "patientId" TEXT,
ADD COLUMN     "phoneNumber" TEXT,
ADD COLUMN     "therapyType" TEXT;

-- AlterTable
ALTER TABLE "Therapist" ADD COLUMN     "clinic" TEXT,
ADD COLUMN     "fullName" TEXT,
ADD COLUMN     "profilePhoto" TEXT,
ADD COLUMN     "qualification" TEXT,
ADD COLUMN     "specialization" TEXT,
ADD COLUMN     "yearsExperience" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Patient_patientId_key" ON "Patient"("patientId");
