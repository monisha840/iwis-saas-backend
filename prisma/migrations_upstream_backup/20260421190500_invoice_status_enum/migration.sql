-- Convert Invoice.status from a free string to a typed enum so application
-- code can't write stray values like "paid" (lowercase) or "VOID" (unknown).
CREATE TYPE "InvoiceStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'REFUNDED');

-- Normalize any existing non-conforming rows to UNPAID before the conversion
-- (defensive: the app only writes UNPAID/PARTIAL/PAID/REFUNDED today).
UPDATE "Invoice"
  SET "status" = 'UNPAID'
  WHERE "status" NOT IN ('UNPAID', 'PARTIAL', 'PAID', 'REFUNDED');

ALTER TABLE "Invoice"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "InvoiceStatus" USING "status"::"InvoiceStatus",
  ALTER COLUMN "status" SET DEFAULT 'UNPAID';
