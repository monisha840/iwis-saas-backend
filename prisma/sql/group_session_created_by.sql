ALTER TABLE "GroupSession" ADD COLUMN IF NOT EXISTS "createdById" TEXT;
DO $$ BEGIN
    ALTER TABLE "GroupSession"
        ADD CONSTRAINT "GroupSession_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "User"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "GroupSession_createdById_idx" ON "GroupSession"("createdById");
