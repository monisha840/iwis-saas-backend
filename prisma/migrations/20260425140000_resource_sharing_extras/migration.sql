-- Resource Sharing extras:
--   • endDate    — captures the true date range (existing `date` is the start)
--   • createdById — gates "creator can edit/delete their own pending request"

ALTER TABLE "ResourceSharing"
    ADD COLUMN "endDate"     TIMESTAMP(3),
    ADD COLUMN "createdById" TEXT;

CREATE INDEX "ResourceSharing_createdById_idx" ON "ResourceSharing"("createdById");
