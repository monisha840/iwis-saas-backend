-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "dailyRoomExpiry" TIMESTAMP(3),
ADD COLUMN     "dailyRoomName" TEXT,
ADD COLUMN     "dailyRoomUrl" TEXT,
ADD COLUMN     "videoSessionEndedAt" TIMESTAMP(3),
ADD COLUMN     "videoSessionStartedAt" TIMESTAMP(3);
