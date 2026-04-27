/**
 * JourneyFeedbackService — 7-stage end-of-journey feedback flow.
 *
 * Trigger:  TreatmentJourney.status flips to COMPLETED (see journey.service.js
 *           completeJourney() / activateNextPhase()) → service.initFromJourney()
 *           creates a pending JourneyFeedback row with a 30-day expiresAt.
 * Read:     getAvailableForUser(userId) — called on every patient app open.
 *           Returns the single most recent un-submitted, non-expired prompt.
 * Write:    submit(userId, journeyId, body) — single, final submission. XP is
 *           computed server-side from the response values; the client does not
 *           send it. Awards up to 7 XP distributed across lead doctor +
 *           qualifying co-treaters (5+ therapy sessions OR 3+ appointments
 *           on this journey, 70% lead / 30% co-treater split). Thank-you card
 *           XP is always 100% to the lead doctor.
 *
 * Closest analog: ConsultationFeedbackService — same submit-once + XP-server-side
 * shape, but spans an entire journey rather than a single appointment, and adds
 * the ThankYouCard side-effect with Socket-IO `letter_received` fan-out.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ClinicianXPService } from './clinicianXP.service.js';
import { notificationService } from './notification.service.js';
import { emitToUser } from '../websocket/index.js';

// Spec: feedback remains available for 30 days after journey completion.
const FEEDBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Spec: if app not opened within 72 hours, send one reminder push.
const REMINDER_AFTER_MS = 72 * 60 * 60 * 1000;

// MCQ: A or B award +1 XP each.
const POSITIVE_MCQ_OPTIONS = new Set(['A', 'B']);
// Garden ladder positive threshold (score 1/3/5/7/10 — Small plant or above).
const POSITIVE_GARDEN_THRESHOLD = 5;
// Face-of-care positive threshold (1-5 — "really looked after" or above).
const POSITIVE_FACE_THRESHOLD = 4;
// Thank-you card XP eligibility — anything longer than 10 chars after trim.
const MIN_THANK_YOU_LENGTH = 11;

// Co-treater attribution thresholds (spec: 5+ therapy sessions OR 3+ appointments).
const COTREATER_MIN_THERAPY_SESSIONS = 5;
const COTREATER_MIN_APPOINTMENTS     = 3;
const LEAD_DOCTOR_SHARE              = 0.70;

// Hard cap on the thank-you card text. UI also enforces this; backend is
// authoritative.
const THANK_YOU_CARD_MAX_CHARS = 2000;

// Garden levels: the spec uses Seed/Sprout/Small plant/Bush/Tree mapped to
// 1/3/5/7/10. Any other value is rejected (returned as null on the client
// would translate to "skipped").
const ALLOWED_GARDEN_SCORES = new Set([1, 3, 5, 7, 10]);

/**
 * Compute the per-question XP grading. Each return value is a 0/1 indicator;
 * the caller sums them. Pure function, easy to unit-test.
 */
export function gradeJourneyResponses({
    mcqAppointments,
    mcqReminders,
    mcqMedications,
    mcqFamilyRecommendation,
    gardenScore,
    faceScaleExperience,
    thankYouCardText,
}) {
    const mcq1 = mcqAppointments         && POSITIVE_MCQ_OPTIONS.has(mcqAppointments)         ? 1 : 0;
    const mcq2 = mcqReminders            && POSITIVE_MCQ_OPTIONS.has(mcqReminders)            ? 1 : 0;
    const mcq3 = mcqMedications          && POSITIVE_MCQ_OPTIONS.has(mcqMedications)          ? 1 : 0;
    const mcq4 = mcqFamilyRecommendation && POSITIVE_MCQ_OPTIONS.has(mcqFamilyRecommendation) ? 1 : 0;
    const garden = Number.isInteger(gardenScore)        && gardenScore        >= POSITIVE_GARDEN_THRESHOLD ? 1 : 0;
    const face   = Number.isInteger(faceScaleExperience) && faceScaleExperience >= POSITIVE_FACE_THRESHOLD ? 1 : 0;
    // Spec: thank-you card XP awards if message > 10 characters (i.e. >= 11).
    const cardLen = typeof thankYouCardText === 'string' ? thankYouCardText.trim().length : 0;
    const card = cardLen >= MIN_THANK_YOU_LENGTH ? 1 : 0;

    return {
        mcqAppointments:        mcq1,
        mcqReminders:           mcq2,
        mcqMedications:         mcq3,
        mcqFamilyRecommendation: mcq4,
        gardenScore:            garden,
        faceScaleExperience:    face,
        thankYouCard:           card,
        total:                  mcq1 + mcq2 + mcq3 + mcq4 + garden + face + card,
    };
}

/**
 * Build the XP distribution map across lead doctor + qualifying co-treaters.
 *
 * Rules (spec):
 *   - All XP defaults to lead doctor.
 *   - A co-treater qualifies if they had 5+ therapy sessions OR 3+ appointments
 *     on this journey.
 *   - When ≥1 co-treater qualifies: lead = 70% (rounded down), co-treaters
 *     share remaining 30% by appointment count.
 *   - Thank-you card XP always 100% to lead doctor regardless of co-treaters.
 *
 * `coTreaterTallies` is an array of `{ userId, role, appointmentCount, therapyCount }`
 * computed by the caller from Appointment rows linked to this journey. The
 * lead doctor is excluded from this list (caller responsibility).
 *
 * Returns: `{ leadDoctorId, leadDoctorXp, leadDoctorBaseXp, leadDoctorCardXp,
 *             coTreaters: [{ userId, role, xp, share }], totalDistributed }`
 */
export function buildXpDistribution({
    leadDoctorId,
    nonCardXp,        // 0-6  (everything except the thank-you card bonus)
    cardXp,           // 0-1  (always 100% to lead)
    coTreaterTallies = [],
}) {
    const qualifyingCoTreaters = coTreaterTallies.filter(
        (c) =>
            c.userId !== leadDoctorId &&
            (c.therapyCount >= COTREATER_MIN_THERAPY_SESSIONS ||
                c.appointmentCount >= COTREATER_MIN_APPOINTMENTS),
    );

    if (qualifyingCoTreaters.length === 0 || nonCardXp === 0) {
        // Lead doctor takes 100% of non-card + 100% of card.
        const total = nonCardXp + cardXp;
        return {
            leadDoctorId,
            leadDoctorXp:      total,
            leadDoctorBaseXp:  nonCardXp,
            leadDoctorCardXp:  cardXp,
            coTreaters:        [],
            totalDistributed:  total,
        };
    }

    const leadShare      = Math.floor(nonCardXp * LEAD_DOCTOR_SHARE);
    const coTreaterShare = nonCardXp - leadShare;

    const totalCoTreaterAppointments = qualifyingCoTreaters.reduce(
        (s, c) => s + c.appointmentCount, 0,
    );

    const coTreaters = [];
    let allocated = 0;
    for (let i = 0; i < qualifyingCoTreaters.length; i += 1) {
        const c = qualifyingCoTreaters[i];
        // Last co-treater absorbs any rounding remainder so total stays exact.
        const isLast = i === qualifyingCoTreaters.length - 1;
        const share = totalCoTreaterAppointments > 0
            ? c.appointmentCount / totalCoTreaterAppointments
            : 1 / qualifyingCoTreaters.length;
        const xp = isLast
            ? coTreaterShare - allocated
            : Math.floor(coTreaterShare * share);
        allocated += xp;
        coTreaters.push({ userId: c.userId, role: c.role, xp, share: Number(share.toFixed(3)) });
    }

    const total = leadShare + cardXp + coTreaters.reduce((s, c) => s + c.xp, 0);

    return {
        leadDoctorId,
        leadDoctorXp:     leadShare + cardXp,
        leadDoctorBaseXp: leadShare,
        leadDoctorCardXp: cardXp,
        coTreaters,
        totalDistributed: total,
    };
}

export class JourneyFeedbackService {
    /**
     * Idempotent: create a pending JourneyFeedback row when a journey
     * transitions to COMPLETED. Safe to call multiple times — the unique
     * journeyId means the second call hits the upsert no-op branch.
     *
     * Returns the feedback row (or null if the journey is missing).
     */
    static async initFromJourney(journeyId) {
        const journey = await prisma.treatmentJourney.findUnique({
            where: { id: journeyId },
            select: {
                id: true,
                patientId: true,
                doctorId: true,
                branchId: true,
                title: true,
                doctor: { select: { fullName: true } },
            },
        });
        if (!journey) {
            logger.warn(`[JourneyFeedback] initFromJourney: journey ${journeyId} not found`);
            return null;
        }

        const expiresAt = new Date(Date.now() + FEEDBACK_WINDOW_MS);

        const feedback = await prisma.journeyFeedback.upsert({
            where:  { journeyId: journey.id },
            create: {
                journeyId:    journey.id,
                patientId:    journey.patientId,
                leadDoctorId: journey.doctorId,
                branchId:     journey.branchId ?? null,
                expiresAt,
            },
            update: {}, // already exists — leave untouched
        });

        return feedback;
    }

    /**
     * Called on every patient app open. Returns:
     *   { available: true, journey_id, expires_at, lead_doctor: {...}, has_photos: bool }
     *   { available: false, journey_id: null, expires_at: null }
     *
     * "Available" means: there's a JourneyFeedback row for this patient that
     * has NOT been submitted yet AND has not expired (within 30-day window).
     * Returns the single most recently created pending row.
     */
    static async getAvailableForUser(userId) {
        const now = new Date();

        const feedback = await prisma.journeyFeedback.findFirst({
            where: {
                patientId:   userId,
                completedAt: null,
                expiresAt:   { gt: now },
            },
            orderBy: { createdAt: 'desc' },
            select: {
                id:           true,
                journeyId:    true,
                expiresAt:    true,
                photosViewed: true,
                leadDoctor:   { select: { id: true, fullName: true } },
                journey: {
                    select: {
                        id: true,
                        title: true,
                        condition: true,
                        clinicalPhotos: { select: { id: true, stage: true } },
                    },
                },
            },
        });

        if (!feedback) {
            return { available: false, journey_id: null, expires_at: null };
        }

        // Photos shown only when both an early (BEFORE) AND a late (DURING/AFTER)
        // photo exist on record. Spec: "show only if patient has both an early
        // -journey AND a late/during-journey clinical photo on record".
        const photos = feedback.journey?.clinicalPhotos ?? [];
        const hasBefore = photos.some((p) => p.stage === 'BEFORE');
        const hasLate   = photos.some((p) => p.stage === 'DURING' || p.stage === 'AFTER');
        const hasPhotos = hasBefore && hasLate;

        return {
            available:  true,
            journey_id: feedback.journeyId,
            expires_at: feedback.expiresAt,
            lead_doctor: {
                id:   feedback.leadDoctor?.id,
                name: feedback.leadDoctor?.fullName || 'your doctor',
            },
            journey_title: feedback.journey?.title || null,
            has_photos:    hasPhotos,
        };
    }

    /**
     * Get the before/after photo bundle for a journey. Returns at most one
     * BEFORE and one DURING/AFTER photo (whichever was taken latest in each
     * group), with date metadata only — no captions, no evaluative wording.
     * Spec: "two photos side by side, dates below each. No evaluative
     * language."
     */
    static async getPhotosForJourney(journeyId) {
        const photos = await prisma.clinicalPhoto.findMany({
            where: { journeyId },
            orderBy: { takenAt: 'asc' },
            select: { id: true, stage: true, filePath: true, takenAt: true, bodyRegion: true },
        });
        if (photos.length === 0) return null;

        const before = photos.find((p) => p.stage === 'BEFORE') || null;
        // Late = the most recent DURING/AFTER (prefer AFTER if present).
        const lateCandidates = photos.filter((p) => p.stage === 'AFTER' || p.stage === 'DURING');
        const late = lateCandidates.length > 0
            ? lateCandidates[lateCandidates.length - 1]
            : null;

        if (!before || !late) return null;

        return { before, late };
    }

    /**
     * Single, final submission. Idempotent on `completedAt`: any further
     * submission attempt for the same journey returns 410 (gone).
     */
    static async submit(userId, journeyId, body) {
        const feedback = await prisma.journeyFeedback.findUnique({
            where: { journeyId },
            select: {
                id: true, patientId: true, leadDoctorId: true, branchId: true,
                completedAt: true, expiresAt: true,
                journey: { select: { id: true, doctor: { select: { fullName: true } } } },
            },
        });

        if (!feedback) {
            const err = new Error('No feedback record found for this journey');
            err.status = 404;
            throw err;
        }
        if (feedback.patientId !== userId) {
            const err = new Error('Access denied');
            err.status = 403;
            throw err;
        }
        if (feedback.completedAt) {
            const err = new Error('This feedback has already been submitted');
            err.status = 410;
            throw err;
        }
        if (feedback.expiresAt.getTime() <= Date.now()) {
            const err = new Error('The feedback window for this journey has closed');
            err.status = 410;
            throw err;
        }

        // Normalise inputs — every stage except 1 and 7 is individually skippable.
        const responses = {
            mcqAppointments:         body.mcq_appointments         || null,
            mcqReminders:            body.mcq_reminders            || null,
            mcqMedications:          body.mcq_medications          || null,
            mcqFamilyRecommendation: body.mcq_family_recommendation || null,
            gardenScore:             Number.isInteger(body.garden_score)         && ALLOWED_GARDEN_SCORES.has(body.garden_score) ? body.garden_score : null,
            faceScaleExperience:     Number.isInteger(body.face_scale_experience) && body.face_scale_experience >= 1 && body.face_scale_experience <= 5 ? body.face_scale_experience : null,
            thankYouCardText:        typeof body.thank_you_card_text === 'string'
                ? body.thank_you_card_text.trim().slice(0, THANK_YOU_CARD_MAX_CHARS)
                : null,
            thankYouCardPublic:      Boolean(body.thank_you_card_public),
            photosViewed:            Boolean(body.photos_viewed),
        };

        // Empty thank-you card with the public toggle set should be treated as
        // no card — never persist a public empty card.
        if (!responses.thankYouCardText) {
            responses.thankYouCardPublic = false;
        }

        const grading = gradeJourneyResponses(responses);
        const cardXp     = grading.thankYouCard;
        const nonCardXp  = grading.total - cardXp;

        // Co-treater tallies — count appointments per assigned clinician on
        // this journey (excluding the lead doctor).
        const coTreaterTallies = await this._buildCoTreaterTallies(feedback.journey.id, feedback.leadDoctorId);

        const distribution = buildXpDistribution({
            leadDoctorId: feedback.leadDoctorId,
            nonCardXp,
            cardXp,
            coTreaterTallies,
        });

        // Persist the submission + optional thank-you card in a single tx so a
        // partial write never leaves an orphan card behind.
        const completedAt = new Date();
        let thankYouCardDelivered = false;

        const updated = await prisma.$transaction(async (tx) => {
            const row = await tx.journeyFeedback.update({
                where: { id: feedback.id },
                data: {
                    mcqAppointments:         responses.mcqAppointments,
                    mcqReminders:            responses.mcqReminders,
                    mcqMedications:          responses.mcqMedications,
                    mcqFamilyRecommendation: responses.mcqFamilyRecommendation,
                    gardenScore:             responses.gardenScore,
                    faceScaleExperience:     responses.faceScaleExperience,
                    thankYouCardText:        responses.thankYouCardText,
                    thankYouCardPublic:      responses.thankYouCardPublic,
                    photosViewed:            responses.photosViewed,
                    xpAwarded:               distribution.totalDistributed,
                    xpDistribution:          distribution,
                    completedAt,
                },
            });

            if (responses.thankYouCardText) {
                await tx.thankYouCard.create({
                    data: {
                        feedbackId:        row.id,
                        recipientDoctorId: feedback.leadDoctorId,
                        content:           responses.thankYouCardText,
                        visibility:        responses.thankYouCardPublic ? 'PUBLIC' : 'PRIVATE',
                    },
                });
                thankYouCardDelivered = true;
            }

            return row;
        });

        // Award XP outside the tx — XP write failure must not roll back the
        // patient's submission. Lead doctor first, then each co-treater.
        if (distribution.leadDoctorXp > 0) {
            try {
                await ClinicianXPService.awardXP(
                    feedback.leadDoctorId,
                    'JOURNEY_FEEDBACK',
                    distribution.leadDoctorXp,
                    updated.id,
                    {
                        source:           'journey_feedback',
                        journeyId,
                        coTreaters:       distribution.coTreaters.length,
                        cardXp,
                        baseXpFromResponses: nonCardXp,
                    },
                );
            } catch (err) {
                logger.error('[JourneyFeedback] XP award (lead) failed', {
                    feedbackId: updated.id, leadDoctorId: feedback.leadDoctorId, err: err.message,
                });
            }
        }

        for (const co of distribution.coTreaters) {
            if (co.xp <= 0) continue;
            try {
                await ClinicianXPService.awardXP(
                    co.userId,
                    'JOURNEY_FEEDBACK_COTREATER',
                    co.xp,
                    updated.id,
                    {
                        source:        'journey_feedback',
                        journeyId,
                        share:         co.share,
                        leadDoctorId:  feedback.leadDoctorId,
                    },
                );
            } catch (err) {
                logger.error('[JourneyFeedback] XP award (co-treater) failed', {
                    feedbackId: updated.id, coTreaterId: co.userId, err: err.message,
                });
            }
        }

        // Real-time recognition signal to the lead doctor when a thank-you
        // card was submitted. Best-effort — submission is the user's source of
        // truth; the socket emit is for live UI only.
        if (thankYouCardDelivered) {
            try {
                emitToUser(feedback.leadDoctorId, 'letter_received', {
                    feedbackId:  updated.id,
                    journeyId,
                    visibility:  responses.thankYouCardPublic ? 'PUBLIC' : 'PRIVATE',
                    excerpt:     responses.thankYouCardText.slice(0, 140),
                    receivedAt:  completedAt,
                });
            } catch (err) {
                logger.warn('[JourneyFeedback] letter_received emit failed', { err: err.message });
            }
        }

        logger.info('[JourneyFeedback] Submitted', {
            journeyId,
            xpAwarded:       distribution.totalDistributed,
            coTreaterCount:  distribution.coTreaters.length,
            cardDelivered:   thankYouCardDelivered,
        });

        return {
            xp_awarded:              distribution.totalDistributed,
            xp_distribution:         distribution,
            thank_you_card_delivered: thankYouCardDelivered,
        };
    }

    /**
     * Scheduler hook: 72h push reminder for any pending JourneyFeedback the
     * patient hasn't engaged with. Idempotent via `reminderSentAt` stamp.
     */
    static async sendRemindersForPending() {
        const now = Date.now();
        const reminderCutoff = new Date(now - REMINDER_AFTER_MS);
        const expiryGuard    = new Date(now); // expiresAt must still be in the future

        const candidates = await prisma.journeyFeedback.findMany({
            where: {
                completedAt:    null,
                reminderSentAt: null,
                createdAt:      { lte: reminderCutoff },
                expiresAt:      { gt: expiryGuard },
            },
            select: {
                id:           true,
                patientId:    true,
                leadDoctorId: true,
                leadDoctor:   { select: { fullName: true } },
                journey:      { select: { title: true } },
            },
        });

        let sent = 0;
        for (const c of candidates) {
            // CAS-claim the reminder slot first to avoid double-fire across
            // overlapping cron runs.
            const claimed = await prisma.journeyFeedback.updateMany({
                where: { id: c.id, reminderSentAt: null },
                data:  { reminderSentAt: new Date() },
            });
            if (claimed.count === 0) continue;

            const doctorName = c.leadDoctor?.fullName || 'your doctor';
            try {
                await notificationService.createNotification({
                    userId:   c.patientId,
                    type:     'JOURNEY_FEEDBACK_REMINDER',
                    title:    'Your treatment journey is complete',
                    message:  `Share a quick reflection on your time with ${doctorName} — under two minutes.`,
                    priority: 'LOW',
                    data:     { journeyId: c.journey ? undefined : null, feedbackId: c.id, kind: 'journey_feedback_reminder' },
                });
                sent += 1;
            } catch (err) {
                logger.error('[JourneyFeedback] reminder notification failed', {
                    feedbackId: c.id, err: err.message,
                });
            }
        }

        if (sent > 0) {
            logger.info(`[JourneyFeedback] Sent ${sent} 72h feedback reminders`);
        }
        return sent;
    }

    /**
     * Doctor recognition panel — last 7 days of PUBLIC thank-you cards
     * addressed to the calling doctor. PRIVATE cards are deliberately
     * excluded; they're surfaced through `getPrivateCardsForDoctor` below
     * (a separate, opt-in surface).
     */
    static async getRecognitionForDoctor(doctorUserId, { sinceDays = 7 } = {}) {
        const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

        const cards = await prisma.thankYouCard.findMany({
            where: {
                recipientDoctorId: doctorUserId,
                visibility:        'PUBLIC',
                createdAt:         { gte: since },
            },
            orderBy: { createdAt: 'desc' },
            select: {
                id:        true,
                content:   true,
                createdAt: true,
                feedback:  {
                    select: {
                        journey: { select: { id: true, title: true, condition: true } },
                    },
                },
            },
        });

        return cards.map((c) => ({
            id:           c.id,
            content:      c.content,
            createdAt:    c.createdAt,
            journeyTitle: c.feedback?.journey?.title || null,
            condition:    c.feedback?.journey?.condition || null,
        }));
    }

    /**
     * Doctor's full set of received thank-you cards (private + public). Used
     * by the doctor's personal "letters" inbox — never aggregated into a
     * public surface.
     */
    static async getPrivateCardsForDoctor(doctorUserId, { take = 20 } = {}) {
        return prisma.thankYouCard.findMany({
            where:   { recipientDoctorId: doctorUserId },
            orderBy: { createdAt: 'desc' },
            take,
            select: {
                id:        true,
                content:   true,
                visibility: true,
                createdAt: true,
                feedback:  {
                    select: {
                        journey: { select: { id: true, title: true } },
                    },
                },
            },
        });
    }

    // ─── internal ────────────────────────────────────────────────────────────

    /**
     * Count appointments per non-lead clinician for a journey. Looks at both
     * `doctorId` and `therapistId` columns since a clinician could appear in
     * either role on different appointments. Counts THERAPIST-typed
     * appointments separately to evaluate the "5+ therapy sessions" rule.
     *
     * Returns: array of `{ userId, role, appointmentCount, therapyCount }`,
     * excluding the lead doctor.
     */
    static async _buildCoTreaterTallies(journeyId, leadDoctorUserId) {
        const appts = await prisma.appointment.findMany({
            where: { journeyId },
            select: {
                consultationType: true,
                doctor:    { select: { userId: true, user: { select: { role: true } } } },
                therapist: { select: { userId: true, user: { select: { role: true } } } },
            },
        });

        // Accumulator: userId → { role, appointmentCount, therapyCount }
        const tallies = new Map();

        for (const a of appts) {
            const isTherapyType = a.consultationType === 'THERAPIST';

            if (a.doctor?.userId && a.doctor.userId !== leadDoctorUserId) {
                const t = tallies.get(a.doctor.userId) || {
                    userId:           a.doctor.userId,
                    role:             a.doctor.user?.role || 'DOCTOR',
                    appointmentCount: 0,
                    therapyCount:     0,
                };
                t.appointmentCount += 1;
                tallies.set(a.doctor.userId, t);
            }

            if (a.therapist?.userId && a.therapist.userId !== leadDoctorUserId) {
                const t = tallies.get(a.therapist.userId) || {
                    userId:           a.therapist.userId,
                    role:             a.therapist.user?.role || 'THERAPIST',
                    appointmentCount: 0,
                    therapyCount:     0,
                };
                t.appointmentCount += 1;
                if (isTherapyType) t.therapyCount += 1;
                tallies.set(a.therapist.userId, t);
            }
        }

        return Array.from(tallies.values());
    }
}

export const JOURNEY_FEEDBACK_CONSTANTS = {
    FEEDBACK_WINDOW_MS,
    REMINDER_AFTER_MS,
    POSITIVE_MCQ_OPTIONS,
    POSITIVE_GARDEN_THRESHOLD,
    POSITIVE_FACE_THRESHOLD,
    MIN_THANK_YOU_LENGTH,
    COTREATER_MIN_THERAPY_SESSIONS,
    COTREATER_MIN_APPOINTMENTS,
    LEAD_DOCTOR_SHARE,
    THANK_YOU_CARD_MAX_CHARS,
    ALLOWED_GARDEN_SCORES,
};
