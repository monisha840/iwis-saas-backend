-- Add self-editable personal-detail fields to clinician models.
-- Doctor / Therapist / Pharmacist gain phoneNumber, bio, and languages[].
-- All are nullable / empty-default so existing rows remain valid.

ALTER TABLE "Doctor"     ADD COLUMN "phoneNumber" TEXT;
ALTER TABLE "Doctor"     ADD COLUMN "bio" TEXT;
ALTER TABLE "Doctor"     ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Therapist"  ADD COLUMN "phoneNumber" TEXT;
ALTER TABLE "Therapist"  ADD COLUMN "bio" TEXT;
ALTER TABLE "Therapist"  ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Pharmacist" ADD COLUMN "phoneNumber" TEXT;
ALTER TABLE "Pharmacist" ADD COLUMN "bio" TEXT;
ALTER TABLE "Pharmacist" ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
