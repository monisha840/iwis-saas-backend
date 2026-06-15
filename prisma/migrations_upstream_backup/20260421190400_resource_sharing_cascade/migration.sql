-- Drop existing FKs and re-add them with ON DELETE CASCADE so deleting a
-- User or a Branch doesn't orphan ResourceSharing rows. All three relations
-- are non-nullable, so Cascade is the safe choice.
ALTER TABLE "ResourceSharing" DROP CONSTRAINT IF EXISTS "ResourceSharing_userId_fkey";
ALTER TABLE "ResourceSharing" DROP CONSTRAINT IF EXISTS "ResourceSharing_fromBranchId_fkey";
ALTER TABLE "ResourceSharing" DROP CONSTRAINT IF EXISTS "ResourceSharing_toBranchId_fkey";

ALTER TABLE "ResourceSharing" ADD CONSTRAINT "ResourceSharing_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceSharing" ADD CONSTRAINT "ResourceSharing_fromBranchId_fkey"
  FOREIGN KEY ("fromBranchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceSharing" ADD CONSTRAINT "ResourceSharing_toBranchId_fkey"
  FOREIGN KEY ("toBranchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
