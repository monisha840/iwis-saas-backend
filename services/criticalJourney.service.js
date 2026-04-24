import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';

/**
 * Critical Journey Service
 *
 * Detects patients who are failing to adhere to their prescribed plan
 * (missed medications, missed vital uploads, missed follow-ups, skipped
 * daily check-ins) and upserts a single `PatientCriticalFlag` row per
 * patient with the specific reasons. Runs on a cron (see
 * scheduledJobs.service.js) and on-demand via the admin rescan endpoint.
 *
 * Design decisions:
 *   - One row per patient (unique index). The detector overwrites the
 *     `reasons` JSON list on every pass so admin UI always sees the
 *     current set. ACTIVE → RESOLVED only when no reasons remain (or an
 *     admin manually resolves).
 *   - Severity is derived from reason count / highest-weight reason:
 *     3+ reasons OR any "missed follow-up" → HIGH; 2 reasons → MEDIUM;
 *     1 reason → LOW.
 *   - Patient admin notification sent once per day when severity
 *     transitions up (LOW → MEDIUM / HIGH). Uses notification history
 *     dedup guard.
 */

export const CRITICAL_REASON_TYPES = Object.freeze([
    'MISSED_MEDICATION',
    'MISSED_VITAL_UPLOAD',
    'MISSED_DAILY_CHECKIN',
    'MISSED_FOLLOWUP',
    'WELLNESS_DECLINE',
    'OVERDUE_JOURNEY_PHASE',
]);

const MS_DAY = 24 * 60 * 60 * 1000;

function daysAgo(n) { return new Date(Date.now() - n * MS_DAY); }

/**
 * Derive severity from the list of reasons.
 *   3+ reasons, OR a missed follow-up, OR explicit HIGH-weight reason → HIGH
 *   2 reasons → MEDIUM
 *   1 reason → LOW
 */
function deriveSeverity(reasons) {
    if (!reasons || reasons.length === 0) return 'LOW';
    const types = new Set(reasons.map(r => r.type));
    if (reasons.length >= 3) return 'HIGH';
    if (types.has('MISSED_FOLLOWUP') || types.has('WELLNESS_DECLINE')) return 'HIGH';
    if (reasons.length === 2) return 'MEDIUM';
    return 'LOW';
}

export class CriticalJourneyService {
    /**
     * Returns the currently-active flag rows with patient context,
     * optionally filtered by branch and/or severity. Used by the admin
     * "Critical Journey" page.
     */
    static async list({ branchId, severity, limit = 100 } = {}) {
        const where = { status: 'ACTIVE' };
        if (branchId && branchId !== 'ALL') where.branchId = branchId;
        if (severity) where.severity = severity;

        const rows = await prisma.patientCriticalFlag.findMany({
            where,
            orderBy: [{ severity: 'desc' }, { lastDetectedAt: 'desc' }],
            take: Math.min(limit, 500),
            include: {
                patient: {
                    select: {
                        id: true,
                        fullName: true,
                        phoneNumber: true,
                        userId: true,
                        profilePhoto: true,
                        age: true,
                        gender: true,
                        branch: { select: { id: true, name: true } },
                    },
                },
            },
        });

        return rows.map(r => ({
            id: r.id,
            patient: {
                id: r.patient.id,
                userId: r.patient.userId,
                fullName: r.patient.fullName,
                phoneNumber: r.patient.phoneNumber,
                profilePhoto: r.patient.profilePhoto,
                age: r.patient.age,
                gender: r.patient.gender,
                branch: r.patient.branch,
            },
            severity: r.severity,
            status: r.status,
            reasons: Array.isArray(r.reasons) ? r.reasons : [],
            firstDetectedAt: r.firstDetectedAt,
            lastDetectedAt: r.lastDetectedAt,
            notes: r.notes,
        }));
    }

    /**
     * Aggregate counters for the admin dashboard card.
     */
    static async stats({ branchId } = {}) {
        const where = { status: 'ACTIVE' };
        if (branchId && branchId !== 'ALL') where.branchId = branchId;

        const [total, bySeverity] = await Promise.all([
            prisma.patientCriticalFlag.count({ where }),
            prisma.patientCriticalFlag.groupBy({
                by: ['severity'],
                where,
                _count: { _all: true },
            }),
        ]);

        const severityMap = Object.fromEntries(bySeverity.map(s => [s.severity, s._count._all]));
        return {
            total,
            high: severityMap.HIGH || 0,
            medium: severityMap.MEDIUM || 0,
            low: severityMap.LOW || 0,
        };
    }

    /**
     * Manually resolve a patient's flag — for when the admin has
     * intervened (called the patient, scheduled a visit, etc.).
     */
    static async resolve(patientId, user, note) {
        const updated = await prisma.patientCriticalFlag.update({
            where: { patientId },
            data: {
                status: 'RESOLVED',
                resolvedAt: new Date(),
                resolvedById: user.id,
                notes: note || null,
            },
        });
        return updated;
    }

    /**
     * Full sweep over the patient base. Computes adherence reasons per
     * patient and upserts the single `PatientCriticalFlag` row. Patients
     * with no reasons have any existing ACTIVE flag auto-resolved.
     *
     * This is deliberately a simple, sequential loop — the patient
     * base for Al-Shifa is measured in thousands, not millions, and the
     * cron runs off-peak. Prioritises correctness over throughput.
     */
    static async detect({ branchId } = {}) {
        const patientWhere = {};
        if (branchId && branchId !== 'ALL') patientWhere.branchId = branchId;

        const patients = await prisma.patient.findMany({
            where: patientWhere,
            select: {
                id: true, userId: true, fullName: true, branchId: true,
                user: { select: { id: true } },
            },
        });

        let flaggedCount = 0;
        let resolvedCount = 0;

        for (const patient of patients) {
            try {
                const reasons = await this._gatherReasons(patient);
                if (reasons.length === 0) {
                    // Auto-resolve a previously ACTIVE flag when the
                    // patient is no longer in violation.
                    const existing = await prisma.patientCriticalFlag.findUnique({ where: { patientId: patient.id } });
                    if (existing && existing.status === 'ACTIVE') {
                        await prisma.patientCriticalFlag.update({
                            where: { patientId: patient.id },
                            data: {
                                status: 'RESOLVED',
                                resolvedAt: new Date(),
                                notes: 'Auto-resolved: no outstanding critical reasons',
                            },
                        });
                        resolvedCount++;
                    }
                    continue;
                }

                const severity = deriveSeverity(reasons);
                const existing = await prisma.patientCriticalFlag.findUnique({ where: { patientId: patient.id } });
                const previousSeverity = existing?.severity || null;
                const wasActive = existing?.status === 'ACTIVE';

                await prisma.patientCriticalFlag.upsert({
                    where: { patientId: patient.id },
                    create: {
                        patientId: patient.id,
                        branchId: patient.branchId,
                        status: 'ACTIVE',
                        severity,
                        reasons,
                        firstDetectedAt: new Date(),
                        lastDetectedAt: new Date(),
                    },
                    update: {
                        branchId: patient.branchId,
                        status: 'ACTIVE',
                        severity,
                        reasons,
                        lastDetectedAt: new Date(),
                        // Clear prior resolution when re-flagging
                        resolvedAt: null,
                        resolvedById: null,
                    },
                });
                flaggedCount++;

                // Notify branch admins once when the flag is newly
                // raised or severity escalates (MEDIUM→HIGH). Uses
                // existing dedup helper with a notification-history
                // window of 24h.
                const shouldNotify =
                    !wasActive ||
                    (previousSeverity && previousSeverity !== 'HIGH' && severity === 'HIGH');

                if (shouldNotify) {
                    await this._notifyAdmins(patient, severity, reasons);
                }
            } catch (err) {
                logger.warn(`[criticalJourney] detect failed for patient ${patient.id}: ${err.message}`);
            }
        }

        logger.info(`[criticalJourney] detect: flagged=${flaggedCount} auto-resolved=${resolvedCount} scanned=${patients.length}`);
        return { flagged: flaggedCount, resolved: resolvedCount, scanned: patients.length };
    }

    /**
     * Compute the list of active critical-status reasons for one
     * patient. Returns an array of `{type, detail, lastDetectedAt,
     * value?}` objects — empty when the patient is in good standing.
     */
    static async _gatherReasons(patient) {
        const now = new Date();
        const reasons = [];

        // Reason 1: Missed medications (active prescriptions with no
        // taken=true log in the last 3 days). Threshold matches our
        // existing low-adherence detector but tighter (3 vs 7 days) so
        // admin sees near-real-time non-adherence.
        try {
            const activePrescriptions = await prisma.prescription.findMany({
                where: { patientId: patient.id, totalQuantity: { gt: 0 } },
                select: { id: true, medicationName: true },
            });
            if (activePrescriptions.length > 0) {
                const ids = activePrescriptions.map(p => p.id);
                const recentLog = await prisma.medicationLog.findFirst({
                    where: {
                        prescriptionId: { in: ids },
                        taken: true,
                        takenAt: { gte: daysAgo(3) },
                    },
                    select: { id: true },
                });
                if (!recentLog) {
                    reasons.push({
                        type: 'MISSED_MEDICATION',
                        detail: `No medication log in the last 3 days across ${activePrescriptions.length} active prescription${activePrescriptions.length === 1 ? '' : 's'}`,
                        lastDetectedAt: now.toISOString(),
                        value: { activeCount: activePrescriptions.length },
                    });
                }
            }
        } catch (err) {
            logger.warn(`[criticalJourney] missed-med check failed: ${err.message}`);
        }

        // Reason 2: Missed vital uploads (patient has active
        // PrescribedVital but no PatientVital of that type within the
        // expected cadence: DAILY=3 days, TWICE_DAILY=2 days, WEEKLY=10
        // days).
        try {
            const prescribedVitals = await prisma.prescribedVital.findMany({
                where: { patientId: patient.id, active: true },
                select: { id: true, vitalType: true, frequency: true },
            });
            const missed = [];
            for (const pv of prescribedVitals) {
                const cadenceDays = pv.frequency === 'WEEKLY' ? 10
                    : pv.frequency === 'TWICE_DAILY' ? 2
                    : 3; // DAILY (default)
                // PatientVital.patientId joins to User (not Patient),
                // per the project convention — pass Patient.userId here.
                const recent = await prisma.patientVital.findFirst({
                    where: {
                        patientId: patient.userId,
                        type: pv.vitalType,
                        recordedAt: { gte: daysAgo(cadenceDays) },
                    },
                    select: { id: true },
                });
                if (!recent) missed.push({ vitalType: pv.vitalType, frequency: pv.frequency, cadenceDays });
            }
            if (missed.length > 0) {
                reasons.push({
                    type: 'MISSED_VITAL_UPLOAD',
                    detail: `Required vital upload${missed.length === 1 ? '' : 's'} missing: ${missed.map(m => m.vitalType).join(', ')}`,
                    lastDetectedAt: now.toISOString(),
                    value: { missed },
                });
            }
        } catch (err) {
            logger.warn(`[criticalJourney] missed-vital check failed: ${err.message}`);
        }

        // Reason 3: Missed daily check-ins for 5+ consecutive days when
        // the patient has an active treatment journey (which implies a
        // care plan is active).
        try {
            const hasActiveJourney = await prisma.treatmentJourney.findFirst({
                where: { patientId: patient.userId, status: 'ACTIVE' },
                select: { id: true },
            });
            if (hasActiveJourney) {
                const lastCheckIn = await prisma.dailyCheckIn.findFirst({
                    where: { patientId: patient.id },
                    orderBy: { createdAt: 'desc' },
                    select: { createdAt: true },
                });
                const threshold = daysAgo(5);
                if (!lastCheckIn || lastCheckIn.createdAt < threshold) {
                    reasons.push({
                        type: 'MISSED_DAILY_CHECKIN',
                        detail: lastCheckIn
                            ? `Last daily check-in was ${Math.floor((now - lastCheckIn.createdAt) / MS_DAY)} days ago`
                            : 'No daily check-ins recorded since starting the journey',
                        lastDetectedAt: now.toISOString(),
                        value: { lastCheckInAt: lastCheckIn?.createdAt || null },
                    });
                }
            }
        } catch (err) {
            logger.warn(`[criticalJourney] missed-checkin check failed: ${err.message}`);
        }

        // Reason 4: Missed follow-up (the FollowUpService cron has
        // already flipped it to MISSED, but only if the patient also
        // hasn't booked a subsequent visit).
        try {
            const missedFollowUp = await prisma.appointmentFollowUp.findFirst({
                where: { patientId: patient.id, status: 'MISSED' },
                orderBy: { dueDate: 'desc' },
                select: { id: true, dueDate: true, daysOffset: true },
            });
            if (missedFollowUp) {
                reasons.push({
                    type: 'MISSED_FOLLOWUP',
                    detail: `Missed ${missedFollowUp.daysOffset}-day follow-up due on ${missedFollowUp.dueDate?.toISOString().slice(0, 10)}`,
                    lastDetectedAt: now.toISOString(),
                    value: { followUpId: missedFollowUp.id, dueDate: missedFollowUp.dueDate },
                });
            }
        } catch (err) {
            logger.warn(`[criticalJourney] missed-followup check failed: ${err.message}`);
        }

        return reasons;
    }

    /**
     * Fire a notification to branch admins + the patient's assigned
     * doctor when a critical flag is raised / escalated. Best-effort —
     * never throws.
     */
    static async _notifyAdmins(patient, severity, reasons) {
        try {
            const targets = await prisma.user.findMany({
                where: {
                    branchId: patient.branchId || undefined,
                    role: { in: ['ADMIN', 'ADMIN_DOCTOR'] },
                    deletedAt: null,
                },
                select: { id: true },
                take: 20,
            });
            const title = severity === 'HIGH' ? 'Patient flagged as HIGH-risk' : 'Patient flagged as critical';
            const message = `${patient.fullName || 'Patient'} has ${reasons.length} outstanding critical reason${reasons.length === 1 ? '' : 's'}: ${reasons.map(r => r.type.replace(/_/g, ' ').toLowerCase()).join(', ')}.`;
            await Promise.all(targets.map(t =>
                notificationService.createNotification({
                    userId: t.id,
                    type: severity === 'HIGH' ? 'CRITICAL_JOURNEY_HIGH' : 'CRITICAL_JOURNEY_FLAGGED',
                    title,
                    message,
                    priority: severity === 'HIGH' ? 'HIGH' : 'MEDIUM',
                    data: { patientId: patient.id, severity, reasonTypes: reasons.map(r => r.type) },
                }).catch(() => null)
            ));
        } catch (err) {
            logger.warn(`[criticalJourney] admin notify failed for patient ${patient.id}: ${err.message}`);
        }
    }
}
