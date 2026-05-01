-- Therapists are now categorized only by gender (MALE / FEMALE).
-- The free-text specialization column is removed; skill mix continues to live
-- in TherapistSkill rows. Doctor.specialization is intentionally untouched.

ALTER TABLE "Therapist" DROP COLUMN "specialization";

ALTER TABLE "Therapist" ADD COLUMN "gender" TEXT;
