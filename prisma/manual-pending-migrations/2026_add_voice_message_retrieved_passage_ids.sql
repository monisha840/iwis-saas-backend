-- Manual-pending migration — apply on Supabase via SQL editor when convenient.
-- Owner: requires MD (DB admin) to paste and run on the Alshifa Supabase project.
--
-- Purpose: adds an audit column to "VoiceMessage" so each assistant turn records
-- which RAG passages were retrieved and used to ground the LLM reply. Enables
-- per-turn citation audit, retrieval-quality review, and "corpus gap" detection.
--
-- Safety:
--   * Single ADD COLUMN (NULLABLE, default NULL). No data loss, no locks.
--   * Backward compatible: existing rows simply have NULL.
--   * Does not affect any current query path — the Node code continues to
--     work whether or not this column exists. After applying, follow up by
--     adding `retrievedPassageIds Json?` to the VoiceMessage model in
--     schema.prisma and wiring the write in services/voiceCoach/session.service.js
--     line ~309 (assistantMessage.create payload).
--
-- Rollback (only if needed):
--   ALTER TABLE "VoiceMessage" DROP COLUMN "retrievedPassageIds";

ALTER TABLE "VoiceMessage"
  ADD COLUMN IF NOT EXISTS "retrievedPassageIds" JSONB NULL;

COMMENT ON COLUMN "VoiceMessage"."retrievedPassageIds" IS
  'RAG audit: array of {id, score} for passages retrieved and injected into the system prompt for this turn. NULL for legacy rows and for turns where RAG was disabled or the corpus returned no matches.';
