/**
 * Voice Coach session lifecycle + per-turn orchestrator.
 *
 * Phase A scope: start, end, list, fetch, preferences.
 * Phase B adds `sendMessage()` (text-mode) — the per-turn pipeline that
 *   ties USER persistence → escalation → LLM (or safety reply) → ASSISTANT
 *   persistence → notification fan-out → cache invalidation.
 * Phase B also adds `sendDoctorNote()` — the reverse direction for the
 *   doctor's WhatsApp note action button.
 * Phase C will replace sendMessage's caller with the WS stream handler;
 *   the per-turn logic itself stays here.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { VoiceCoachContextService } from './context.service.js';
import { VoiceCoachLLMService } from './llm.service.js';
import { ExtractiveResponderService } from './extractiveResponder.js';
import { VoiceCoachEscalationService } from './escalation.service.js';
import { SAFETY_REPLY, PROFILE_INCOMPLETE_REPLY } from './prompts.js';
import { DeliveryService } from '../delivery.service.js';

const EXTRACTIVE_FLAG_KEY = 'VOICE_COACH_EXTRACTIVE_ONLY';

/**
 * Per-turn check: should this hospital use the extractive responder instead
 * of the LLM? Direct query (not via featureGate.isFeatureAvailable) because
 * the gate's fail-open behaviour for unregistered keys is the wrong default
 * here — we want to use the LLM until the flag is explicitly enabled.
 */
async function shouldUseExtractive(patientId) {
    try {
        const patient = await prisma.patient.findUnique({
            where: { id: patientId },
            select: { user: { select: { hospitalId: true } } },
        });
        const hospitalId = patient?.user?.hospitalId;
        if (!hospitalId) return false;
        const flag = await prisma.hospitalFeatureFlag.findUnique({
            where: { hospitalId_featureKey: { hospitalId, featureKey: EXTRACTIVE_FLAG_KEY } },
            select: { enabled: true },
        });
        return flag?.enabled === true;
    } catch (err) {
        // Fail closed (use LLM) on any error so a flag-lookup glitch can't
        // silently break the voice coach.
        logger.warn('[VoiceCoachSession] extractive flag lookup failed', { error: err.message });
        return false;
    }
}

export class VoiceCoachSessionService {
    static async startSession({ patientId, language }) {
        const patient = await prisma.patient.findUnique({
            where: { id: patientId },
            select: { id: true, voiceCoachEnabled: true, preferredCoachLang: true },
        });
        if (!patient) {
            const err = new Error('Patient not found');
            err.status = 404;
            throw err;
        }
        if (!patient.voiceCoachEnabled) {
            const err = new Error('Voice coach is disabled for this patient');
            err.status = 403;
            err.code = 'VOICE_COACH_DISABLED';
            throw err;
        }

        const session = await prisma.voiceConversation.create({
            data: {
                patientId,
                language: language || patient.preferredCoachLang || 'ta',
            },
            select: {
                id: true,
                patientId: true,
                language: true,
                startedAt: true,
                turnCount: true,
            },
        });
        return session;
    }

    static async endSession({ patientId, conversationId }) {
        const conversation = await prisma.voiceConversation.findUnique({
            where: { id: conversationId },
            select: { id: true, patientId: true, endedAt: true, turnCount: true },
        });
        if (!conversation || conversation.patientId !== patientId) {
            const err = new Error('Session not found');
            err.status = 404;
            throw err;
        }
        if (conversation.endedAt) return conversation;

        const updated = await prisma.voiceConversation.update({
            where: { id: conversationId },
            data: { endedAt: new Date() },
            select: {
                id: true,
                language: true,
                startedAt: true,
                endedAt: true,
                turnCount: true,
                escalated: true,
                sessionSummary: true,
            },
        });
        return updated;
    }

    static async listSessions({ patientId, take = 20, cursor }) {
        const rows = await prisma.voiceConversation.findMany({
            where: { patientId },
            orderBy: { createdAt: 'desc' },
            take: take + 1,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            select: {
                id: true,
                language: true,
                startedAt: true,
                endedAt: true,
                turnCount: true,
                escalated: true,
                sessionSummary: true,
            },
        });

        const hasMore = rows.length > take;
        const items = hasMore ? rows.slice(0, take) : rows;
        return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    }

    /**
     * Fetch a single session for a viewer who is either the patient
     * themself, or a clinician with an ACTIVE PatientAssignment to the
     * patient. The route layer sets `viewer` from the JWT.
     */
    static async getSessionForViewer({ conversationId, viewer }) {
        const conversation = await prisma.voiceConversation.findUnique({
            where: { id: conversationId },
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' },
                    select: {
                        id: true,
                        role: true,
                        transcript: true,
                        detectedIntent: true,
                        severityFlag: true,
                        createdAt: true,
                    },
                },
            },
        });
        if (!conversation) {
            const err = new Error('Session not found');
            err.status = 404;
            throw err;
        }

        const allowed = await this._canViewerRead({ patientId: conversation.patientId, viewer });
        if (!allowed) {
            const err = new Error('Forbidden');
            err.status = 403;
            throw err;
        }

        return conversation;
    }

    static async updatePreferences({ patientId, voiceCoachEnabled, preferredCoachLang }) {
        const data = {};
        if (typeof voiceCoachEnabled === 'boolean') data.voiceCoachEnabled = voiceCoachEnabled;
        if (preferredCoachLang) data.preferredCoachLang = preferredCoachLang;

        const updated = await prisma.patient.update({
            where: { id: patientId },
            data,
            select: { voiceCoachEnabled: true, preferredCoachLang: true },
        });

        // Language change is a context-relevant write — refresh the prompt.
        await VoiceCoachContextService.invalidateForPatient(patientId);
        return updated;
    }

    // ── Phase B: per-turn orchestrator ──────────────────────────────────────

    /**
     * Single coach turn: persist user input, evaluate severity, either call
     * Claude (for LOW/NONE/MEDIUM) or substitute the safety template (for
     * HIGH/CRITICAL), persist the assistant reply, fan out an escalation
     * notification when warranted, increment the session turn count, and
     * return the reply for the caller to render or speak.
     *
     * @param {Object} params
     * @param {string} params.patientId      — Patient.id of the speaker
     * @param {string} params.conversationId — VoiceConversation.id
     * @param {string} params.userTranscript — what the patient just said
     */
    static async sendMessage({ patientId, conversationId, userTranscript, languageOverride }) {
        const text = String(userTranscript || '').trim();
        // Auto-detect the language from the text itself when the caller
        // didn't pass an explicit override (typical for the text-mode
        // endpoint — the audio endpoint passes Whisper's detected language).
        // Tamil unicode → 'ta', otherwise 'en'. Tanglish is rare in typed
        // input and resolves to 'en'; patients who want Tamil replies for
        // Tanglish should use voice (Whisper transliterates Tamil sounds
        // back to Tamil unicode automatically).
        const effectiveOverride = languageOverride || detectLanguageFromText(text);
        if (!text) {
            const err = new Error('userTranscript is required');
            err.status = 400;
            throw err;
        }

        // Verify ownership + that the session is still open. We re-fetch the
        // conversation rather than trusting the route layer because the WS
        // handler will eventually call this same method.
        const conversation = await prisma.voiceConversation.findUnique({
            where: { id: conversationId },
            select: { id: true, patientId: true, endedAt: true, language: true },
        });
        if (!conversation || conversation.patientId !== patientId) {
            const err = new Error('Session not found');
            err.status = 404;
            throw err;
        }
        if (conversation.endedAt) {
            const err = new Error('Session has already ended — start a new one');
            err.status = 409;
            err.code = 'SESSION_ENDED';
            throw err;
        }

        // Severity check first. If HIGH/CRITICAL we never let the model
        // generate the response — the safety template is used instead, so
        // there's no risk of Claude accidentally giving clinical advice on a
        // dangerous turn.
        const verdict = VoiceCoachEscalationService.evaluate(text);

        // Persist USER turn now so the audit trail captures even failed turns.
        const userMessage = await prisma.voiceMessage.create({
            data: {
                conversationId,
                role: 'USER',
                transcript: text,
                detectedIntent: verdict.intent,
                severityFlag: verdict.severity === 'NONE' ? null : verdict.severity,
            },
        });

        // Generate the assistant reply. Two paths.
        let assistantText;
        let assistantMeta = {};
        let replyLanguage;
        const escalated = verdict.severity === 'HIGH' || verdict.severity === 'CRITICAL';

        if (escalated) {
            // Pick the safety reply in the language the patient just spoke,
            // falling back to their stored preference if no override.
            const patient = await prisma.patient.findUnique({
                where: { id: patientId },
                select: { id: true, userId: true, fullName: true, phoneNumber: true, branchId: true, preferredCoachLang: true },
            });
            replyLanguage =
                effectiveOverride === 'en' || effectiveOverride === 'ta'
                    ? effectiveOverride
                    : patient?.preferredCoachLang === 'en'
                    ? 'en'
                    : 'ta';
            assistantText = SAFETY_REPLY[replyLanguage];
            assistantMeta = { source: 'safety_template', skippedLLM: true };

            // Await the notification fan-out so the API response is a
            // guarantee that the doctor was actually pinged. Failures are
            // swallowed (best-effort) — we never want to block a safety
            // reply on a notification glitch. The cost is ~100ms of added
            // latency, well within the "instant" UX budget for the safety
            // template path.
            try {
                await VoiceCoachEscalationService.notifyAssignedDoctor({
                    patient,
                    conversationId,
                    severity: verdict.severity,
                    intent: verdict.intent,
                    signal: verdict.signal,
                    userTranscript: text,
                });
            } catch (err) {
                logger.warn('[VoiceCoachSession] escalation fan-out failed', {
                    error: err.message,
                });
            }
        } else {
            try {
                const useExtractive = await shouldUseExtractive(patientId);
                const responder = useExtractive
                    ? ExtractiveResponderService
                    : VoiceCoachLLMService;
                const llm = await responder.generateReply({
                    patientId,
                    userTranscript: text,
                    languageOverride: effectiveOverride,
                });
                assistantText = llm.transcript;
                replyLanguage = llm.languageUsed;
                assistantMeta = {
                    source: useExtractive ? 'extractive' : 'llm',
                    model: llm.model,
                    usage: llm.usage,
                };
            } catch (err) {
                // Profile-incomplete short-circuit: the patient has no
                // PRIMARY active doctor assignment, so context.service
                // refused to build a prompt. Serve the canned reply
                // instead of calling the LLM (which couldn't honestly
                // answer the doctor question anyway).
                if (err?.code === 'PROFILE_INCOMPLETE') {
                    const lang =
                        effectiveOverride === 'en' || effectiveOverride === 'ta'
                            ? effectiveOverride
                            : 'ta';
                    replyLanguage = lang;
                    assistantText = PROFILE_INCOMPLETE_REPLY[lang];
                    assistantMeta = { source: 'profile_incomplete', skippedLLM: true };
                } else {
                    // LLM upstream failure → fall back to a soft apology so
                    // the patient isn't left hanging.
                    logger.error('[VoiceCoachSession] LLM call failed, falling back', err, {
                        patientId,
                    });
                    assistantText =
                        "Sorry, I'm having trouble responding right now. Please try again in a moment, or reach out to your care team if it's urgent.";
                    assistantMeta = { source: 'llm_fallback', error: err.code || err.message };
                }
            }
        }

        const assistantMessage = await prisma.voiceMessage.create({
            data: {
                conversationId,
                role: 'ASSISTANT',
                transcript: assistantText,
                detectedIntent: verdict.intent,
                severityFlag: verdict.severity === 'NONE' ? null : verdict.severity,
            },
        });

        // Bump turnCount (USER + ASSISTANT counted as one turn) and mark the
        // conversation as escalated if any turn tripped the rubric.
        await prisma.voiceConversation.update({
            where: { id: conversationId },
            data: {
                turnCount: { increment: 1 },
                ...(escalated
                    ? {
                          escalated: true,
                          escalationNote: verdict.signal,
                      }
                    : {}),
            },
        });

        return {
            userMessage: {
                id: userMessage.id,
                role: 'USER',
                transcript: userMessage.transcript,
                detectedIntent: userMessage.detectedIntent,
                severityFlag: userMessage.severityFlag,
                createdAt: userMessage.createdAt,
            },
            assistantMessage: {
                id: assistantMessage.id,
                role: 'ASSISTANT',
                transcript: assistantMessage.transcript,
                createdAt: assistantMessage.createdAt,
                ...assistantMeta,
            },
            escalated,
            severity: verdict.severity,
            intent: verdict.intent,
            replyLanguage,
        };
    }

    /**
     * Doctor-initiated WhatsApp note (escalation action button "WHATSAPP_NOTE").
     * Sends the note via the existing DeliveryService (channel order
     * WHATSAPP → SMS → EMAIL with auto-fallback) and persists it as a
     * SYSTEM-role VoiceMessage so subsequent coach turns are aware the
     * doctor stepped in.
     *
     * @param {Object} params
     * @param {Object} params.viewer         — req.user (the doctor / therapist)
     * @param {string} params.conversationId — target VoiceConversation.id
     * @param {string} params.note           — the message body
     */
    static async sendDoctorNote({ viewer, conversationId, note }) {
        const text = String(note || '').trim();
        if (!text) {
            const err = new Error('note is required');
            err.status = 400;
            throw err;
        }
        if (text.length > 1000) {
            const err = new Error('note too long (max 1000 chars)');
            err.status = 400;
            throw err;
        }

        const conversation = await prisma.voiceConversation.findUnique({
            where: { id: conversationId },
            select: {
                id: true,
                patientId: true,
                patient: {
                    select: { id: true, userId: true, fullName: true, phoneNumber: true, branchId: true },
                },
            },
        });
        if (!conversation) {
            const err = new Error('Conversation not found');
            err.status = 404;
            throw err;
        }

        const allowed = await this._canViewerRead({
            patientId: conversation.patientId,
            viewer,
        });
        if (!allowed) {
            const err = new Error('Forbidden');
            err.status = 403;
            throw err;
        }

        // Resolve the doctor's display name for the templated prefix.
        let doctorName = 'Your care team';
        try {
            const doc = await prisma.doctor.findUnique({
                where: { userId: viewer.id },
                select: { fullName: true },
            });
            if (doc?.fullName) doctorName = `Dr. ${doc.fullName}`;
        } catch {
            // Best-effort — name is just for display.
        }

        const body = `${doctorName} (Al-Shifa): ${text}`;

        // Send via DeliveryService — handles channel order, fallback,
        // delivery audit log, and patient-preference gates.
        const delivery = await DeliveryService.send({
            userId: conversation.patient.userId,
            kind: 'VOICE_COACH_DOCTOR_NOTE',
            channels: ['WHATSAPP', 'SMS', 'EMAIL'],
            body,
            subject: 'Message from your Al-Shifa care team',
            inAppTitle: 'Note from your doctor',
            inAppType: 'VOICE_COACH_DOCTOR_NOTE',
        });

        // Persist as SYSTEM-role VoiceMessage so the next coach turn knows
        // the doctor said this. Stays in conversation memory.
        const persisted = await prisma.voiceMessage.create({
            data: {
                conversationId,
                role: 'SYSTEM',
                transcript: body,
                detectedIntent: 'DOCTOR_NOTE',
            },
        });

        return {
            messageId: persisted.id,
            delivery,
            sentAs: body,
        };
    }

    // ── internals ───────────────────────────────────────────────────────────

    static async _canViewerRead({ patientId, viewer }) {
        if (!viewer) return false;
        // Patient reading their own sessions (resolvePatientId puts patientId
        // on the JWT so we can compare directly).
        if (viewer.role === 'PATIENT' && viewer.patientId === patientId) return true;
        if (['ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN'].includes(viewer.role)) return true;

        if (viewer.role === 'DOCTOR' || viewer.role === 'THERAPIST') {
            // Doctor/therapist must have an ACTIVE assignment to this patient.
            // PatientAssignment.doctorId references Doctor.id; the JWT carries
            // userId, so we resolve through Doctor first.
            const doctor = await prisma.doctor.findUnique({
                where: { userId: viewer.id },
                select: { id: true },
            });
            if (!doctor) return false;
            const assignment = await prisma.patientAssignment.findFirst({
                where: { patientId, doctorId: doctor.id, status: 'ACTIVE' },
                select: { id: true },
            });
            return !!assignment;
        }
        return false;
    }
}

export default VoiceCoachSessionService;

/**
 * Detect the language of a typed message so the bot replies in kind.
 *
 *   - Tamil unicode anywhere (U+0B80–U+0BFF) → 'ta'
 *   - Otherwise → 'en'
 *
 * Limitations:
 *   - Tanglish typed in Latin script ("ennaku thalaiku vali") is detected
 *     as English. We considered a Tanglish dictionary but it's fragile and
 *     the expected user behaviour for typed input is to use the language
 *     they actually wrote in. Voice users get correct Tamil detection
 *     because Whisper transliterates the spoken Tanglish into Tamil
 *     unicode for us upstream.
 *   - Mixed messages (English + a few Tamil words) resolve to 'ta' as
 *     soon as one Tamil character appears, which is the right call for a
 *     bilingual patient who's mostly typing Tamil.
 */
function detectLanguageFromText(text) {
    if (!text) return undefined;
    return /[஀-௿]/.test(text) ? 'ta' : 'en';
}
