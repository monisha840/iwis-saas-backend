import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';

/**
 * Care Gap Detection Service
 * Identifies patients at risk and sends targeted notifications.
 * Run daily via cron.
 */
export class CareGapService {
    /**
     * Read-only listing for the Care Gap Dashboard. Mirrors the same five
     * detection signals as `detectAndNotify` but writes nothing — every
     * page-load runs this fresh against the current DB state, then the UI
     * filters / paginates client-side after the initial roll-up.
     *
     * Output shape matches the frontend's `CareGapResponse["data"]` type
     * exactly (see `pages/admin/CareGapDashboard.tsx`):
     *   { summary: { totalGaps, highSeverity, mediumSeverity, lowSeverity, byType },
     *     gaps:    CareGap[],
     *     pagination: { page, limit, total, totalPages } }
     *
     * The `gapType` and `severity` filters narrow the rolled-up rows;
     * `branchId` scopes against TreatmentJourney.branchId / TriageSession.branchId
     * (admin doctors pass it explicitly from the navbar selector — null = all branches).
     */
    static async listGaps({ branchId = null, gapType = null, severity = null, page = 1, limit = 50 } = {}) {
        const wantTypes = new Set(
            gapType
                ? [gapType]
                : ['NO_RECENT_VISIT', 'INCOMPLETE_TRIAGE', 'LOW_ADHERENCE', 'WELLNESS_DECLINE', 'OVERDUE_PHASE'],
        );
        const gaps = [];
        const now = new Date();

        // ── 1. NO_RECENT_VISIT — active journeys with no appointment in 21+ days ──
        if (wantTypes.has('NO_RECENT_VISIT')) {
            const twentyOneDaysAgo = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);
            const journeys = await prisma.treatmentJourney.findMany({
                where: { status: 'ACTIVE', ...(branchId ? { branchId } : {}) },
                select: {
                    id: true, patientId: true, title: true,
                    // TreatmentJourney.doctor is a User relation (not Doctor),
                    // so fullName lives one hop deeper on User.doctor.
                    doctor: { select: { doctor: { select: { fullName: true } } } },
                },
            });
            // TreatmentJourney.patientId is User.id; resolve to Patient row for the UI.
            const userIds = Array.from(new Set(journeys.map((j) => j.patientId).filter(Boolean)));
            const patientRows = userIds.length
                ? await prisma.patient.findMany({
                    where: { userId: { in: userIds } },
                    select: { id: true, userId: true, fullName: true, profilePhoto: true },
                })
                : [];
            const patientByUserId = new Map(patientRows.map((p) => [p.userId, p]));
            for (const j of journeys) {
                const patient = patientByUserId.get(j.patientId);
                if (!patient) continue;
                const lastAppointment = await prisma.appointment.findFirst({
                    where: { patientId: patient.id, status: { in: ['COMPLETED', 'CONFIRMED', 'ACCEPTED'] } },
                    orderBy: { date: 'desc' },
                    select: { date: true },
                });
                if (lastAppointment && lastAppointment.date >= twentyOneDaysAgo) continue;
                const daysSince = lastAppointment
                    ? Math.floor((now.getTime() - lastAppointment.date.getTime()) / 86400000)
                    : null;
                gaps.push({
                    id: `NO_RECENT_VISIT-${j.id}`,
                    patientId: patient.id,
                    patientName: patient.fullName || 'Unnamed patient',
                    patientAvatar: patient.profilePhoto || null,
                    gapType: 'NO_RECENT_VISIT',
                    severity: 'MEDIUM',
                    detectedAt: now.toISOString(),
                    detail: daysSince !== null
                        ? `Last visit ${daysSince} days ago · "${j.title}"`
                        : `No appointments on record · "${j.title}"`,
                    assignedDoctorName: j.doctor?.doctor?.fullName || '—',
                    suggestedAction: 'Schedule a follow-up consultation',
                });
            }
        }

        // ── 2. INCOMPLETE_TRIAGE — sessions older than 3 days with no appointment ──
        if (wantTypes.has('INCOMPLETE_TRIAGE')) {
            const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
            const sessions = await prisma.triageSession.findMany({
                where: {
                    createdAt: { lt: threeDaysAgo },
                    appointment: null,
                    ...(branchId ? { branchId } : {}),
                },
                select: {
                    id: true, createdAt: true,
                    patient: { select: { id: true, fullName: true, profilePhoto: true } },
                },
            });
            for (const s of sessions) {
                if (!s.patient) continue;
                const daysSince = Math.floor((now.getTime() - s.createdAt.getTime()) / 86400000);
                gaps.push({
                    id: `INCOMPLETE_TRIAGE-${s.id}`,
                    patientId: s.patient.id,
                    patientName: s.patient.fullName || 'Unnamed patient',
                    patientAvatar: s.patient.profilePhoto || null,
                    gapType: 'INCOMPLETE_TRIAGE',
                    severity: 'LOW',
                    detectedAt: s.createdAt.toISOString(),
                    detail: `Triage started ${daysSince} days ago, no appointment booked`,
                    assignedDoctorName: '—',
                    suggestedAction: 'Reach out to schedule consultation',
                    // F08 popover support — surfaced so the frontend Care Gaps
                    // table can render an inline "Why?" trigger pointing at
                    // the originating triage session.
                    triageSessionId: s.id,
                });
            }
        }

        // ── 3. LOW_ADHERENCE — < 60% medication logs in last 7 days ──
        if (wantTypes.has('LOW_ADHERENCE')) {
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const activeRx = await prisma.prescription.findMany({
                where: { totalQuantity: { gt: 0 }, ...(branchId ? { branchId } : {}) },
                select: {
                    id: true, patientId: true,
                    patient: { select: { id: true, fullName: true, profilePhoto: true } },
                    doctor:  { select: { fullName: true } },
                },
            });
            const byPatient = new Map();
            for (const rx of activeRx) {
                if (!rx.patient) continue;
                if (!byPatient.has(rx.patientId)) {
                    byPatient.set(rx.patientId, {
                        patient: rx.patient,
                        doctorName: rx.doctor?.fullName || '—',
                        rxIds: [],
                    });
                }
                byPatient.get(rx.patientId).rxIds.push(rx.id);
            }
            for (const [, { patient, doctorName, rxIds }] of byPatient) {
                const logs = await prisma.medicationLog.findMany({
                    where: { prescriptionId: { in: rxIds }, taken: true, takenAt: { gte: sevenDaysAgo } },
                    select: { takenAt: true },
                });
                const uniqueDays = new Set(logs.map((l) => l.takenAt.toISOString().slice(0, 10))).size;
                const adherenceRate = Math.round((uniqueDays / 7) * 100);
                if (adherenceRate >= 60) continue;
                gaps.push({
                    id: `LOW_ADHERENCE-${patient.id}`,
                    patientId: patient.id,
                    patientName: patient.fullName || 'Unnamed patient',
                    patientAvatar: patient.profilePhoto || null,
                    gapType: 'LOW_ADHERENCE',
                    // High = 0-30% adherence, Medium = 30-60%, otherwise it isn't flagged
                    severity: adherenceRate < 30 ? 'HIGH' : 'MEDIUM',
                    detectedAt: now.toISOString(),
                    detail: `${adherenceRate}% medication adherence over the last 7 days`,
                    assignedDoctorName: doctorName,
                    suggestedAction: 'Send adherence reminder / counsel patient',
                });
            }
        }

        // ── 4. WELLNESS_DECLINE — pain score jumped > 2 points week-over-week ──
        if (wantTypes.has('WELLNESS_DECLINE')) {
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const journeys = await prisma.treatmentJourney.findMany({
                where: { status: 'ACTIVE', ...(branchId ? { branchId } : {}) },
                select: {
                    id: true, patientId: true, title: true,
                    // Same User → Doctor hop as the NO_RECENT_VISIT query above.
                    doctor: { select: { doctor: { select: { fullName: true } } } },
                },
            });
            const userIds = Array.from(new Set(journeys.map((j) => j.patientId).filter(Boolean)));
            const patientRows = userIds.length
                ? await prisma.patient.findMany({
                    where: { userId: { in: userIds } },
                    select: { id: true, userId: true, fullName: true, profilePhoto: true },
                })
                : [];
            const patientByUserId = new Map(patientRows.map((p) => [p.userId, p]));
            for (const j of journeys) {
                const patient = patientByUserId.get(j.patientId);
                if (!patient) continue;
                const painVitals = await prisma.patientVital.findMany({
                    where: { journeyId: j.id, type: 'PAIN_SCORE' },
                    orderBy: { recordedAt: 'desc' },
                    take: 14,
                });
                if (painVitals.length < 2) continue;
                const recent = painVitals.slice(0, 3);
                const older = painVitals.filter((v) => v.recordedAt < sevenDaysAgo).slice(0, 3);
                if (older.length === 0) continue;
                const recentAvg = recent.reduce((s, v) => s + v.value, 0) / recent.length;
                const olderAvg  = older.reduce((s, v) => s + v.value, 0) / older.length;
                const delta = recentAvg - olderAvg;
                if (delta <= 2) continue;
                gaps.push({
                    id: `WELLNESS_DECLINE-${j.id}`,
                    patientId: patient.id,
                    patientName: patient.fullName || 'Unnamed patient',
                    patientAvatar: patient.profilePhoto || null,
                    gapType: 'WELLNESS_DECLINE',
                    severity: 'HIGH',
                    detectedAt: now.toISOString(),
                    detail: `Pain score up ${delta.toFixed(1)} points in 7 days · "${j.title}"`,
                    assignedDoctorName: j.doctor?.doctor?.fullName || '—',
                    suggestedAction: 'Review treatment plan; consider a check-in call',
                });
            }
        }

        // ── 5. OVERDUE_PHASE — ACTIVE phase past its startedAt + durationDays ──
        if (wantTypes.has('OVERDUE_PHASE')) {
            const phases = await prisma.journeyPhase.findMany({
                where: {
                    status: 'ACTIVE',
                    startedAt: { not: null },
                    journey: { status: 'ACTIVE', ...(branchId ? { branchId } : {}) },
                },
                select: {
                    id: true, name: true, startedAt: true, durationDays: true,
                    journey: {
                        select: {
                            id: true, patientId: true, title: true,
                            // Same User → Doctor hop. journey.doctor is a User
                            // relation; Doctor.fullName lives at .doctor.doctor.fullName.
                            doctor: { select: { doctor: { select: { fullName: true } } } },
                        },
                    },
                },
            });
            const userIds = Array.from(new Set(phases.map((p) => p.journey?.patientId).filter(Boolean)));
            const patientRows = userIds.length
                ? await prisma.patient.findMany({
                    where: { userId: { in: userIds } },
                    select: { id: true, userId: true, fullName: true, profilePhoto: true },
                })
                : [];
            const patientByUserId = new Map(patientRows.map((p) => [p.userId, p]));
            for (const phase of phases) {
                if (!phase.journey || !phase.startedAt) continue;
                const expectedEnd = new Date(phase.startedAt);
                expectedEnd.setDate(expectedEnd.getDate() + phase.durationDays);
                if (now <= expectedEnd) continue;
                const patient = patientByUserId.get(phase.journey.patientId);
                if (!patient) continue;
                const daysOver = Math.floor((now.getTime() - expectedEnd.getTime()) / 86400000);
                gaps.push({
                    id: `OVERDUE_PHASE-${phase.id}`,
                    patientId: patient.id,
                    patientName: patient.fullName || 'Unnamed patient',
                    patientAvatar: patient.profilePhoto || null,
                    gapType: 'OVERDUE_PHASE',
                    severity: daysOver > 14 ? 'HIGH' : 'MEDIUM',
                    detectedAt: expectedEnd.toISOString(),
                    detail: `Phase "${phase.name}" overdue by ${daysOver} day${daysOver === 1 ? '' : 's'} · "${phase.journey.title}"`,
                    assignedDoctorName: phase.journey.doctor?.doctor?.fullName || '—',
                    suggestedAction: 'Review the journey and advance or extend the phase',
                });
            }
        }

        // ── Summary (computed across the full unfiltered roll-up so the
        // "byType" counts still mean something when severity is narrowed) ──
        const byType = {
            NO_RECENT_VISIT:   gaps.filter((g) => g.gapType === 'NO_RECENT_VISIT').length,
            INCOMPLETE_TRIAGE: gaps.filter((g) => g.gapType === 'INCOMPLETE_TRIAGE').length,
            LOW_ADHERENCE:     gaps.filter((g) => g.gapType === 'LOW_ADHERENCE').length,
            WELLNESS_DECLINE:  gaps.filter((g) => g.gapType === 'WELLNESS_DECLINE').length,
            OVERDUE_PHASE:     gaps.filter((g) => g.gapType === 'OVERDUE_PHASE').length,
        };

        const filtered = severity ? gaps.filter((g) => g.severity === severity) : gaps;
        const total = filtered.length;
        const safePage = Math.max(1, Number(page) || 1);
        const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
        const start = (safePage - 1) * safeLimit;
        const pageRows = filtered.slice(start, start + safeLimit);

        return {
            summary: {
                totalGaps: filtered.length,
                highSeverity:   filtered.filter((g) => g.severity === 'HIGH').length,
                mediumSeverity: filtered.filter((g) => g.severity === 'MEDIUM').length,
                lowSeverity:    filtered.filter((g) => g.severity === 'LOW').length,
                byType,
            },
            gaps: pageRows,
            pagination: {
                page: safePage,
                limit: safeLimit,
                total,
                totalPages: Math.max(1, Math.ceil(total / safeLimit)),
            },
        };
    }

    static async detectAndNotify() {
        let totalAlerts = 0;

        // Gap 1: No visit in 21 days (existing patients with active journeys)
        totalAlerts += await this._detectNoVisitGap();

        // Gap 2: Incomplete triage started > 3 days ago
        totalAlerts += await this._detectIncompleteTriage();

        // Gap 3: Prescription adherence < 60% for last 7 days
        totalAlerts += await this._detectLowAdherence();

        // Gap 4: Wellness score declined > 15 points in 7 days
        totalAlerts += await this._detectWellnessDecline();

        // Gap 5: Journey phase overdue (still ACTIVE past expected end)
        totalAlerts += await this._detectOverduePhases();

        logger.info(`[CareGap] Detection complete: ${totalAlerts} total alerts sent`);
        return totalAlerts;
    }

    /**
     * Gap 1: No appointment in 21+ days for patients with active treatment journeys.
     */
    static async _detectNoVisitGap() {
        const twentyOneDaysAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
        let count = 0;

        const activeJourneys = await prisma.treatmentJourney.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true, patientId: true, doctorId: true, title: true },
        });

        for (const journey of activeJourneys) {
            const lastAppointment = await prisma.appointment.findFirst({
                where: {
                    patientId: journey.patientId,
                    status: { in: ['COMPLETED', 'CONFIRMED', 'ACCEPTED'] },
                },
                orderBy: { date: 'desc' },
                select: { date: true },
            });

            if (!lastAppointment || lastAppointment.date < twentyOneDaysAgo) {
                // Deduplicate: skip if already notified in last 7 days
                const recent = await this._hasRecentAlert(journey.patientId, 'CARE_GAP_NO_VISIT');
                if (recent) continue;

                await notificationService.createNotification({
                    userId: journey.patientId,
                    type: 'CARE_GAP_NO_VISIT',
                    title: 'Time to schedule your next visit',
                    message: `You haven't had an appointment in over 3 weeks. Regular sessions help your "${journey.title}" journey.`,
                    priority: 'MEDIUM',
                    data: { journeyId: journey.id, gapType: 'no_visit' },
                });
                count++;
            }
        }

        return count;
    }

    /**
     * Gap 2: Triage sessions started > 3 days ago with no linked appointment.
     */
    static async _detectIncompleteTriage() {
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        let count = 0;

        const incompleteSessions = await prisma.triageSession.findMany({
            where: {
                createdAt: { lt: threeDaysAgo },
                appointment: null, // no linked appointment
            },
            include: { patient: { select: { userId: true } } },
        });

        for (const session of incompleteSessions) {
            if (!session.patient?.userId) continue;
            const recent = await this._hasRecentAlert(session.patient.userId, 'CARE_GAP_INCOMPLETE_TRIAGE');
            if (recent) continue;

            await notificationService.createNotification({
                userId: session.patient.userId,
                type: 'CARE_GAP_INCOMPLETE_TRIAGE',
                title: 'Complete your health assessment',
                message: 'You started a triage assessment but haven\'t booked an appointment yet. Book now to get the care you need.',
                priority: 'LOW',
                data: { triageSessionId: session.id, gapType: 'incomplete_triage' },
            });
            count++;
        }

        return count;
    }

    /**
     * Gap 3: Prescription adherence < 60% over last 7 days.
     */
    static async _detectLowAdherence() {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        let count = 0;

        // Get patients with active prescriptions
        const activePrescriptions = await prisma.prescription.findMany({
            where: { totalQuantity: { gt: 0 } },
            include: { patient: { select: { userId: true, fullName: true } } },
        });

        // Group by patient
        const patientMap = new Map();
        for (const rx of activePrescriptions) {
            if (!rx.patient?.userId) continue;
            if (!patientMap.has(rx.patientId)) {
                patientMap.set(rx.patientId, { userId: rx.patient.userId, prescriptions: [] });
            }
            patientMap.get(rx.patientId).prescriptions.push(rx);
        }

        for (const [patientId, { userId, prescriptions }] of patientMap) {
            // Count days with medication logs in last 7 days
            const logs = await prisma.medicationLog.findMany({
                where: {
                    prescriptionId: { in: prescriptions.map(p => p.id) },
                    taken: true,
                    takenAt: { gte: sevenDaysAgo },
                },
                select: { takenAt: true },
            });

            const uniqueDays = new Set(logs.map(l => l.takenAt.toISOString().split('T')[0])).size;
            const adherenceRate = (uniqueDays / 7) * 100;

            if (adherenceRate < 60) {
                const recent = await this._hasRecentAlert(userId, 'CARE_GAP_LOW_ADHERENCE');
                if (recent) continue;

                await notificationService.createNotification({
                    userId,
                    type: 'CARE_GAP_LOW_ADHERENCE',
                    title: 'Medication reminder',
                    message: `Your medication adherence has been ${Math.round(adherenceRate)}% this week. Consistent medication helps your recovery.`,
                    priority: 'MEDIUM',
                    data: { adherenceRate, gapType: 'low_adherence' },
                });
                count++;
            }
        }

        return count;
    }

    /**
     * Gap 4: Wellness score declined > 15 points in 7 days.
     */
    static async _detectWellnessDecline() {
        let count = 0;

        const activeJourneys = await prisma.treatmentJourney.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true, patientId: true, wellnessScore: true, title: true },
        });

        for (const journey of activeJourneys) {
            // Get wellness score from 7 days ago by checking vitals trend
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const painVitals = await prisma.patientVital.findMany({
                where: { journeyId: journey.id, type: 'PAIN_SCORE' },
                orderBy: { recordedAt: 'desc' },
                take: 14,
            });

            if (painVitals.length < 2) continue;

            const recentAvg = painVitals.slice(0, 3).reduce((s, v) => s + v.value, 0) / Math.min(3, painVitals.length);
            const olderVitals = painVitals.filter(v => v.recordedAt < sevenDaysAgo);
            if (olderVitals.length === 0) continue;
            const olderAvg = olderVitals.slice(0, 3).reduce((s, v) => s + v.value, 0) / Math.min(3, olderVitals.length);

            // Higher pain = worse. If recent pain increased significantly
            if (recentAvg - olderAvg > 2) {
                const recent = await this._hasRecentAlert(journey.patientId, 'CARE_GAP_WELLNESS_DECLINE');
                if (recent) continue;

                await notificationService.createNotification({
                    userId: journey.patientId,
                    type: 'CARE_GAP_WELLNESS_DECLINE',
                    title: 'We noticed a change in your wellness',
                    message: `Your pain levels have increased recently. Consider scheduling a consultation to discuss your "${journey.title}" journey.`,
                    priority: 'HIGH',
                    data: { journeyId: journey.id, gapType: 'wellness_decline' },
                });
                count++;
            }
        }

        return count;
    }

    /**
     * Gap 5: Journey phase overdue — still ACTIVE past expected end date.
     */
    static async _detectOverduePhases() {
        let count = 0;

        const activePhases = await prisma.journeyPhase.findMany({
            where: { status: 'ACTIVE', startedAt: { not: null } },
            include: {
                journey: { select: { id: true, patientId: true, doctorId: true, title: true, status: true } },
            },
        });

        for (const phase of activePhases) {
            if (phase.journey.status !== 'ACTIVE') continue;

            const expectedEnd = new Date(phase.startedAt);
            expectedEnd.setDate(expectedEnd.getDate() + phase.durationDays);

            if (new Date() > expectedEnd) {
                const recent = await this._hasRecentAlert(phase.journey.patientId, 'CARE_GAP_OVERDUE_PHASE');
                if (recent) continue;

                // Notify patient
                await notificationService.createNotification({
                    userId: phase.journey.patientId,
                    type: 'CARE_GAP_OVERDUE_PHASE',
                    title: `Phase "${phase.name}" is overdue`,
                    message: `Your "${phase.name}" phase in "${phase.journey.title}" has exceeded its planned duration. Talk to your doctor about next steps.`,
                    priority: 'MEDIUM',
                    data: { journeyId: phase.journey.id, phaseId: phase.id, gapType: 'overdue_phase' },
                });

                // Notify doctor
                if (phase.journey.doctorId) {
                    await notificationService.createNotification({
                        userId: phase.journey.doctorId,
                        type: 'CARE_GAP_OVERDUE_PHASE_DOCTOR',
                        title: `Overdue phase for patient`,
                        message: `Phase "${phase.name}" in journey "${phase.journey.title}" is overdue. Consider reviewing the treatment plan.`,
                        priority: 'LOW',
                        data: { journeyId: phase.journey.id, phaseId: phase.id, patientId: phase.journey.patientId },
                    });
                }

                count++;
            }
        }

        return count;
    }

    /**
     * Deduplication helper: check if a care gap alert was already sent within last 7 days.
     * Also short-circuits if ANY care-gap notification was sent to this user in the last 24h
     * so a single patient never receives > 1 gap alert per day across the 5 dimensions.
     */
    static async _hasRecentAlert(userId, type) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const existing = await prisma.notification.findFirst({
            where: {
                userId,
                OR: [
                    { type, createdAt: { gte: sevenDaysAgo } },
                    { type: { startsWith: 'CARE_GAP_' }, createdAt: { gte: oneDayAgo } },
                ],
            },
            select: { id: true },
        });
        return !!existing;
    }

    /**
     * Atomic dedup + create: prevents concurrent runs from producing duplicate alerts.
     * Returns the created notification or null if an alert was already sent recently.
     */
    static async _createAlertIfAbsent(payload) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        try {
            return await prisma.$transaction(async (tx) => {
                const existing = await tx.notification.findFirst({
                    where: { userId: payload.userId, type: payload.type, createdAt: { gte: sevenDaysAgo } },
                    select: { id: true },
                });
                if (existing) return null;
                return tx.notification.create({
                    data: {
                        userId: payload.userId,
                        type: payload.type,
                        title: payload.title,
                        message: payload.message,
                        priority: payload.priority || 'INFO',
                        data: payload.data || {},
                    },
                });
            }, { isolationLevel: 'Serializable' });
        } catch (err) {
            if (err?.code === 'P2002') return null;
            throw err;
        }
    }
}
