-- Optional link from Prescription to a TreatmentPackage. Lets clinicians
-- attach a package context to the prescription so receiving pharmacists
-- and patients see the broader plan without traversing PackageEnrolment.

ALTER TABLE "Prescription"
    ADD COLUMN "packageId" TEXT;

ALTER TABLE "Prescription"
    ADD CONSTRAINT "Prescription_packageId_fkey"
    FOREIGN KEY ("packageId") REFERENCES "TreatmentPackage"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Prescription_packageId_idx" ON "Prescription"("packageId");
