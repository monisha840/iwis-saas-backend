/**
 * Ayurvedic Voice Health Coach — REST surface (Phase A).
 *
 * The WS audio stream lands at /api/voice-coach/stream and is implemented in
 * Phase C via a Socket.IO namespace registered in `websocket/index.js`. For
 * Phase A this file ships only the lifecycle + preference endpoints. The
 * text-mode message handler is added in Phase B.
 */

import express from 'express';
import multer from 'multer';
import prisma from '../lib/prisma.js';
import { authMiddleware, roleMiddleware, resolvePatientId } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireFeature } from '../utils/featureGate.js';
import logger from '../lib/logger.js';
import {
    VoiceCoachSessionService,
    VoiceCoachSTTService,
    VoiceCoachTTSService,
    startSessionSchema,
    sendMessageSchema,
    sendDoctorNoteSchema,
    updatePreferencesSchema,
    listSessionsQuerySchema,
    VOICE_COACH_FEATURE_KEY,
} from '../services/voiceCoach/index.js';

// Audio uploads stay in memory: a 10s utterance is ~80KB and we transcribe
// then drop it. No need to touch disk or persist the bytes.
const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB hard cap (~120s of opus)
});

const router = express.Router();

// Every endpoint requires a valid JWT and the AYURVEDIC_VOICE_COACH flag
// enabled for the caller's hospital. Patient role + patientId resolution is
// applied per-route since the GET-by-id endpoint is shared with clinicians.
router.use(authMiddleware);
router.use(requireFeature(VOICE_COACH_FEATURE_KEY));

// ── Patient endpoints ───────────────────────────────────────────────────────

router.post(
    '/sessions',
    roleMiddleware(['PATIENT']),
    resolvePatientId,
    validate({ body: startSessionSchema }),
    async (req, res, next) => {
        try {
            const session = await VoiceCoachSessionService.startSession({
                patientId: req.user.patientId,
                language: req.body.language,
            });
            res.status(201).json(session);
        } catch (err) {
            next(err);
        }
    },
);

router.post(
    '/sessions/:id/end',
    roleMiddleware(['PATIENT']),
    resolvePatientId,
    async (req, res, next) => {
        try {
            const session = await VoiceCoachSessionService.endSession({
                patientId: req.user.patientId,
                conversationId: req.params.id,
            });
            res.json(session);
        } catch (err) {
            next(err);
        }
    },
);

router.get(
    '/sessions',
    roleMiddleware(['PATIENT']),
    resolvePatientId,
    validate({ query: listSessionsQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await VoiceCoachSessionService.listSessions({
                patientId: req.user.patientId,
                take: req.query.take,
                cursor: req.query.cursor,
            });
            res.json(result);
        } catch (err) {
            next(err);
        }
    },
);

// Single-session read is shared with assigned clinicians. Role gating + the
// PatientAssignment check live inside the service so this route stays thin.
router.get(
    '/sessions/:id',
    roleMiddleware(['PATIENT', 'DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN']),
    async (req, res, next) => {
        try {
            // resolvePatientId is patient-only — for clinicians the service
            // does its own access check, so we only attach patientId when the
            // caller is the patient themself.
            if (req.user.role === 'PATIENT' && !req.user.patientId) {
                return resolvePatientId(req, res, () => fetchAndReturn());
            }
            return fetchAndReturn();

            async function fetchAndReturn() {
                const session = await VoiceCoachSessionService.getSessionForViewer({
                    conversationId: req.params.id,
                    viewer: req.user,
                });
                res.json(session);
            }
        } catch (err) {
            next(err);
        }
    },
);

router.patch(
    '/preferences',
    roleMiddleware(['PATIENT']),
    resolvePatientId,
    validate({ body: updatePreferencesSchema }),
    async (req, res, next) => {
        try {
            const updated = await VoiceCoachSessionService.updatePreferences({
                patientId: req.user.patientId,
                voiceCoachEnabled: req.body.voiceCoachEnabled,
                preferredCoachLang: req.body.preferredCoachLang,
            });
            res.json(updated);
        } catch (err) {
            next(err);
        }
    },
);

// ── Phase B: text-mode message + doctor-note ───────────────────────────────

// Patient sends a turn of conversation. The service handles severity scoring,
// the LLM call (or the safety bypass), persistence, and escalation fan-out.
router.post(
    '/sessions/:id/messages',
    roleMiddleware(['PATIENT']),
    resolvePatientId,
    validate({ body: sendMessageSchema }),
    async (req, res, next) => {
        try {
            const result = await VoiceCoachSessionService.sendMessage({
                patientId: req.user.patientId,
                conversationId: req.params.id,
                userTranscript: req.body.transcript,
            });
            res.status(201).json(result);
        } catch (err) {
            next(err);
        }
    },
);

// Voice turn (Phase C). Push-to-talk: client uploads a single audio blob,
// we transcribe it, run the same orchestrator as the text endpoint, and
// synthesize the assistant reply back to MP3. Audio comes back inline as
// base64 so the client can play it without a second round-trip.
router.post(
    '/sessions/:id/audio-message',
    roleMiddleware(['PATIENT']),
    resolvePatientId,
    audioUpload.single('audio'),
    async (req, res, next) => {
        try {
            if (!req.file?.buffer || req.file.buffer.length === 0) {
                return res.status(400).json({ error: 'audio file is required (multipart field "audio")' });
            }

            // 1. Whisper STT — no language hint. Whisper auto-detects
            //    Tamil vs English (vs anything else) and we propagate that
            //    detection through the rest of the turn. Forcing a language
            //    causes hallucinations when the speaker uses a different one.
            const stt = await VoiceCoachSTTService.transcribe({
                audioBuffer: req.file.buffer,
                filename: req.file.originalname || 'utterance.webm',
                mimeType: req.file.mimetype || 'audio/webm',
            });

            if (!stt.transcript) {
                return res.status(422).json({
                    error: "Couldn't make out what you said — please try again.",
                    code: 'STT_EMPTY',
                });
            }

            // 2. Run the same orchestrator the text-mode endpoint uses.
            //    The detected language overrides the patient's stored
            //    preference for this single turn so the bot replies in the
            //    language the patient just spoke.
            const turn = await VoiceCoachSessionService.sendMessage({
                patientId: req.user.patientId,
                conversationId: req.params.id,
                userTranscript: stt.transcript,
                languageOverride: stt.language ?? undefined,
            });

            // 3. TTS the assistant reply. Best-effort — if Google TTS hiccups
            //    we still return the text so the client can fall back to
            //    on-screen rendering. Voice picks the language the bot
            //    actually replied in (set by the orchestrator).
            let audio = null;
            try {
                // Reply language priority: orchestrator's reported reply
                // language → STT-detected → Tamil-script presence in the
                // assistant text → fall back to 'ta'.
                const replyLang =
                    turn.replyLanguage ||
                    stt.language ||
                    (turn.assistantMessage?.transcript?.match(/[஀-௿]/) ? 'ta' : 'en');
                const tts = await VoiceCoachTTSService.synthesize({
                    text: turn.assistantMessage.transcript,
                    language: replyLang,
                });
                audio = {
                    base64: tts.audioBase64,
                    mimeType: tts.mimeType,
                    voice: tts.voice.name,
                    durationMs: tts.durationMs,
                };
            } catch (err) {
                logger.warn('[VoiceCoach] TTS failed, returning text-only', { error: err.message });
            }

            res.status(201).json({
                ...turn,
                stt: { language: stt.language, durationMs: stt.durationMs },
                audio,
            });
        } catch (err) {
            next(err);
        }
    },
);

// Doctor / therapist sends a templated WhatsApp note in response to an
// escalation. Goes out through DeliveryService (WA → SMS → Email fallback)
// and persists as a SYSTEM-role VoiceMessage.
router.post(
    '/sessions/:id/notify-patient',
    roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR', 'ADMIN', 'SUPER_ADMIN']),
    validate({ body: sendDoctorNoteSchema }),
    async (req, res, next) => {
        try {
            const result = await VoiceCoachSessionService.sendDoctorNote({
                viewer: req.user,
                conversationId: req.params.id,
                note: req.body.note,
            });
            res.status(201).json(result);
        } catch (err) {
            next(err);
        }
    },
);

// ── Phase C/D placeholders ──────────────────────────────────────────────────

router.all('/stream', (_req, res) => {
    // Phase C will replace this with a Socket.IO namespace handshake; for
    // now any HTTP hit on the bare path is rejected so it shows up clearly
    // in logs as "not yet wired" rather than 404.
    res.status(501).json({
        error: 'Audio streaming arrives in Phase C — connect via Socket.IO namespace /voice-coach',
    });
});

router.get('/analytics', roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']), (_req, res) => {
    res.status(501).json({ error: 'Coach analytics lands in Phase D' });
});

export default router;
