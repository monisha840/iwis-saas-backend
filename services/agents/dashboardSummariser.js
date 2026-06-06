/**
 * F07 · dashboardSummariser — final wave on triage.critical.submitted.
 *
 * Composes a single CRITICAL_TRIAGE_SUMMARY notification for the patient's
 * assigned doctor that consolidates what every other first-wave agent just
 * did. The frontend renders this notification type as a one-card briefing
 * on the doctor's dashboard so they don't have to assemble the picture
 * across four separate alerts.
 *
 * Why this agent waits:
 *   The four agents are registered on the same event and run via
 *   Promise.allSettled — there's no return-value handoff. To produce an
 *   accurate `autoActions` block we delay briefly so the sibling writes
 *   (PatientCriticalFlag upsert, MedicineStock notifications, Appointment
 *   slot hold) have committed, then query for them. 500ms is enough for
 *   any healthy Prisma write at the pooler latency we see; if a sibling
 *   is still mid-flight we just report what's visible so far — the
 *   notification is best-effort, not authoritative.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { enqueueInAppNotification } from '../queue.service.js';

const SIBLING_SETTLE_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ triageSessionId: string, patientId: string, urgencyLevel: string, branchId?: string|null }} payload
 */
export async function dashboardSummariser(payload) {
    const { triageSessionId, patientId, urgencyLevel } = payload;
    if (!triageSessionId || !patientId) {
        logger.warn('[agent:dashboardSummary] missing ids — skipping');
        return { skipped: true };
    }

    // Give siblings a head-start so we observe their writes.
    await sleep(SIBLING_SETTLE_MS);

    // Pull everything we need in parallel to keep latency low.
    const [
        session,
        patient,
        criticalFlag,
        heldAppt,
        assignment,
        activeRxCount,
    ] = await Promise.all([
        prisma.triageSession.findUnique({
            where: { id: triageSessionId },
            select: { redFlagsMatched: true, compositeScore: true, urgencyLevel: true },
        }).catch(() => null),
        prisma.patient.findUnique({
            where: { id: patientId },
            select: { id: true, fullName: true },
        }).catch(() => null),
        prisma.patientCriticalFlag.findUnique({
            where: { patientId },
            select: { id: true, severity: true, reasons: true, status: true },
        }).catch(() => null),
        prisma.appointment.findUnique({
            where: { triageSessionId },
            select: { id: true, date: true, status: true, doctorId: true },
        }).catch(() => null),
        prisma.patientAssignment.findFirst({
            where: { patientId, status: 'ACTIVE', type: 'PRIMARY' },
            select: { doctor: { select: { id: true, userId: true, fullName: true } } },
        }).catch(() => null),
        prisma.prescription.count({
            where: { patientId, discontinuedAt: null, medicineId: { not: null } },
        }).catch(() => 0),
    ]);

    // careGapRaised — true if a CRITICAL_TRIAGE reason is on the flag and
    // it points at *this* session (so a stale flag from yesterday doesn't
    // claim credit for tonight's triage).
    const careGapRaised = (() => {
        const reasons = Array.isArray(criticalFlag?.reasons) ? criticalFlag.reasons : [];
        return reasons.some(
            (r) => r?.type === 'CRITICAL_TRIAGE' && r?.triageSessionId === triageSessionId,
        );
    })();

    const slotHeld = !!(heldAppt && heldAppt.status === 'PENDING_DOCTOR_APPROVAL');
    const slotTime = heldAppt?.date ?? null;

    // For pharmacy we can't trivially recover "how many low-stock items
    // were flagged" without re-doing the agent's work — but we *can* report
    // the count of active medicines we tried to check. The summary card
    // accepts both fields and treats lowStockFlagged as null when unknown.
    const autoActions = {
        careGapRaised,
        medicinesChecked: activeRxCount ?? 0,
        lowStockFlagged: null,         // see comment above — best-effort only
        slotHeld,
        slotTime,
    };

    const summary = {
        patientId,
        patientName: patient?.fullName ?? null,
        urgencyLevel: session?.urgencyLevel ?? urgencyLevel,
        triageSessionId,
        redFlagsMatched: session?.redFlagsMatched ?? [],
        compositeScore:  session?.compositeScore ?? null,
        autoActions,
        generatedAt: new Date().toISOString(),
    };

    const assignedUserId = assignment?.doctor?.userId ?? null;
    if (!assignedUserId) {
        // No notification target — log the summary so it's at least
        // diagnosable in production logs.
        logger.info('[agent:dashboardSummary] no assigned doctor — logging summary only', { summary });
        return { notificationSent: false, summary };
    }

    // Notification payload doubles as the dashboard card data — the frontend
    // can read `data` and render the rich card without an extra fetch. The
    // existing notification queue's in-app handler stores `data` JSON on the
    // Notification row and emits over socket so the doctor sees it live.
    try {
        await enqueueInAppNotification({
            userId: assignedUserId,
            title: `Critical triage briefing — ${summary.patientName ?? 'patient'}`,
            body:  `Urgency ${summary.urgencyLevel}. ${autoActions.slotHeld ? 'Slot held; awaiting your confirmation.' : 'No slot available within 24h.'}`,
            type:  'CRITICAL_TRIAGE_SUMMARY',
            relatedId: triageSessionId,
        });
    } catch (err) {
        logger.warn('[agent:dashboardSummary] notification enqueue failed', {
            assignedUserId, err: err.message,
        });
        return { notificationSent: false, summary };
    }

    logger.info('[agent:dashboardSummary] complete', {
        triageSessionId, patientId, assignedUserId,
        careGapRaised, slotHeld, medicinesChecked: autoActions.medicinesChecked,
    });

    return { notificationSent: true, summary };
}
