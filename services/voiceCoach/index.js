/**
 * Voice Coach module — public exports.
 *
 * Anything outside `services/voiceCoach/` should import from this file, never
 * from the internal sub-files. This is the seam that lets us refactor the
 * module's internals (rename files, split classes) without ripple-edits
 * across the rest of the codebase.
 *
 * Side effect: importing this module registers the Prisma middleware that
 * keeps the patient-context cache in sync with writes to DailyCheckIn,
 * Prescription, PatientVital, TaskCompletion, ConstitutionProfile, and
 * PrescribedVital. The registration is guarded by a global sentinel so it
 * runs at most once per process.
 */

import { registerCacheInvalidationMiddleware } from './cache-invalidation.middleware.js';

registerCacheInvalidationMiddleware();

export { VoiceCoachContextService } from './context.service.js';
export { VoiceCoachSessionService } from './session.service.js';
export { VoiceCoachLLMService } from './llm.service.js';
export { ExtractiveResponderService } from './extractiveResponder.js';
export { VoiceCoachEscalationService, evaluate as evaluateSeverity } from './escalation.service.js';
export { VoiceCoachSTTService } from './stt.service.js';
export { VoiceCoachTTSService } from './tts.service.js';
export { renderSystemPrompt, SAFETY_REPLY } from './prompts.js';
export {
    startSessionSchema,
    sendMessageSchema,
    sendDoctorNoteSchema,
    updatePreferencesSchema,
    listSessionsQuerySchema,
} from './schemas.js';

export const VOICE_COACH_FEATURE_KEY = 'AYURVEDIC_VOICE_COACH';
