-- Ayurvedic Voice Health Coach (AYURVEDIC_VOICE_COACH feature)
-- New per-patient conversation log + message turns. The feature flag itself
-- already exists in FeatureRegistry; this migration only adds the data
-- surfaces.

-- 1. Enum for message author role.
CREATE TYPE "VoiceRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- 2. Patient — per-patient toggle + preferred coach language.
ALTER TABLE "Patient"
  ADD COLUMN "voiceCoachEnabled"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "preferredCoachLang" TEXT    NOT NULL DEFAULT 'ta';

-- 3. VoiceConversation — one row per coaching session.
CREATE TABLE "VoiceConversation" (
    "id"             TEXT          NOT NULL,
    "patientId"      TEXT          NOT NULL,
    "language"       TEXT          NOT NULL,
    "startedAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"        TIMESTAMP(3),
    "turnCount"      INTEGER       NOT NULL DEFAULT 0,
    "escalated"      BOOLEAN       NOT NULL DEFAULT false,
    "escalationNote" TEXT,
    "sessionSummary" TEXT,
    "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceConversation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "VoiceConversation"
    ADD CONSTRAINT "VoiceConversation_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "Patient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "VoiceConversation_patientId_createdAt_idx"
    ON "VoiceConversation"("patientId", "createdAt" DESC);
CREATE INDEX "VoiceConversation_escalated_idx"
    ON "VoiceConversation"("escalated");

-- 4. VoiceMessage — one row per turn within a conversation.
CREATE TABLE "VoiceMessage" (
    "id"              TEXT          NOT NULL,
    "conversationId"  TEXT          NOT NULL,
    "role"            "VoiceRole"   NOT NULL,
    "transcript"      TEXT          NOT NULL,
    "audioStorageKey" TEXT,
    "detectedIntent"  TEXT,
    "severityFlag"    TEXT,
    "createdAt"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceMessage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "VoiceMessage"
    ADD CONSTRAINT "VoiceMessage_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "VoiceConversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "VoiceMessage_conversationId_createdAt_idx"
    ON "VoiceMessage"("conversationId", "createdAt");
