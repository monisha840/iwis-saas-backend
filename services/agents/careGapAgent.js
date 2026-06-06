/**
 * F07 · careGapAgent — first wave on triage.critical.submitted.
 *
 * Spec asked for a CareGap row, but IWIS has no CareGap table — the
 * `/api/care-gaps` endpoint computes gaps on the fly. The IWIS-native
 * "watch this patient" surface is PatientCriticalFlag (upsert by patientId,
 * carries severity + reasons JSON). That's where this agent writes so the
 * existing Critical Journey queue + Patients-at-Risk tile pick the patient
 * up immediately.
 *
 * Outputs (best effort, never throws):
 *   • Upsert PatientCriticalFlag with reason {type:'CRITICAL_TRIAGE', …}
 *   • Enqueue an in-app notification to the assigned doctor so they see
 *     it on their dashboard before the next nightly cron.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { enqueueInAppNotification } from '../queue.service.js';

const REASON_TYPE = 'CRITICAL_TRIAGE';
const WATCH_DAYS  = 14;

/**
 * @param {{ triageSessionId: string, patientId: string, urgencyLevel: string, branchId?: string|null }} payload
 */
export async function careGapAgent(payload) {
    const { triageSessionId, patientId, urgencyLevel, branchId } = payload;
    if (!patientId) {
        logger.warn('[agent:careGap] missing patientId — skipping');
        return { skipped: true, reason: 'no_patient' };
    }

    const detectedAt = new Date();
    const watchUntil = new Date(detectedAt.getTime() + WATCH_DAYS * 24 * 60 * 60 * 1000);

    // Read current flag so we can merge reasons rather than overwrite an
    // unrelated detector's row (the same model is shared by other care-gap
    // detectors — see /api/care-gaps).
    let existing = null;
    try {
        existing = await prisma.patientCriticalFlag.findUnique({
            where: { patientId },
            select: { id: true, reasons: true, severity: true },
        });
    } catch (err) {
        logger.warn('[agent:careGap] lookup failed', { patientId, err: err.message });
    }

    const incomingReason = {
        type: REASON_TYPE,
        detail: `Critical triage submitted (${urgencyLevel})`,
        triageSessionId,
        firstDetectedAt: detectedAt.toISOString(),
        lastDetectedAt:  detectedAt.toISOString(),
        watchUntil:      watchUntil.toISOString(),
    };

    // Merge: replace any prior CRITICAL_TRIAGE reason, preserve everything else.
    const priorReasons = Array.isArray(existing?.reasons) ? existing.reasons : [];
    const mergedReasons = priorReasons
        .filter((r) => r?.type !== REASON_TYPE)
        .concat(incomingReason);

    // CRITICAL triage forces HIGH severity even if a prior detector left it MEDIUM.
    const nextSeverity = 'HIGH';

    let flag = null;
    try {
        flag = await prisma.patientCriticalFlag.upsert({
            where: { patientId },
            create: {
                patientId,
                branchId: branchId ?? null,
                severity: nextSeverity,
                reasons:  mergedReasons,
                firstDetectedAt: detectedAt,
                lastDetectedAt:  detectedAt,
                notes:   `Auto-raised from critical triage — monitoring for ${WATCH_DAYS} days`,
                status:  'ACTIVE',
            },
            update: {
                severity: nextSeverity,
                reasons:  mergedReasons,
                lastDetectedAt: detectedAt,
                // If a prior detector resolved the flag and a fresh critical
                // triage arrives, re-open it.
                status:  'ACTIVE',
                resolvedAt:   null,
                resolvedById: null,
                ...(branchId ? { branchId } : {}),
            },
            select: { id: true, patientId: true, severity: true },
        });
    } catch (err) {
        logger.warn('[agent:careGap] upsert PatientCriticalFlag failed', {
            patientId, err: err.message,
        });
        return { skipped: true, reason: 'upsert_failed' };
    }

    // Notify the assigned doctor in-app. Best-effort — queue degrades silently
    // when Redis is down (see queue.service.js). We look up the assigned doctor
    // via PatientAssignment so the notification lands with the right clinician,
    // not the whole branch.
    let notifiedUserId = null;
    try {
        const assignment = await prisma.patientAssignment.findFirst({
            where: { patientId, status: 'ACTIVE', type: 'PRIMARY' },
            select: { doctor: { select: { userId: true, fullName: true } } },
        });
        const userId = assignment?.doctor?.userId ?? null;
        if (userId) {
            await enqueueInAppNotification({
                userId,
                title: 'Critical patient — auto-monitor raised',
                body:  `A new critical triage was submitted. The patient is now on a ${WATCH_DAYS}-day watch list.`,
                type:  'CRITICAL_TRIAGE',
                relatedId: triageSessionId,
            });
            notifiedUserId = userId;
        } else {
            logger.info('[agent:careGap] no active primary doctor assignment — skipping notification', {
                patientId,
            });
        }
    } catch (err) {
        logger.warn('[agent:careGap] doctor notification failed', { patientId, err: err.message });
    }

    logger.info('[agent:careGap] complete', {
        triageSessionId, patientId,
        flagId: flag?.id, severity: flag?.severity, notifiedUserId,
    });

    return {
        careGapRaised: true,
        flagId: flag?.id,
        notifiedUserId,
    };
}
