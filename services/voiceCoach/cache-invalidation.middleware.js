/**
 * Prisma middleware that drops the Voice Coach context cache whenever a
 * model the prompt depends on changes. Lets the rest of the codebase stay
 * unaware of the coach module — no service has to remember to call
 * `invalidateForPatient` manually.
 *
 * Coverage notes
 * --------------
 * - `create / update / upsert` on the watched models flow through Prisma's
 *   middleware pipeline. We extract the patientId from the returned record.
 * - `$executeRawUnsafe` (e.g. the atomic `consumedQty++` in
 *   markMedicationTaken) bypasses middleware. The same transaction also
 *   creates a MedicationLog row via the regular Prisma client, so we hook
 *   that as a proxy and look up the patient through the prescription.
 * - `updateMany / deleteMany` return `{ count }` with no record, so we
 *   can't resolve a patient from them. The 15-minute TTL covers that gap.
 *
 * The middleware is idempotent — registered exactly once at app boot via
 * a global sentinel so HMR and repeated module loads don't stack handlers.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { VoiceCoachContextService } from './context.service.js';

const globalForVC = globalThis;

const WRITE_ACTIONS = new Set(['create', 'update', 'upsert']);

export function registerCacheInvalidationMiddleware() {
    if (globalForVC.__voiceCoachMiddlewareRegistered) return;
    globalForVC.__voiceCoachMiddlewareRegistered = true;

    prisma.$use(async (params, next) => {
        const result = await next(params);

        // Only run after a successful write on a watched model.
        if (!WRITE_ACTIONS.has(params.action)) return result;

        // Don't let cache invalidation break the originating write — every
        // path is best-effort.
        try {
            await invalidateFromWrite(params.model, result);
        } catch (err) {
            logger.warn('[VoiceCoach] cache middleware invalidation failed', {
                model: params.model,
                action: params.action,
                error: err.message,
            });
        }

        return result;
    });

    logger.info('[VoiceCoach] cache invalidation middleware registered');
}

async function invalidateFromWrite(model, result) {
    if (!result || typeof result !== 'object') return;

    switch (model) {
        // patientId on these models references Patient.id directly.
        case 'DailyCheckIn':
        case 'Prescription':
        case 'ConstitutionProfile':
        case 'PrescribedVital':
            if (result.patientId) {
                await VoiceCoachContextService.invalidateForPatient(result.patientId);
            }
            return;

        // patientId here references User.id (one of the schema's quirks —
        // see VoiceCoachContextService for the full mapping).
        case 'PatientVital':
        case 'TaskCompletion':
            if (result.patientId) {
                await VoiceCoachContextService.invalidateForUser(result.patientId);
            }
            return;

        // Proxy for the `markMedicationTaken` raw-SQL consume path. Resolve
        // the patient via the prescription.
        case 'MedicationLog':
            if (result.prescriptionId) {
                const rx = await prisma.prescription.findUnique({
                    where: { id: result.prescriptionId },
                    select: { patientId: true },
                });
                if (rx?.patientId) {
                    await VoiceCoachContextService.invalidateForPatient(rx.patientId);
                }
            }
            return;

        default:
            return;
    }
}
