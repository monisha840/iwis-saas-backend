-- Extend Medicine with CSV import fields
ALTER TABLE "Medicine"
    ADD COLUMN "hsn"                 TEXT,
    ADD COLUMN "pharmacologicalName" TEXT,
    ADD COLUMN "riskLevel"           TEXT,
    ADD COLUMN "maxSalesDiscount"    DOUBLE PRECISION,
    ADD COLUMN "tax"                 DOUBLE PRECISION,
    ADD COLUMN "purchaseUnit"        TEXT,
    ADD COLUMN "qtyPerPurchaseUnit"  INTEGER;

-- Extend MedicineStock with per-batch purchase price
ALTER TABLE "MedicineStock"
    ADD COLUMN "purchasePrice" DOUBLE PRECISION;
