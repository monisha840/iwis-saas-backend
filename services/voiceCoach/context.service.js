/**
 * VoiceCoachContextService — builds the patient-grounded context used as the
 * Claude system prompt. The shape returned by buildContext() is consumed by
 * `prompts.renderSystemPrompt()` in Phase A and by the LLM service in
 * Phase B onwards.
 *
 * Caching: the assembled context is cached in Redis under
 * `voice-coach:context:{patientId}` with a 15-minute TTL. Existing write
 * paths (daily check-in, prescription, phase task, vital) call
 * `invalidateForPatient(patientId)` to drop the stale entry. See plan §4.3.
 *
 * Note on the patientId vs userId asymmetry: `Prescription`, `DailyCheckIn`,
 * `ConstitutionProfile`, and `PatientAssignment` reference `Patient.id`,
 * while `TreatmentJourney`, `PatientVital`, and `TaskCompletion` reference
 * `User.id`. Both are resolved up front so each query picks the right one.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { cacheService } from '../cache.service.js';

const CACHE_KEY = (patientId) => `voice-coach:context:${patientId}`;
const CACHE_TTL_SECONDS = 900;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class VoiceCoachContextService {
    /**
     * Returns a fully-hydrated context object suitable for prompt rendering.
     * Hits Redis first; falls back to the parallel Prisma fetch + populates
     * the cache. The cache miss path is the bottom of every coach turn so
     * keep it lean.
     */
    static async buildContext(patientId) {
        const cached = await cacheService.get(CACHE_KEY(patientId));
        if (cached) return cached;

        const ctx = await this._fetchFresh(patientId);
        if (ctx) {
            await cacheService.set(CACHE_KEY(patientId), ctx, CACHE_TTL_SECONDS);
        }
        return ctx;
    }

    /**
     * Drop the cached context for a single patient. Call from any service
     * that mutates a model the prompt depends on (DailyCheckIn, Prescription,
     * PhaseTask completion, PatientVital, ConstitutionProfile).
     */
    static async invalidateForPatient(patientId) {
        if (!patientId) return;
        try {
            await cacheService.del(CACHE_KEY(patientId));
        } catch (err) {
            // Cache invalidation must never break the originating write.
            logger.warn('[VoiceCoachContext] invalidate failed', { patientId, error: err.message });
        }
    }

    /**
     * Same as invalidateForPatient but accepts a User.id — useful for write
     * paths that only know the userId (PatientVital, TaskCompletion). Looks
     * up the matching Patient row, then invalidates.
     */
    static async invalidateForUser(userId) {
        if (!userId) return;
        try {
            const patient = await prisma.patient.findUnique({
                where: { userId },
                select: { id: true },
            });
            if (patient) await this.invalidateForPatient(patient.id);
        } catch (err) {
            logger.warn('[VoiceCoachContext] invalidateForUser failed', { userId, error: err.message });
        }
    }

    // ── internals ───────────────────────────────────────────────────────────

    static async _fetchFresh(patientId) {
        const patient = await prisma.patient.findUnique({
            where: { id: patientId },
            select: {
                id: true,
                userId: true,
                fullName: true,
                age: true,
                preferredCoachLang: true,
                voiceCoachEnabled: true,
                zenPoints: true,
            },
        });
        if (!patient) return null;

        const userId = patient.userId;
        const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS);

        const [
            assignedDoctor,
            constitution,
            prescriptions,
            activeJourney,
            recentCheckIns,
            recentVitals,
            recentMessages,
        ] = await Promise.all([
            // PRIMARY active assignment first (preferred); fall back to any
            // ACTIVE row if no PRIMARY exists. Pulls the Doctor's display
            // fields straight through so the prompt can name them.
            prisma.patientAssignment.findFirst({
                where: { patientId, status: 'ACTIVE' },
                orderBy: [{ type: 'asc' /* PRIMARY < CONSULTING < TEMPORARY */ }, { assignedAt: 'desc' }],
                select: {
                    type: true,
                    assignedAt: true,
                    doctor: {
                        select: {
                            id: true,
                            fullName: true,
                            specialization: true,
                            qualification: true,
                            user: { select: { email: true } },
                        },
                    },
                },
            }),
            prisma.constitutionProfile.findUnique({
                where: { patientId },
                select: { prakriti: true, agniType: true, satvaRating: true },
            }),
            prisma.prescription.findMany({
                where: { patientId, discontinuedAt: null, totalQuantity: { gt: 0 } },
                select: {
                    id: true,
                    medicationName: true,
                    dosage: true,
                    frequency: true,
                    notes: true,
                    expectedEndDate: true,
                },
                orderBy: { createdAt: 'desc' },
                take: 10,
            }),
            prisma.treatmentJourney.findFirst({
                where: { patientId: userId, status: 'ACTIVE' },
                select: {
                    id: true,
                    title: true,
                    condition: true,
                    phases: {
                        orderBy: { order: 'asc' },
                        select: {
                            id: true,
                            name: true,
                            order: true,
                            status: true,
                            durationDays: true,
                            startedAt: true,
                            completedAt: true,
                            tasks: {
                                select: {
                                    id: true,
                                    type: true,
                                    title: true,
                                    description: true,
                                    frequency: true,
                                },
                            },
                        },
                    },
                },
            }),
            prisma.dailyCheckIn.findMany({
                where: { patientId, createdAt: { gte: sevenDaysAgo } },
                orderBy: { createdAt: 'desc' },
                select: {
                    createdAt: true,
                    painLevel: true,
                    sleepHours: true,
                    mood: true,
                },
                take: 7,
            }),
            prisma.patientVital.findMany({
                where: { patientId: userId },
                orderBy: { recordedAt: 'desc' },
                select: { type: true, value: true, unit: true, recordedAt: true },
                take: 3,
            }),
            // Cross-session conversation memory: last 10 turns. Descending
            // pull then reversed so the array is in chronological order for
            // the prompt.
            prisma.voiceMessage.findMany({
                where: { conversation: { patientId } },
                orderBy: { createdAt: 'desc' },
                select: { role: true, transcript: true, createdAt: true },
                take: 10,
            }),
        ]);

        const activePhase = activeJourney?.phases?.find((p) => p.status === 'ACTIVE') ?? null;
        const dayInPhase = activePhase?.startedAt
            ? Math.max(1, Math.floor((Date.now() - new Date(activePhase.startedAt).getTime()) / 86_400_000) + 1)
            : null;

        // Hard error if no active doctor assignment — patient profile is
        // incomplete and the coach can't answer "who is my doctor" honestly.
        // session.service.sendMessage catches this code and serves the
        // canned profile-incomplete reply.
        if (!assignedDoctor?.doctor) {
            logger.warn('[VoiceCoachContext] patient has no ACTIVE PatientAssignment', { patientId });
            const err = new Error('Patient profile is missing a primary doctor');
            err.code = 'PROFILE_INCOMPLETE';
            err.patientId = patientId;
            throw err;
        }

        return {
            patient,
            doctor: {
                id: assignedDoctor.doctor.id,
                fullName: assignedDoctor.doctor.fullName,
                specialization: assignedDoctor.doctor.specialization,
                qualification: assignedDoctor.doctor.qualification,
                email: assignedDoctor.doctor.user?.email,
                assignmentType: assignedDoctor.type,
                assignedAt: assignedDoctor.assignedAt,
            },
            constitution,
            prescriptions,
            activeJourney: activeJourney
                ? { id: activeJourney.id, title: activeJourney.title, condition: activeJourney.condition }
                : null,
            activePhase: activePhase
                ? { ...activePhase, dayInPhase }
                : null,
            recentCheckIns,
            recentVitals,
            recentMessages: recentMessages.reverse(),
            generatedAt: new Date().toISOString(),
        };
    }
}

export default VoiceCoachContextService;
