-- ── IWIS Super Admin: Phase A.2 — Hospital / FeatureRegistry schema ─────────

-- CreateEnum
CREATE TYPE "HospitalStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_SETUP', 'DECOMMISSIONED');
CREATE TYPE "HospitalPlan" AS ENUM ('STARTER', 'PROFESSIONAL', 'ENTERPRISE');

-- CreateTable: Hospital
CREATE TABLE "Hospital" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "address" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "status" "HospitalStatus" NOT NULL DEFAULT 'ACTIVE',
    "plan" "HospitalPlan" NOT NULL DEFAULT 'STARTER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "suspendedAt" TIMESTAMP(3),
    "suspendedById" TEXT,

    CONSTRAINT "Hospital_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Hospital_slug_key" ON "Hospital"("slug");
CREATE INDEX "Hospital_status_idx" ON "Hospital"("status");
CREATE INDEX "Hospital_plan_idx" ON "Hospital"("plan");

-- CreateTable: FeatureRegistry
CREATE TABLE "FeatureRegistry" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "phase" TEXT NOT NULL,
    "minPlan" "HospitalPlan" NOT NULL,
    "isCore" BOOLEAN NOT NULL DEFAULT false,
    "defaultEnabled" BOOLEAN NOT NULL DEFAULT false,
    "addedInVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureRegistry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FeatureRegistry_key_key" ON "FeatureRegistry"("key");
CREATE INDEX "FeatureRegistry_phase_idx" ON "FeatureRegistry"("phase");
CREATE INDEX "FeatureRegistry_minPlan_idx" ON "FeatureRegistry"("minPlan");

-- CreateTable: HospitalFeatureFlag
CREATE TABLE "HospitalFeatureFlag" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "enabledById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalFeatureFlag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HospitalFeatureFlag_hospitalId_featureKey_key" ON "HospitalFeatureFlag"("hospitalId", "featureKey");
CREATE INDEX "HospitalFeatureFlag_featureKey_idx" ON "HospitalFeatureFlag"("featureKey");
CREATE INDEX "HospitalFeatureFlag_hospitalId_idx" ON "HospitalFeatureFlag"("hospitalId");

-- CreateTable: SuperAdminAuditLog
CREATE TABLE "SuperAdminAuditLog" (
    "id" TEXT NOT NULL,
    "superAdminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "hospitalId" TEXT,
    "featureKey" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuperAdminAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SuperAdminAuditLog_superAdminId_idx" ON "SuperAdminAuditLog"("superAdminId");
CREATE INDEX "SuperAdminAuditLog_hospitalId_idx" ON "SuperAdminAuditLog"("hospitalId");
CREATE INDEX "SuperAdminAuditLog_action_idx" ON "SuperAdminAuditLog"("action");
CREATE INDEX "SuperAdminAuditLog_createdAt_idx" ON "SuperAdminAuditLog"("createdAt");

-- AlterTable: User (nullable — SUPER_ADMIN users keep NULL)
ALTER TABLE "User" ADD COLUMN "hospitalId" TEXT;
CREATE INDEX "User_hospitalId_idx" ON "User"("hospitalId");

-- AlterTable: Branch (nullable for now; tightened to NOT NULL after backfill below)
ALTER TABLE "Branch" ADD COLUMN "hospitalId" TEXT;

-- Backfill: create default hospital and attach all existing data to it.
INSERT INTO "Hospital" (
    "id", "name", "slug", "contactEmail", "status", "plan", "updatedAt"
) VALUES (
    'hosp_default_alshifa',
    'Al Shifa (Default)',
    'al-shifa-default',
    'admin@alshifa.local',
    'ACTIVE',
    'ENTERPRISE',
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

-- Attach existing non-SUPER_ADMIN users.
UPDATE "User"
   SET "hospitalId" = 'hosp_default_alshifa'
 WHERE "role" <> 'SUPER_ADMIN' AND "hospitalId" IS NULL;

-- Attach all existing branches.
UPDATE "Branch"
   SET "hospitalId" = 'hosp_default_alshifa'
 WHERE "hospitalId" IS NULL;

-- Now tighten Branch.hospitalId to NOT NULL (User stays nullable for SUPER_ADMIN).
ALTER TABLE "Branch" ALTER COLUMN "hospitalId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_hospitalId_fkey"
    FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Branch" ADD CONSTRAINT "Branch_hospitalId_fkey"
    FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HospitalFeatureFlag" ADD CONSTRAINT "HospitalFeatureFlag_hospitalId_fkey"
    FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HospitalFeatureFlag" ADD CONSTRAINT "HospitalFeatureFlag_featureKey_fkey"
    FOREIGN KEY ("featureKey") REFERENCES "FeatureRegistry"("key") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HospitalFeatureFlag" ADD CONSTRAINT "HospitalFeatureFlag_enabledById_fkey"
    FOREIGN KEY ("enabledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SuperAdminAuditLog" ADD CONSTRAINT "SuperAdminAuditLog_superAdminId_fkey"
    FOREIGN KEY ("superAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SuperAdminAuditLog" ADD CONSTRAINT "SuperAdminAuditLog_hospitalId_fkey"
    FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;
