-- CreateEnum
CREATE TYPE "BadgeTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "tier" "BadgeTier" NOT NULL,
    "criteria" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBadge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicianStreak" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantRole" "Role" NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDate" TIMESTAMP(3),
    "graceUsedThisWeek" BOOLEAN NOT NULL DEFAULT false,
    "streakMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicianStreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchCompetition" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "metric" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchCompetition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchCompetitionEntry" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchCompetitionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyChallenge" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "pointReward" INTEGER NOT NULL DEFAULT 10,
    "activeDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientChallengeCompletion" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientChallengeCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZenPointsLedger" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZenPointsLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientStreak" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDate" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientStreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GamificationAnomaly" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantRole" "Role" NOT NULL,
    "anomalyType" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GamificationAnomaly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdaptiveTarget" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantRole" "Role" NOT NULL,
    "metric" TEXT NOT NULL,
    "personalTarget" DOUBLE PRECISION NOT NULL,
    "baseTarget" DOUBLE PRECISION NOT NULL,
    "adjustmentReason" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdaptiveTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Badge_code_key" ON "Badge"("code");

-- CreateIndex
CREATE INDEX "UserBadge_userId_idx" ON "UserBadge"("userId");

-- CreateIndex
CREATE INDEX "UserBadge_badgeId_idx" ON "UserBadge"("badgeId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBadge_userId_badgeId_key" ON "UserBadge"("userId", "badgeId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicianStreak_participantId_key" ON "ClinicianStreak"("participantId");

-- CreateIndex
CREATE INDEX "ClinicianStreak_participantId_idx" ON "ClinicianStreak"("participantId");

-- CreateIndex
CREATE INDEX "BranchCompetition_isActive_endDate_idx" ON "BranchCompetition"("isActive", "endDate");

-- CreateIndex
CREATE INDEX "BranchCompetitionEntry_competitionId_idx" ON "BranchCompetitionEntry"("competitionId");

-- CreateIndex
CREATE INDEX "BranchCompetitionEntry_branchId_idx" ON "BranchCompetitionEntry"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchCompetitionEntry_competitionId_branchId_key" ON "BranchCompetitionEntry"("competitionId", "branchId");

-- CreateIndex
CREATE INDEX "DailyChallenge_activeDate_idx" ON "DailyChallenge"("activeDate");

-- CreateIndex
CREATE INDEX "PatientChallengeCompletion_patientId_idx" ON "PatientChallengeCompletion"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientChallengeCompletion_patientId_challengeId_key" ON "PatientChallengeCompletion"("patientId", "challengeId");

-- CreateIndex
CREATE INDEX "ZenPointsLedger_patientId_idx" ON "ZenPointsLedger"("patientId");

-- CreateIndex
CREATE INDEX "ZenPointsLedger_patientId_createdAt_idx" ON "ZenPointsLedger"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "ZenPointsLedger_action_idx" ON "ZenPointsLedger"("action");

-- CreateIndex
CREATE UNIQUE INDEX "PatientStreak_patientId_key" ON "PatientStreak"("patientId");

-- CreateIndex
CREATE INDEX "PatientStreak_patientId_idx" ON "PatientStreak"("patientId");

-- CreateIndex
CREATE INDEX "GamificationAnomaly_participantId_idx" ON "GamificationAnomaly"("participantId");

-- CreateIndex
CREATE INDEX "GamificationAnomaly_anomalyType_idx" ON "GamificationAnomaly"("anomalyType");

-- CreateIndex
CREATE INDEX "GamificationAnomaly_resolved_idx" ON "GamificationAnomaly"("resolved");

-- CreateIndex
CREATE INDEX "AdaptiveTarget_participantId_idx" ON "AdaptiveTarget"("participantId");

-- CreateIndex
CREATE INDEX "AdaptiveTarget_effectiveFrom_idx" ON "AdaptiveTarget"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "AdaptiveTarget_participantId_metric_effectiveFrom_key" ON "AdaptiveTarget"("participantId", "metric", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchCompetition" ADD CONSTRAINT "BranchCompetition_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchCompetitionEntry" ADD CONSTRAINT "BranchCompetitionEntry_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "BranchCompetition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchCompetitionEntry" ADD CONSTRAINT "BranchCompetitionEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientChallengeCompletion" ADD CONSTRAINT "PatientChallengeCompletion_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientChallengeCompletion" ADD CONSTRAINT "PatientChallengeCompletion_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "DailyChallenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZenPointsLedger" ADD CONSTRAINT "ZenPointsLedger_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientStreak" ADD CONSTRAINT "PatientStreak_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

