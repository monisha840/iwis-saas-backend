// Express router for the voice-note refine endpoint.
//
//   POST /api/voice-note/refine
//   Body: { transcript: string, language: 'en' | 'ta' | 'mixed' }
//   200:  { success: true, refinedTranscript: string, structured: ParsedVoiceNote }
//   400:  { success: false, error: string }     // validation failure
//   502:  { success: false, error: string }     // LLM upstream failure
//
// The router itself is intentionally bare. The README shows how to wrap it
// with `authMiddleware`, `roleMiddleware`, and `requireFeature(...)` at
// mount time inside Alshifa, so this file stays portable across hosts.

import express from 'express';
import { refineTranscript } from './refine.service.js';

// Bound transcript size so a runaway dictation can't blow LLM cost or
// trigger a token-limit error. 5000 chars ≈ 5 minutes of dictation, which
// is more than any realistic prescription needs.
const MAX_TRANSCRIPT_CHARS = 5000;
const VALID_LANGUAGES = new Set(['en', 'ta', 'mixed']);

const router = express.Router();

router.post('/refine', async (req, res) => {
  try {
    const { transcript, language } = req.body ?? {};

    if (typeof transcript !== 'string' || transcript.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'transcript is required and must be a non-empty string',
      });
    }
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      return res.status(400).json({
        success: false,
        error: `transcript exceeds the ${MAX_TRANSCRIPT_CHARS}-character cap`,
      });
    }
    const lang = VALID_LANGUAGES.has(language) ? language : 'en';

    const { refinedTranscript, structured } = await refineTranscript(transcript, lang);
    return res.json({ success: true, refinedTranscript, structured });
  } catch (err) {
    // Distinguish "we know the LLM failed" from "we got an unexpected error".
    // 502 Bad Gateway is the right code for upstream failures so the client
    // can show "service temporarily unavailable" rather than blaming the user.
    const message = err && err.message ? err.message : 'Refine failed';
    const status = /not implemented|api|upstream|fetch/i.test(message) ? 502 : 500;
    return res.status(status).json({ success: false, error: message });
  }
});

export default router;
