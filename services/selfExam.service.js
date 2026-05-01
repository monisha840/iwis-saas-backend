import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';
import {
    DEFAULT_ZONE_PROTOCOLS,
    ZONE_PROTOCOLS,
    zonesFromPainRegions,
    buildChecklist,
    computeCompletion,
    loadProtocolsForHospital,
} from './selfExam.protocol.js';

// Child rows preloaded on every submission read so callers always have the
// full bundle (the Vaidya's view needs everything at once).
const FULL_INCLUDE = {
    symptomHistory:       { orderBy: { createdAt: 'asc' } },
    tongueObservations:   { orderBy: { dayIndex: 'asc' } },
    stoolLogs:            { orderBy: { dayIndex: 'asc' } },
    urineLogs:            { orderBy: { dayIndex: 'asc' } },
    romMeasurements:      { orderBy: [{ joint: 'asc' }, { direction: 'asc' }] },
    physicalObservations: { orderBy: { createdAt: 'asc' } },
    voiceObservations:    { orderBy: { dayIndex: 'asc' } },
    digestiveProfile:     true,
    lifestyleContext:     true,
};

async function loadPatientContext(userId) {
    const patient = await prisma.patient.findUnique({
        where: { userId },
        include: { user: { select: { hospitalId: true } } },
    });
    if (!patient) {
        const err = new Error('Patient profile not found');
        err.status = 404;
        throw err;
    }
    return patient;
}

async function ensureOwnSubmission(submissionId, userId) {
    const submission = await prisma.selfExamSubmission.findUnique({
        where: { id: submissionId },
        include: { patient: { select: { userId: true } } },
    });
    if (!submission) {
        const err = new Error('Self-exam submission not found');
        err.status = 404;
        throw err;
    }
    if (submission.patient.userId !== userId) {
        const err = new Error('Not your self-exam submission');
        err.status = 403;
        throw err;
    }
    if (submission.status !== 'DRAFT') {
        const err = new Error('Submission already finalised');
        err.status = 409;
        throw err;
    }
    return submission;
}

export const SelfExamService = {
    /**
     * Auto-initialise a DRAFT submission from a newly created TriageSession.
     * Non-blocking caller contract — any exception is swallowed by the caller
     * via `.catch()` so triage submit never fails because of this.
     */
    async initFromTriage(triageSessionId) {
        const session = await prisma.triageSession.findUnique({
            where: { id: triageSessionId },
            include: {
                patient: { include: { user: { select: { hospitalId: true } } } },
            },
        });
        if (!session) return null;

        // Pre-consultation kit is created whenever the patient marked at
        // least one body region that maps to a canonical PainZone. The
        // urgency level no longer gates this — even ROUTINE / MODERATE
        // triages benefit from observation logs (tongue, stool, ROM, etc.)
        // attached to the appointment, and the patient can always skip a
        // test they don't want to do. Without a DRAFT here, the post-
        // booking kit-intro screen has nothing to render.
        const zones = zonesFromPainRegions(session.painRegions);
        if (zones.length === 0) {
            logger.info(
                `[SelfExam] Skipping init — no mappable zones on triage ${triageSessionId} (urgencyLevel=${session.urgencyLevel ?? 'null'})`
            );
            return null;
        }

        // Idempotent: if a submission already exists for this triage, reuse it.
        const existing = await prisma.selfExamSubmission.findUnique({
            where: { triageSessionId },
            include: FULL_INCLUDE,
        });
        if (existing) return existing;

        return prisma.selfExamSubmission.create({
            data: {
                triageSessionId,
                patientId: session.patientId,
                branchId: session.branchId,
                hospitalId: session.patient?.user?.hospitalId ?? null,
                painZones: zones,
                status: 'DRAFT',
            },
            include: FULL_INCLUDE,
        });
    },

    async createManual(userId, { zones, appointmentId }) {
        if (!Array.isArray(zones) || zones.length === 0) {
            const err = new Error('At least one pain zone is required');
            err.status = 400;
            throw err;
        }
        const unknown = zones.find((z) => !ZONE_PROTOCOLS[z]);
        if (unknown) {
            const err = new Error(`Unknown pain zone: ${unknown}`);
            err.status = 400;
            throw err;
        }
        const patient = await loadPatientContext(userId);
        return prisma.selfExamSubmission.create({
            data: {
                patientId: patient.id,
                branchId: patient.branchId,
                hospitalId: patient.user?.hospitalId ?? null,
                appointmentId: appointmentId || null,
                painZones: zones,
                status: 'DRAFT',
            },
            include: FULL_INCLUDE,
        });
    },

    async get(submissionId, userId, role) {
        const submission = await prisma.selfExamSubmission.findUnique({
            where: { id: submissionId },
            include: {
                ...FULL_INCLUDE,
                patient: { select: { userId: true, fullName: true, id: true } },
            },
        });
        if (!submission) {
            const err = new Error('Self-exam submission not found');
            err.status = 404;
            throw err;
        }

        // Patients only see their own; clinicians see all within their hospital
        // (hospital-scoping is enforced by checkHospitalStatus middleware upstream).
        if (role === 'PATIENT' && submission.patient.userId !== userId) {
            const err = new Error('Not your self-exam submission');
            err.status = 403;
            throw err;
        }

        const constitution = await prisma.constitutionProfile.findUnique({
            where: { patientId: submission.patientId },
        });
        // Resolve the effective protocol for this hospital (defaults + admin
        // overrides) so any tweaks the admin made are picked up on next render.
        const protocolsByZone = await loadProtocolsForHospital(submission.hospitalId);
        const checklist = buildChecklist(submission.painZones, protocolsByZone);
        const completion = computeCompletion(
            { ...submission, _constitutionCompleted: !!constitution?.completedAt },
            checklist
        );

        return {
            submission,
            constitution,
            checklist,
            completion,
        };
    },

    async getByAppointment(appointmentId, userId, role) {
        const submission = await prisma.selfExamSubmission.findFirst({
            where: { appointmentId },
            include: {
                ...FULL_INCLUDE,
                patient: { select: { userId: true, fullName: true, id: true } },
            },
        });
        if (!submission) {
            const err = new Error('No self-exam bundle for this appointment');
            err.status = 404;
            throw err;
        }

        // Patients only see their own bundle. Clinicians are scoped upstream
        // via hospital status middleware.
        if (role === 'PATIENT' && submission.patient.userId !== userId) {
            const err = new Error('Not your self-exam submission');
            err.status = 403;
            throw err;
        }

        const constitution = await prisma.constitutionProfile.findUnique({
            where: { patientId: submission.patientId },
        });
        const protocolsByZone = await loadProtocolsForHospital(submission.hospitalId);
        const checklist = buildChecklist(submission.painZones, protocolsByZone);
        const completion = computeCompletion(
            { ...submission, _constitutionCompleted: !!constitution?.completedAt },
            checklist
        );

        return { submission, constitution, checklist, completion };
    },

    async listForPatient(userId) {
        const patient = await loadPatientContext(userId);
        return prisma.selfExamSubmission.findMany({
            where: { patientId: patient.id },
            include: FULL_INCLUDE,
            orderBy: { createdAt: 'desc' },
        });
    },

    /**
     * Role-scoped review queue.
     *
     *  - ADMIN / ADMIN_DOCTOR: every submission in their hospital. Optional
     *    `branchId` narrows the result for ops use cases.
     *  - DOCTOR: only submissions where the patient is currently ACTIVE-
     *    assigned to this doctor, OR the submission is linked to one of
     *    their appointments. Either path covers the realistic clinical
     *    relationships without leaking unrelated patients across the branch.
     *
     * Without this scoping the endpoint returned every submission across
     * every hospital — practically that meant doctors saw nothing relevant
     * mixed in with cross-tenant noise (depending on session-stored branch
     * filters), which is what surfaced as "self-exam not visible to the
     * doctor".
     */
    async listForReview({ branchId, status, user }) {
        const conditions = [];
        conditions.push(status ? { status } : { status: 'SUBMITTED' });

        if (user?.role === 'DOCTOR') {
            const doctor = await prisma.doctor.findFirst({
                where: { userId: user.id },
                select: { id: true },
            });
            // No Doctor row → return empty rather than fall through to an
            // unscoped query (which would otherwise leak the hospital list).
            if (!doctor) return [];
            conditions.push({
                OR: [
                    { patient: { patientAssignments: { some: { doctorId: doctor.id, status: 'ACTIVE' } } } },
                    { appointment: { doctorId: doctor.id } },
                ],
            });
        } else if (user?.role === 'ADMIN' || user?.role === 'ADMIN_DOCTOR') {
            // Hospital-scope. ADMINs sometimes omit hospitalId on their JWT
            // (super-admin context); leave the query unscoped in that case
            // so the page degrades gracefully.
            if (user.hospitalId) conditions.push({ hospitalId: user.hospitalId });
            if (branchId)        conditions.push({ branchId });
        } else if (branchId) {
            conditions.push({ branchId });
        }

        return prisma.selfExamSubmission.findMany({
            where: conditions.length === 1 ? conditions[0] : { AND: conditions },
            include: {
                ...FULL_INCLUDE,
                patient: {
                    select: {
                        id: true, fullName: true,
                        branchId: true,
                        branch: { select: { id: true, name: true } },
                    },
                },
                branch: { select: { id: true, name: true } },
            },
            orderBy: { submittedAt: 'desc' },
        });
    },

    // ─── Typed upserts ────────────────────────────────────────────────

    async upsertSymptomHistory(submissionId, userId, zone, payload) {
        await ensureOwnSubmission(submissionId, userId);
        return prisma.symptomHistoryEntry.upsert({
            where: { submissionId_painZone: { submissionId, painZone: zone } },
            create: { submissionId, painZone: zone, ...payload },
            update: { ...payload },
        });
    },

    async upsertTongue(submissionId, userId, dayIndex, payload) {
        const submission = await ensureOwnSubmission(submissionId, userId);
        const patient = await loadPatientContext(userId);
        return prisma.tongueObservation.upsert({
            where: { submissionId_dayIndex: { submissionId, dayIndex } },
            create: {
                submissionId,
                patientId: patient.id,
                dayIndex,
                observedOn: payload.observedOn ?? new Date(),
                ...payload,
            },
            update: { ...payload },
        });
    },

    async upsertStool(submissionId, userId, dayIndex, payload) {
        await ensureOwnSubmission(submissionId, userId);
        const patient = await loadPatientContext(userId);
        return prisma.stoolLog.upsert({
            where: { submissionId_dayIndex: { submissionId, dayIndex } },
            create: {
                submissionId,
                patientId: patient.id,
                dayIndex,
                observedOn: payload.observedOn ?? new Date(),
                ...payload,
            },
            update: { ...payload },
        });
    },

    async upsertUrine(submissionId, userId, dayIndex, payload) {
        await ensureOwnSubmission(submissionId, userId);
        const patient = await loadPatientContext(userId);
        return prisma.urineLog.upsert({
            where: { submissionId_dayIndex: { submissionId, dayIndex } },
            create: {
                submissionId,
                patientId: patient.id,
                dayIndex,
                observedOn: payload.observedOn ?? new Date(),
                ...payload,
            },
            update: { ...payload },
        });
    },

    async upsertRoM(submissionId, userId, joint, direction, payload) {
        await ensureOwnSubmission(submissionId, userId);
        return prisma.roMMeasurement.upsert({
            where: {
                submissionId_joint_direction: { submissionId, joint, direction },
            },
            create: { submissionId, joint, direction, ...payload },
            update: { ...payload },
        });
    },

    async upsertPhysical(submissionId, userId, observationType, payload) {
        await ensureOwnSubmission(submissionId, userId);
        return prisma.physicalObservation.upsert({
            where: {
                submissionId_observationType: { submissionId, observationType },
            },
            create: { submissionId, observationType, ...payload },
            update: { ...payload },
        });
    },

    async upsertVoice(submissionId, userId, dayIndex, payload) {
        await ensureOwnSubmission(submissionId, userId);
        return prisma.voiceObservation.upsert({
            where: { submissionId_dayIndex: { submissionId, dayIndex } },
            create: { submissionId, dayIndex, ...payload },
            update: { ...payload },
        });
    },

    async upsertDigestive(submissionId, userId, payload) {
        await ensureOwnSubmission(submissionId, userId);
        return prisma.digestiveProfile.upsert({
            where: { submissionId },
            create: { submissionId, ...payload },
            update: { ...payload },
        });
    },

    async upsertLifestyle(submissionId, userId, payload) {
        await ensureOwnSubmission(submissionId, userId);
        return prisma.lifestyleContext.upsert({
            where: { submissionId },
            create: { submissionId, ...payload },
            update: { ...payload },
        });
    },

    async upsertConstitution(userId, payload) {
        const patient = await loadPatientContext(userId);
        return prisma.constitutionProfile.upsert({
            where: { patientId: patient.id },
            create: {
                patientId: patient.id,
                completedAt: new Date(),
                lastUpdatedBy: userId,
                ...payload,
            },
            update: {
                completedAt: new Date(),
                lastUpdatedBy: userId,
                ...payload,
            },
        });
    },

    async getConstitution(userId) {
        const patient = await loadPatientContext(userId);
        return prisma.constitutionProfile.findUnique({
            where: { patientId: patient.id },
        });
    },

    // ─── Workflow transitions ─────────────────────────────────────────

    async submit(submissionId, userId) {
        const submission = await ensureOwnSubmission(submissionId, userId);

        // Block empty submissions — prevents triaging a blank bundle to a Vaidya.
        const completeness = await this.get(submissionId, userId, 'PATIENT');
        if (completeness.completion.completedCount === 0) {
            const err = new Error('Submission is empty — complete at least one exam first');
            err.status = 400;
            throw err;
        }

        const updated = await prisma.selfExamSubmission.update({
            where: { id: submissionId },
            data: { status: 'SUBMITTED', submittedAt: new Date() },
        });

        // Notify the specific booked doctor if the submission is linked to an
        // appointment; otherwise fall back to branch-wide DOCTOR/ADMIN_DOCTOR.
        try {
            let reviewers = null;
            if (submission.appointmentId) {
                const appt = await prisma.appointment.findUnique({
                    where: { id: submission.appointmentId },
                    select: { doctor: { select: { userId: true } } },
                });
                if (appt?.doctor?.userId) {
                    reviewers = [{ id: appt.doctor.userId }];
                }
            }
            if (!reviewers) {
                reviewers = await prisma.user.findMany({
                    where: {
                        branchId: submission.branchId,
                        role: { in: ['DOCTOR', 'ADMIN_DOCTOR'] },
                        deletedAt: null,
                    },
                    select: { id: true },
                });
            }
            const patient = await prisma.patient.findUnique({
                where: { id: submission.patientId },
                select: { fullName: true },
            });
            await Promise.all(
                reviewers.map((r) =>
                    notificationService.createNotification({
                        userId: r.id,
                        type: 'SELF_EXAM_SUBMITTED',
                        title: 'Self-exam submitted',
                        message: `${patient?.fullName || 'A patient'} has submitted their pre-consultation self-assessment (${completeness.completion.completedCount}/${completeness.completion.totalCount} exams).`,
                        priority: 'MEDIUM',
                        data: { submissionId, patientId: submission.patientId },
                    }).catch(() => {})
                )
            );
        } catch (err) {
            logger.warn('[SelfExam] reviewer notification failed', { err: err.message });
        }

        return updated;
    },

    async review(submissionId, reviewerUserId, { reviewNotes }) {
        const submission = await prisma.selfExamSubmission.findUnique({
            where: { id: submissionId },
        });
        if (!submission) {
            const err = new Error('Self-exam submission not found');
            err.status = 404;
            throw err;
        }
        if (submission.status !== 'SUBMITTED') {
            const err = new Error('Only SUBMITTED submissions can be reviewed');
            err.status = 409;
            throw err;
        }
        return prisma.selfExamSubmission.update({
            where: { id: submissionId },
            data: {
                status: 'REVIEWED',
                reviewedAt: new Date(),
                reviewedByUserId: reviewerUserId,
                reviewNotes: reviewNotes || null,
            },
        });
    },

    async attachAppointment(submissionId, userId, appointmentId) {
        await ensureOwnSubmission(submissionId, userId);
        // Verify the appointment belongs to the same patient before linking.
        const patient = await loadPatientContext(userId);
        const appointment = await prisma.appointment.findUnique({
            where: { id: appointmentId },
        });
        if (!appointment || appointment.patientId !== patient.id) {
            const err = new Error('Appointment not found or not yours');
            err.status = 404;
            throw err;
        }
        return prisma.selfExamSubmission.update({
            where: { id: submissionId },
            data: { appointmentId },
        });
    },

    // ─── Admin protocol tuning ────────────────────────────────────────
    //
    // Zone-by-zone override of the default test protocol. Absence of a row
    // = fall back to the code-level default. ADMIN / ADMIN_DOCTOR only.

    /**
     * Return the full effective protocol map for an admin's hospital:
     * { zone: { default, override, effective } }.
     * `default` + `effective` are always present; `override` is the row if
     * one exists (null otherwise). Lets the admin UI diff without a second
     * round trip.
     */
    async listProtocols(hospitalId) {
        const overrides = await prisma.selfExamProtocolOverride.findMany({
            where: { hospitalId },
            orderBy: { painZone: 'asc' },
        });
        const byZone = new Map(overrides.map((o) => [o.painZone, o]));

        const zones = Object.keys(DEFAULT_ZONE_PROTOCOLS);
        return zones.map((zone) => {
            const override = byZone.get(zone) ?? null;
            const def = DEFAULT_ZONE_PROTOCOLS[zone];
            return {
                zone,
                default: def,
                override,
                effective: override?.config ?? def,
            };
        });
    },

    async upsertProtocol(hospitalId, zone, config, userId) {
        if (!DEFAULT_ZONE_PROTOCOLS[zone]) {
            const err = new Error(`Unknown pain zone: ${zone}`);
            err.status = 400;
            throw err;
        }
        if (!config || typeof config !== 'object') {
            const err = new Error('config must be an object');
            err.status = 400;
            throw err;
        }
        return prisma.selfExamProtocolOverride.upsert({
            where: { hospitalId_painZone: { hospitalId, painZone: zone } },
            create: {
                hospitalId,
                painZone: zone,
                config,
                updatedById: userId || null,
            },
            update: {
                config,
                updatedById: userId || null,
            },
        });
    },

    async resetProtocol(hospitalId, zone) {
        if (!DEFAULT_ZONE_PROTOCOLS[zone]) {
            const err = new Error(`Unknown pain zone: ${zone}`);
            err.status = 400;
            throw err;
        }
        await prisma.selfExamProtocolOverride.deleteMany({
            where: { hospitalId, painZone: zone },
        });
        return { zone, reverted: true };
    },
};
