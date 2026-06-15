-- Compound unique so logAdherence can use a real upsert instead of the
-- racy findFirst + create/update pattern.
CREATE UNIQUE INDEX "DietAdherenceLog_dietPrescriptionId_patientId_mealTime_date_key"
  ON "DietAdherenceLog" ("dietPrescriptionId", "patientId", "mealTime", "date");
