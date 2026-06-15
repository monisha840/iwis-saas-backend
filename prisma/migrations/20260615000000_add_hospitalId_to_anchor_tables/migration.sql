-- AlterTable
ALTER TABLE "AdaptiveTarget" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "Availability" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "BlockedSlot" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "BulkOperation" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "ClinicalPhoto" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "ClinicianStreak" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "DietPrescription" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "Doctor" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "GamificationAnomaly" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "Journey" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "LeaderboardAudit" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "PackageEnrolment" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "PatientAssignment" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "PerformanceScorecard" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "Pharmacist" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "SeasonalChallengeProgress" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "StaffMessage" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "StaffThreadMember" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "Therapist" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "VoiceConversation" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "VoiceMessage" ADD COLUMN     "hospitalId" TEXT;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientAssignment" ADD CONSTRAINT "PatientAssignment_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedSlot" ADD CONSTRAINT "BlockedSlot_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Therapist" ADD CONSTRAINT "Therapist_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pharmacist" ADD CONSTRAINT "Pharmacist_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Journey" ADD CONSTRAINT "Journey_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkOperation" ADD CONSTRAINT "BulkOperation_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffThreadMember" ADD CONSTRAINT "StaffThreadMember_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMessage" ADD CONSTRAINT "StaffMessage_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderboardAudit" ADD CONSTRAINT "LeaderboardAudit_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicianStreak" ADD CONSTRAINT "ClinicianStreak_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamificationAnomaly" ADD CONSTRAINT "GamificationAnomaly_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdaptiveTarget" ADD CONSTRAINT "AdaptiveTarget_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceScorecard" ADD CONSTRAINT "PerformanceScorecard_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonalChallengeProgress" ADD CONSTRAINT "SeasonalChallengeProgress_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietPrescription" ADD CONSTRAINT "DietPrescription_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalPhoto" ADD CONSTRAINT "ClinicalPhoto_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageEnrolment" ADD CONSTRAINT "PackageEnrolment_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceConversation" ADD CONSTRAINT "VoiceConversation_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceMessage" ADD CONSTRAINT "VoiceMessage_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

