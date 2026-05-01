// Rating-flow XP rewards. Separate from ClinicianXPService.awardXP because
// the spec wants flat 75 / 150 XP awards with no streak multiplier and no
// recomputation of level/title — just an immutable XPLedger entry plus a
// single boolean idempotency flag on the feedback row.
//
// Silent no-op for non-POSITIVE sentiment (NEUTRAL / NEGATIVE never reduce XP).
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';

const CONSULTATION_XP = 75;
const JOURNEY_XP      = 150;

/**
 * Disburse 75 XP to the clinician on a POSITIVE consultation feedback.
 * Idempotent via ConsultationFeedback.xpRewardClaimed; safe to call twice.
 */
export async function awardConsultationXp(feedback) {
    if (!feedback || feedback.sentiment !== 'POSITIVE') return null;
    if (feedback.xpRewardClaimed) return null;
    if (!feedback.clinicianId) {
        logger.warn('[feedbackXp] consultation feedback has no clinicianId', { id: feedback.id });
        return null;
    }

    const [ledger] = await prisma.$transaction([
        prisma.xPLedger.create({
            data: {
                userId:   feedback.clinicianId,
                action:   'POSITIVE_CONSULTATION_FEEDBACK',
                xpAmount: CONSULTATION_XP,
                sourceId: feedback.id,
                metadata: {
                    source:        'consultation_feedback',
                    appointmentId: feedback.appointmentId,
                    rating:        feedback.rating,
                    branchId:      feedback.branchId,
                },
            },
        }),
        prisma.consultationFeedback.update({
            where: { id: feedback.id },
            data:  { xpRewardClaimed: true },
        }),
    ]);

    try {
        emitToUser(feedback.clinicianId, 'xp_awarded', {
            amount: CONSULTATION_XP,
            event:  'POSITIVE_CONSULTATION_FEEDBACK',
            source: 'Patient Feedback',
        });
    } catch (err) {
        logger.warn('[feedbackXp] xp_awarded socket emit failed', { err: err.message });
    }

    return ledger;
}

/**
 * Disburse 150 XP to the primary clinician on a POSITIVE journey feedback.
 * Idempotent via JourneyFeedback.xpRewardClaimed.
 */
export async function awardJourneyXp(feedback) {
    if (!feedback || feedback.sentiment !== 'POSITIVE') return null;
    if (feedback.xpRewardClaimed) return null;
    const recipientId = feedback.primaryClinicianId || feedback.leadDoctorId;
    if (!recipientId) {
        logger.warn('[feedbackXp] journey feedback has no primary clinician', { id: feedback.id });
        return null;
    }

    const [ledger] = await prisma.$transaction([
        prisma.xPLedger.create({
            data: {
                userId:   recipientId,
                action:   'POSITIVE_JOURNEY_FEEDBACK',
                xpAmount: JOURNEY_XP,
                sourceId: feedback.id,
                metadata: {
                    source:           'journey_feedback',
                    journeyId:        feedback.journeyId,
                    overallRating:    feedback.overallRating,
                    outcomeRating:    feedback.outcomeRating,
                    adherenceRating:  feedback.adherenceRating,
                    branchId:         feedback.branchId,
                },
            },
        }),
        prisma.journeyFeedback.update({
            where: { id: feedback.id },
            data:  { xpRewardClaimed: true },
        }),
    ]);

    try {
        emitToUser(recipientId, 'xp_awarded', {
            amount: JOURNEY_XP,
            event:  'POSITIVE_JOURNEY_FEEDBACK',
            source: 'Patient Feedback',
        });
    } catch (err) {
        logger.warn('[feedbackXp] xp_awarded socket emit failed', { err: err.message });
    }

    return ledger;
}
