-- Staff messaging (DMs + branch group chats) — separate domain from
-- patient-clinician Conversation table so the polymorphic thread shape
-- (1-on-1 vs. multi-member group) doesn't pollute existing chat code.

CREATE TYPE "StaffThreadKind" AS ENUM ('DIRECT', 'GROUP');
CREATE TYPE "StaffThreadMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "StaffMessageKind" AS ENUM ('TEXT', 'SYSTEM');

CREATE TABLE "StaffThread" (
    "id"          TEXT NOT NULL,
    "kind"        "StaffThreadKind" NOT NULL,
    "title"       TEXT,
    "hospitalId"  TEXT NOT NULL,
    "branchId"    TEXT,
    "directKey"   TEXT,
    "createdById" TEXT NOT NULL,
    "archivedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffThread_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffThread_directKey_key" ON "StaffThread"("directKey");
CREATE INDEX "StaffThread_hospitalId_idx"   ON "StaffThread"("hospitalId");
CREATE INDEX "StaffThread_branchId_idx"     ON "StaffThread"("branchId");
CREATE INDEX "StaffThread_kind_idx"         ON "StaffThread"("kind");
CREATE INDEX "StaffThread_updatedAt_idx"    ON "StaffThread"("updatedAt");

ALTER TABLE "StaffThread"
  ADD CONSTRAINT "StaffThread_hospitalId_fkey"  FOREIGN KEY ("hospitalId")  REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StaffThread_branchId_fkey"    FOREIGN KEY ("branchId")    REFERENCES "Branch"("id")   ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "StaffThread_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id")     ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StaffThreadMember" (
    "id"             TEXT NOT NULL,
    "threadId"       TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "role"           "StaffThreadMemberRole" NOT NULL DEFAULT 'MEMBER',
    "isAutoIncluded" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt"     TIMESTAMP(3),
    "removedAt"      TIMESTAMP(3),
    "addedById"      TEXT,

    CONSTRAINT "StaffThreadMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffThreadMember_threadId_userId_key" ON "StaffThreadMember"("threadId", "userId");
CREATE INDEX "StaffThreadMember_userId_removedAt_idx"   ON "StaffThreadMember"("userId", "removedAt");
CREATE INDEX "StaffThreadMember_threadId_removedAt_idx" ON "StaffThreadMember"("threadId", "removedAt");

ALTER TABLE "StaffThreadMember"
  ADD CONSTRAINT "StaffThreadMember_threadId_fkey"  FOREIGN KEY ("threadId")  REFERENCES "StaffThread"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "StaffThreadMember_userId_fkey"    FOREIGN KEY ("userId")    REFERENCES "User"("id")        ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StaffThreadMember_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id")        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "StaffMessage" (
    "id"        TEXT NOT NULL,
    "threadId"  TEXT NOT NULL,
    "senderId"  TEXT,
    "kind"      "StaffMessageKind" NOT NULL DEFAULT 'TEXT',
    "content"   TEXT NOT NULL,
    "editedAt"  TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StaffMessage_threadId_createdAt_idx" ON "StaffMessage"("threadId", "createdAt");

ALTER TABLE "StaffMessage"
  ADD CONSTRAINT "StaffMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "StaffThread"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "StaffMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id")        ON DELETE SET NULL ON UPDATE CASCADE;
