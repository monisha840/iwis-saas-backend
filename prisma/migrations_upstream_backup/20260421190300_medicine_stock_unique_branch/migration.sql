-- Add compound unique on MedicineStock so stock-transfer receipts can upsert
-- instead of blindly creating a new row for every received transfer. The
-- unique is over (medicineId, branchId, batchNumber) to preserve the batch
-- model (multiple batches per medicine+branch are still allowed as long as
-- their batchNumbers differ).
CREATE UNIQUE INDEX "MedicineStock_medicineId_branchId_batchNumber_key"
  ON "MedicineStock" ("medicineId", "branchId", "batchNumber");
