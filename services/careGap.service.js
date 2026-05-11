import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';

/**
 * Care Gap Detection Service
 * Identifies patients at risk and sends targeted notifications.
 * Run daily via cron.
 */
export class CareGapService {
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
     * Read-only list endpoint. Same five detection signals as the cron, but
     * returns the current state as a structured payload rather than writing
     * notifications. Used by GET /api/care-gaps and the CareGapDashboard page.
     *
     * Filters:
     *   branchId — when present, only patients in that branch are counted.
     *              ADMIN can pass any branchId; non-admin roles should pass
     *              their JWT branchId at the route layer.
     *   gapType  — NO_RECENT_VISIT | INCOMPLETE_TRIAGE | LOW_ADHERENCE |
     *              WELLNESS_DECLINE | OVERDUE_PHASE
     *   severity — HIGH | MEDIUM | LOW
     *   page, limit — pagination over the merged gap list.
     */
    static async listGaps({ branchId = null, gapType = null, severity = null, page = 1, limit = 20 } = {}) {
        const currentPage = Math.max(1, parseInt(page) || 1);
        const take = Math.min(parseInt(limit) || 20, 100);

        const now = new Date();
        const twentyOneDaysAgo = new Date(now.getTime() - 21 * 86400 * 1000);
        const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400 * 1000);
        const threeDaysAgo = new Date(now.getTime() - 3 * 86400 * 1000);
        const sevenDaysAgo = new Date(now.getTime() - 7 * 86400 * 1000);

        // TriageSession / Prescription / Patient queries scope by Patient.branchId.
        const patientWhere = branchId ? { branchId } : {};

        // Lookup helper: TreatmentJourney.patientId references User.id (NOT
        // Patient.id) — that's a legacy quirk of the journey model. We bulk-
        // resolve User → Patient + assigned-doctor info in one shot so the
        // per-row gap rendering can pull patientName/avatar/doctor without
        // re-querying.
        const bulkResolve = async (userIds) => {
            if (userIds.length === 0) return new Map();
            const users = await prisma.user.findMany({
                where: { id: { in: [...new Set(userIds)] } },
                select: {
                    id: true,
                    patient: { select: { id: true, fullName: true, profilePhoto: true } },
                    doctor:  { select: { fullName: true } },
                },
            });
            return new Map(users.map((u) => [u.id, u]));
        };

        // ── Gap 1: NO_RECENT_VISIT ───────────────────────────────────────────
        // Patients with active journeys whose latest accepted/completed
        // appointment is older than 21 days (or never had one). Branch scope
        // uses TreatmentJourney.branchId directly (the model owns its own
        // branchId column — see schema.prisma:1699).
        const journeys = (gapType && gapType !== 'NO_RECENT_VISIT')
            ? []
            : await prisma.treatmentJourney.findMany({
                where: { status: 'ACTIVE', ...(branchId ? { branchId } : {}) },
                select: { id: true, patientId: true, doctorId: true, title: true },
            });

        const noVisitUserIds = journeys.map((j) => j.patientId).concat(journeys.map((j) => j.doctorId));
        const noVisitUserMap = await bulkResolve(noVisitUserIds);

        const noVisitGaps = [];
        for (const j of journeys) {
            const userInfo = noVisitUserMap.get(j.patientId);
            const patientRow = userInfo?.patient;
            // Skip journeys whose User has no Patient row (data anomaly) — we
            // can't display anything meaningful.
            if (!patientRow) continue;

            const lastAppt = await prisma.appointment.findFirst({
                where: { patientId: patientRow.id, status: { in: ['COMPLETED', 'CONFIRMED', 'ACCEPTED'] } },
                orderBy: { date: 'desc' },
                select: { date: true },
            });
            const lastDate = lastAppt?.date ?? null;
            if (lastDate && lastDate >= twentyOneDaysAgo) continue;
            const days = lastDate
                ? Math.floor((now.getTime() - lastDate.getTime()) / 86400000)
                : null;
            const sev = !lastDate || (lastDate && lastDate < sixtyDaysAgo) ? 'HIGH' : 'LOW';
            const doctorName = noVisitUserMap.get(j.doctorId)?.doctor?.fullName ?? '—';
            noVisitGaps.push({
                id: `${patientRow.id}::NO_RECENT_VISIT`,
                patientId: patientRow.id,
                patientName: patientRow.fullName ?? 'Unknown',
                patientAvatar: patientRow.profilePhoto ?? null,
                gapType: 'NO_RECENT_VISIT',
                severity: sev,
                detectedAt: now.toISOString(),
                detail: lastDate ? `Last visit: ${days} days ago` : 'No appointment on record',
                assignedDoctorName: doctorName,
                suggestedAction: 'Schedule a follow-up appointment',
            });
        }

        // ── Gap 2: INCOMPLETE_TRIAGE ─────────────────────────────────────────
        const triageSessions = (gapType && gapType !== 'INCOMPLETE_TRIAGE')
            ? []
            : await prisma.triageSession.findMany({
                where: {
                    createdAt: { lt: threeDaysAgo },
                    appointment: null,
                    patient: patientWhere,
                },
                select: {
                    id: true, createdAt: true,
                    patient: { select: { id: true, fullName: true, profilePhoto: true } },
                },
            });

        const incompleteTriageGaps = triageSessions.map((s) => {
            const days = Math.floor((now.getTime() - s.createdAt.getTime()) / 86400000);
            return {
                id: `${s.patient?.id ?? s.id}::INCOMPLETE_TRIAGE`,
                patientId: s.patient?.id ?? null,
                patientName: s.patient?.fullName ?? 'Unknown',
                patientAvatar: s.patient?.profilePhoto ?? null,
                gapType: 'INCOMPLETE_TRIAGE',
                severity: 'LOW',
                detectedAt: s.createdAt.toISOString(),
                detail: `Triage started ${days} days ago, never booked`,
                assignedDoctorName: '—',
                suggestedAction: 'Reach out to complete intake',
            };
        });

        // ── Gap 3: LOW_ADHERENCE ─────────────────────────────────────────────
        let lowAdherenceGaps = [];
        if (!gapType || gapType === 'LOW_ADHERENCE') {
            const activeRx = await prisma.prescription.findMany({
                where: { totalQuantity: { gt: 0 }, patient: patientWhere },
                select: {
                    id: true, patientId: true,
                    patient: { select: { id: true, fullName: true, profilePhoto: true } },
                },
            });
            const byPatient = new Map();
            for (const r of activeRx) {
                if (!byPatient.has(r.patientId)) {
                    byPatient.set(r.patientId, { patient: r.patient, rxIds: [] });
                }
                byPatient.get(r.patientId).rxIds.push(r.id);
            }
            for (const [pid, { patient, rxIds }] of byPatient) {
                const logs = await prisma.medicationLog.findMany({
                    where: { prescriptionId: { in: rxIds }, taken: true, takenAt: { gte: sevenDaysAgo } },
                    select: { takenAt: true },
                });
                const uniqueDays = new Set(logs.map((l) => l.takenAt.toISOString().split('T')[0])).size;
                const rate = (uniqueDays / 7) * 100;
                if (rate >= 60) continue;
                lowAdherenceGaps.push({
                    id: `${pid}::LOW_ADHERENCE`,
                    patientId: pid,
                    patientName: patient?.fullName ?? 'Unknown',
                    patientAvatar: patient?.profilePhoto ?? null,
                    gapType: 'LOW_ADHERENCE',
                    severity: 'MEDIUM',
                    detectedAt: now.toISOString(),
                    detail: `Adherence ${Math.round(rate)}% over last 7 days`,
                    assignedDoctorName: '—',
                    suggestedAction: 'Call patient to reinforce medication plan',
                });
            }
        }

        // ── Gap 4: WELLNESS_DECLINE ──────────────────────────────────────────
        let wellnessGaps = [];
        if (!gapType || gapType === 'WELLNESS_DECLINE') {
            const activeJourneys2 = await prisma.treatmentJourney.findMany({
                where: { status: 'ACTIVE', ...(branchId ? { branchId } : {}) },
                select: { id: true, patientId: true, doctorId: true, title: true },
            });
            const wellUserMap = await bulkResolve(
                activeJourneys2.map((j) => j.patientId).concat(activeJourneys2.map((j) => j.doctorId)),
            );
            for (const j of activeJourneys2) {
                const userInfo = wellUserMap.get(j.patientId);
                const patientRow = userInfo?.patient;
                if (!patientRow) continue;
                const vitals = await prisma.patientVital.findMany({
                    where: { journeyId: j.id, type: 'PAIN_SCORE' },
                    orderBy: { recordedAt: 'desc' },
                    take: 14,
                });
                if (vitals.length < 2) continue;
                const recent = vitals.slice(0, 3);
                const older = vitals.filter((v) => v.recordedAt < sevenDaysAgo).slice(0, 3);
                if (older.length === 0) continue;
                const recentAvg = recent.reduce((s, v) => s + v.value, 0) / recent.length;
                const olderAvg = older.reduce((s, v) => s + v.value, 0) / older.length;
                if (recentAvg - olderAvg <= 2) continue;
                wellnessGaps.push({
                    id: `${patientRow.id}::WELLNESS_DECLINE`,
                    patientId: patientRow.id,
                    patientName: patientRow.fullName ?? 'Unknown',
                    patientAvatar: patientRow.profilePhoto ?? null,
                    gapType: 'WELLNESS_DECLINE',
                    severity: 'HIGH',
                    detectedAt: now.toISOString(),
                    detail: `Pain rose ${(recentAvg - olderAvg).toFixed(1)} pts in 7 days`,
                    assignedDoctorName: wellUserMap.get(j.doctorId)?.doctor?.fullName ?? '—',
                    suggestedAction: 'Review treatment plan urgently',
                });
            }
        }

        // ── Gap 5: OVERDUE_PHASE ─────────────────────────────────────────────
        let overdueGaps = [];
        if (!gapType || gapType === 'OVERDUE_PHASE') {
            const phases = await prisma.journeyPhase.findMany({
                where: { status: 'ACTIVE', startedAt: { not: null } },
                include: {
                    journey: { select: { id: true, patientId: true, doctorId: true, branchId: true, status: true } },
                },
            });
            const filteredPhases = phases.filter(
                (ph) => ph.journey.status === 'ACTIVE' && (!branchId || ph.journey.branchId === branchId),
            );
            const phaseUserMap = await bulkResolve(
                filteredPhases.map((ph) => ph.journey.patientId).concat(filteredPhases.map((ph) => ph.journey.doctorId)),
            );
            for (const ph of filteredPhases) {
                const userInfo = phaseUserMap.get(ph.journey.patientId);
                const patientRow = userInfo?.patient;
                if (!patientRow) continue;
                const expectedEnd = new Date(ph.startedAt);
                expectedEnd.setDate(expectedEnd.getDate() + ph.durationDays);
                if (now <= expectedEnd) continue;
                const overdueDays = Math.floor((now.getTime() - expectedEnd.getTime()) / 86400000);
                overdueGaps.push({
                    id: `${patientRow.id}::OVERDUE_PHASE::${ph.id}`,
                    patientId: patientRow.id,
                    patientName: patientRow.fullName ?? 'Unknown',
                    patientAvatar: patientRow.profilePhoto ?? null,
                    gapType: 'OVERDUE_PHASE',
                    severity: 'MEDIUM',
                    detectedAt: now.toISOString(),
                    detail: `Phase "${ph.name}" overdue by ${overdueDays} days`,
                    assignedDoctorName: phaseUserMap.get(ph.journey.doctorId)?.doctor?.fullName ?? '—',
                    suggestedAction: 'Advance the phase or extend the plan',
                });
            }
        }

        // Merge + filter
        let allGaps = [
            ...noVisitGaps,
            ...incompleteTriageGaps,
            ...lowAdherenceGaps,
            ...wellnessGaps,
            ...overdueGaps,
        ];
        if (severity) allGaps = allGaps.filter((g) => g.severity === severity);

        // Severity ordering: HIGH > MEDIUM > LOW.
        const sevOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
        allGaps.sort((a, b) => (sevOrder[a.severity] - sevOrder[b.severity]) || a.patientName.localeCompare(b.patientName));

        const total = allGaps.length;
        const totalPages = Math.max(1, Math.ceil(total / take));
        const skip = (currentPage - 1) * take;
        const pageItems = allGaps.slice(skip, skip + take);

        const summary = {
            totalGaps: total,
            highSeverity: allGaps.filter((g) => g.severity === 'HIGH').length,
            mediumSeverity: allGaps.filter((g) => g.severity === 'MEDIUM').length,
            lowSeverity: allGaps.filter((g) => g.severity === 'LOW').length,
            byType: {
                NO_RECENT_VISIT: allGaps.filter((g) => g.gapType === 'NO_RECENT_VISIT').length,
                INCOMPLETE_TRIAGE: allGaps.filter((g) => g.gapType === 'INCOMPLETE_TRIAGE').length,
                LOW_ADHERENCE: allGaps.filter((g) => g.gapType === 'LOW_ADHERENCE').length,
                WELLNESS_DECLINE: allGaps.filter((g) => g.gapType === 'WELLNESS_DECLINE').length,
                OVERDUE_PHASE: allGaps.filter((g) => g.gapType === 'OVERDUE_PHASE').length,
            },
        };

        return {
            summary,
            gaps: pageItems,
            pagination: { page: currentPage, limit: take, total, totalPages },
        };
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
