-- Dashboard Refactor: Todo system (IWIS_Dashboard_Refactor_Spec.md §2, §8)

-- Enums
DO $$ BEGIN CREATE TYPE "TodoPriority" AS ENUM ('LOW','MEDIUM','HIGH','URGENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TodoStatus"   AS ENUM ('PENDING','IN_PROGRESS','COMPLETED','DISMISSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Todo table
CREATE TABLE IF NOT EXISTS "Todo" (
  "id"                   TEXT PRIMARY KEY,
  "title"                VARCHAR(120) NOT NULL,
  "description"          TEXT,
  "priority"             "TodoPriority" NOT NULL DEFAULT 'MEDIUM',
  "status"               "TodoStatus"   NOT NULL DEFAULT 'PENDING',
  "dueDate"              TIMESTAMP(3),
  "xpReward"             INTEGER NOT NULL DEFAULT 25,
  "completedAt"          TIMESTAMP(3),
  "dismissedAt"          TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById"          TEXT NOT NULL REFERENCES "User"("id"),
  "assignedToId"         TEXT NOT NULL REFERENCES "User"("id"),
  "relatedPatientId"     TEXT REFERENCES "Patient"("id"),
  "relatedAppointmentId" TEXT REFERENCES "Appointment"("id"),
  "branchId"             TEXT NOT NULL REFERENCES "Branch"("id"),
  "reminderSentAt"       TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "Todo_assignedToId_status_idx" ON "Todo"("assignedToId","status");
CREATE INDEX IF NOT EXISTS "Todo_createdById_status_idx"  ON "Todo"("createdById","status");
CREATE INDEX IF NOT EXISTS "Todo_branchId_status_idx"     ON "Todo"("branchId","status");
CREATE INDEX IF NOT EXISTS "Todo_dueDate_idx"             ON "Todo"("dueDate");
CREATE INDEX IF NOT EXISTS "Todo_status_dueDate_idx"      ON "Todo"("status","dueDate");
