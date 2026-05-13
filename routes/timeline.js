import express from 'express';
import { TimelineService } from '../services/timeline.service.js';
import { EnhancedDashboardService } from '../services/enhancedDashboard.service.js';
import { ClinicianXPService } from '../services/clinicianXP.service.js';
import { cacheService } from '../services/cache.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

const router = express.Router();

/**
 * GET /api/patients/:id/timeline
 * Accessible by: ADMIN, ADMIN_DOCTOR, DOCTOR, THERAPIST (clinicians viewing a patient)
 *                and PATIENT themselves (own timeline)
 * Query params: from (ISO date), to (ISO date)
 */
router.get('/:id/timeline', authMiddleware, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { from, to } = req.query;
        const { user } = req;

        // If the requester is a patient, they can only see their own timeline
        if (user.role === 'PATIENT') {
            const patientRecord = await prisma.patient.findUnique({
                where: { userId: user.id },
                select: { id: true },
            });
            if (!patientRecord || patientRecord.id !== id) {
                return res.status(403).json({ error: 'Access denied' });
            }
        }

        const events = await TimelineService.getTimeline(id, { from, to });
        res.json({ patientId: id, total: events.length, events });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/patients/:id/pain-map
 * Latest pain-region snapshot for a patient — sourced from the most recent
 * DailyCheckIn that has a body-map array, falling back to the latest
 * TriageSession. Returns the same shape as /api/patient/dashboard/last-pain-regions
 * so the same BodyMapPainSelector component can render either side.
 *
 * Accessible by: ADMIN, ADMIN_DOCTOR, DOCTOR, THERAPIST, BRANCH_ADMIN, PHARMACIST
 *                and the PATIENT themselves.
 */
router.get(
    '/:id/pain-map',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'BRANCH_ADMIN', 'PHARMACIST', 'SUPER_ADMIN', 'PATIENT']),
    async (req, res, next) => {
        try {
            const { id } = req.params;
            const { user } = req;

            // PATIENT may only read their own snapshot.
            if (user.role === 'PATIENT') {
                const patientRecord = await prisma.patient.findUnique({
                    where: { userId: user.id },
                    select: { id: true },
                });
                if (!patientRecord || patientRecord.id !== id) {
                    return res.status(403).json({ error: 'Access denied' });
                }
            }

            const result = await EnhancedDashboardService.getLastPainRegions(id);
            res.json(result);
        } catch (err) {
            next(err);
        }
    },
);

/**
 * POST /api/patients/:patientId/record-review
 *
 * Awards XP to a clinician who has spent meaningful time reviewing a patient
 * record. Anti-spam:
 *   • duration floor: ≥60s (anything shorter is treated as a tab-skim)
 *   • per-day rate limit: one award per (doctor, patient, calendar day)
 *     keyed in Redis with 24h TTL
 *
 * ADMIN_DOCTOR is allowed to call (and is rate-limited the same way) but
 * ClinicianXPService.awardXP is a no-op for that role — they are oversight,
 * not participants. We still return 200 with the rate-limit + duration verdict
 * so the frontend toast is consistent.
 */
/**
 * GET /api/patients/my-patients
 *
 * Paginated patient roster for the clinician's "My Patients" page.
 *   - DOCTOR: patients assigned via PatientAssignment (status === ACTIVE).
 *   - ADMIN_DOCTOR: all patients in the caller's branch.
 *
 * Search: substring match on Patient.fullName + Patient.patientId.
 * Response shape matches the MyPatientsAdminView frontend contract:
 *   { data: { patients: PatientSummary[], pagination: {...} } }
 */
router.get('/my-patients', authMiddleware, roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const { user } = req;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const skip = (page - 1) * limit;
        const search = (req.query.search || '').toString().trim();

        const where = {};

        if (user.role === 'DOCTOR') {
            // No Doctor row → empty list (avoid leaking everyone via an
            // unscoped fallback).
            const doctor = await prisma.doctor.findUnique({
                where: { userId: user.id },
                select: { id: true },
            });
            if (!doctor) {
                return res.json({
                    data: {
                        patients: [],
                        pagination: { page, limit, total: 0, totalPages: 1 },
                    },
                });
            }
            where.patientAssignments = {
                some: { doctorId: doctor.id, status: 'ACTIVE' },
            };
        } else if (user.role === 'ADMIN_DOCTOR') {
            if (user.branchId) where.branchId = user.branchId;
        }

        if (search) {
            where.OR = [
                { fullName: { contains: search, mode: 'insensitive' } },
                { patientId: { contains: search, mode: 'insensitive' } },
            ];
        }

        const [rows, total] = await Promise.all([
            prisma.patient.findMany({
                where,
                select: {
                    id: true,
                    fullName: true,
                    patientId: true,
                    profilePhoto: true,
                    gender: true,
                    age: true,
                    dob: true,
                    appointments: {
                        select: { date: true },
                        orderBy: { date: 'desc' },
                        take: 1,
                    },
                    patientAssignments: {
                        where: { status: 'ACTIVE' },
                        select: { doctor: { select: { fullName: true } } },
                        orderBy: { assignedAt: 'desc' },
                        take: 1,
                    },
                    dailyCheckIns: {
                        select: { painLevel: true },
                        orderBy: { createdAt: 'desc' },
                        take: 1,
                    },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.patient.count({ where }),
        ]);

        const now = Date.now();
        const patients = rows.map((p) => {
            const lastIso = p.appointments[0]?.date ?? null;
            const daysSince = lastIso
                ? Math.floor((now - new Date(lastIso).getTime()) / 86_400_000)
                : null;
            // Patient is "active" if they had an appointment in the last 90 days.
            const isActive = daysSince != null && daysSince <= 90;
            const computedAge = p.age ?? (p.dob
                ? Math.floor((now - new Date(p.dob).getTime()) / (365.25 * 86_400_000))
                : null);
            // Map painLevel (0-10) to a wellness percentage (10 → 0, 0 → 100)
            // so the card's bar reflects the patient's most recent self-report.
            const wellnessScore = p.dailyCheckIns[0]
                ? Math.max(0, Math.min(100, 100 - (p.dailyCheckIns[0].painLevel || 0) * 10))
                : null;
            return {
                id: p.id,
                fullName: p.fullName,
                patientId: p.patientId,
                profilePhoto: p.profilePhoto,
                gender: p.gender,
                age: computedAge,
                assignedDoctorName: p.patientAssignments[0]?.doctor?.fullName ?? null,
                lastAppointmentDate: lastIso,
                daysSinceLastAppointment: daysSince,
                isActive,
                wellnessScore,
            };
        });

        res.json({
            data: {
                patients,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.max(1, Math.ceil(total / limit)),
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/patients/:patientId/full-details
 *
 * Aggregate snapshot for the right-side vitals drawer on My Patients.
 * Returns demographics, recent vitals/check-ins, active prescriptions,
 * active diet plan, current treatment journey, last + upcoming appointment,
 * computed wellness trend, and the primary assigned doctor.
 *
 * Accessible by: ADMIN, ADMIN_DOCTOR, DOCTOR, THERAPIST.
 */
router.get(
    '/:patientId/full-details',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']),
    async (req, res, next) => {
        try {
            const { patientId } = req.params;

            const patient = await prisma.patient.findUnique({
                where: { id: patientId },
                select: {
                    id: true,
                    userId: true,
                    fullName: true,
                    patientId: true,
                    phoneNumber: true,
                    dob: true,
                    gender: true,
                    profilePhoto: true,
                    user: { select: { email: true } },
                },
            });

            if (!patient) {
                return res.status(404).json({ error: 'Patient not found' });
            }

            const now = new Date();

            const [
                vitals,
                dailyCheckIns,
                activePrescriptions,
                activeDietPrescription,
                treatmentJourney,
                lastAppointment,
                upcomingAppointment,
                assignment,
            ] = await Promise.all([
                prisma.patientVital.findMany({
                    where: { patientId },
                    orderBy: { recordedAt: 'desc' },
                    take: 4,
                    select: { type: true, value: true, unit: true, recordedAt: true },
                }),
                prisma.dailyCheckIn.findMany({
                    where: { patientId },
                    orderBy: { createdAt: 'desc' },
                    take: 7,
                    select: { id: true, painLevel: true, mood: true, sleepHours: true, createdAt: true },
                }),
                prisma.prescription.findMany({
                    where: { patientId, discontinuedAt: null },
                    orderBy: { createdAt: 'desc' },
                    take: 20,
                    select: { id: true, medicationName: true, dosage: true, frequency: true, duration: true },
                }),
                prisma.dietPrescription.findFirst({
                    where: { patientId, isActive: true },
                    orderBy: { createdAt: 'desc' },
                    select: { id: true, title: true, doshaTarget: true, isActive: true },
                }).catch(() => null),
                // TreatmentJourney.patientId is User.id, not Patient.id —
                // join via the patient's userId we already fetched above.
                prisma.treatmentJourney.findFirst({
                    where: { patientId: patient.userId, status: 'ACTIVE' },
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        title: true,
                        condition: true,
                        wellnessScore: true,
                        phases: {
                            select: { name: true, status: true, order: true },
                            orderBy: { order: 'asc' },
                        },
                    },
                }).catch(() => null),
                prisma.appointment.findFirst({
                    where: { patientId, date: { lt: now } },
                    orderBy: { date: 'desc' },
                    select: {
                        id: true, date: true, status: true, notes: true,
                        doctor: { select: { fullName: true } },
                    },
                }),
                prisma.appointment.findFirst({
                    where: {
                        patientId,
                        date: { gte: now },
                        status: { in: ['PENDING', 'SCHEDULED', 'CONFIRMED', 'ACCEPTED'] },
                    },
                    orderBy: { date: 'asc' },
                    select: {
                        id: true, date: true, status: true, consultationType: true,
                        doctor: { select: { fullName: true } },
                    },
                }),
                prisma.patientAssignment.findFirst({
                    where: { patientId, status: 'ACTIVE' },
                    orderBy: { assignedAt: 'desc' },
                    select: {
                        doctor: { select: { id: true, fullName: true, specialization: true } },
                    },
                }),
            ]);

            // Wellness trend — compare first half vs second half of recent
            // check-ins. Pain inverted to a 0-100 wellness score (painLevel 0
            // → 100, painLevel 10 → 0) so a falling pain score reads as
            // "improving" to the patient.
            const last = dailyCheckIns.slice().reverse().map((c) => 100 - (c.painLevel || 0) * 10);
            let trend = 'stable';
            if (last.length >= 4) {
                const half = Math.floor(last.length / 2);
                const firstAvg = last.slice(0, half).reduce((a, b) => a + b, 0) / half;
                const secondAvg = last.slice(half).reduce((a, b) => a + b, 0) / (last.length - half);
                if (secondAvg - firstAvg >= 5) trend = 'improving';
                else if (firstAvg - secondAvg >= 5) trend = 'declining';
            }
            const currentWellness = last.length > 0 ? last[last.length - 1] : null;

            // Compute journey progress as completed-phase fraction so the
            // drawer can render the existing progress bar without changes.
            let journeyOut = null;
            if (treatmentJourney) {
                const totalPhases = treatmentJourney.phases.length;
                const completedPhases = treatmentJourney.phases.filter((p) => p.status === 'COMPLETED').length;
                const currentPhase = treatmentJourney.phases.find((p) => p.status === 'ACTIVE')?.name
                    ?? treatmentJourney.phases.find((p) => p.status === 'UPCOMING')?.name
                    ?? null;
                journeyOut = {
                    id: treatmentJourney.id,
                    title: treatmentJourney.title,
                    condition: treatmentJourney.condition,
                    currentPhase,
                    progress: totalPhases > 0 ? Math.round((completedPhases / totalPhases) * 100) : 0,
                    wellnessScore: treatmentJourney.wellnessScore,
                };
            }

            res.json({
                data: {
                    patient: {
                        id: patient.id,
                        name: patient.fullName,
                        patientId: patient.patientId,
                        email: patient.user?.email ?? null,
                        phone: patient.phoneNumber,
                        dob: patient.dob,
                        gender: patient.gender,
                        // Blood group + free-text address aren't first-class
                        // columns on Patient — surface null so the drawer's
                        // "—" fallback renders cleanly.
                        bloodGroup: null,
                        profilePhoto: patient.profilePhoto,
                        address: null,
                    },
                    vitals,
                    dailyCheckIns,
                    activePrescriptions,
                    activeDietPrescription,
                    treatmentJourney: journeyOut,
                    lastAppointment,
                    upcomingAppointment,
                    wellnessScore: { current: currentWellness, trend },
                    assignedDoctor: assignment?.doctor ?? null,
                },
            });
        } catch (err) {
            next(err);
        }
    },
);

router.post('/:patientId/record-review', authMiddleware, roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const { patientId } = req.params;
        const durationSeconds = Number(req.body?.durationSeconds);
        if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
            return res.status(400).json({ error: 'durationSeconds (number) is required' });
        }

        if (durationSeconds < 60) {
            return res.json({
                xpAwarded: 0,
                tooShort: true,
                message: 'Spend at least 1 minute reviewing the record to earn XP.',
            });
        }

        // Daily rate limit. Falls open when Redis is unavailable so a
        // degraded cache layer never silently drops legit XP.
        const today = new Date().toISOString().slice(0, 10);
        const rateKey = `review_xp:${req.user.id}:${patientId}:${today}`;
        try {
            const seen = await cacheService.get(rateKey);
            if (seen) {
                return res.json({
                    alreadyAwarded: true,
                    message: 'XP already awarded for reviewing this patient today',
                });
            }
        } catch (err) {
            logger.warn('[record-review] cache read failed, falling open', { err: err.message });
        }

        const xpAmount = ClinicianXPService.XP_ACTIONS.PATIENT_REVIEW;
        const ledger = await ClinicianXPService.awardXP(
            req.user.id,
            'PATIENT_REVIEW',
            xpAmount,
            patientId,
            { durationSeconds },
        );

        // awardXP returns null for ADMIN_DOCTOR (excluded from XP pipeline).
        // Still set the rate-limit key so they can't poll the endpoint.
        try {
            await cacheService.set(rateKey, '1', 24 * 60 * 60);
        } catch (err) {
            logger.warn('[record-review] cache write failed', { err: err.message });
        }

        if (!ledger) {
            return res.json({
                xpAwarded: 0,
                excludedRole: true,
                message: 'XP not granted (oversight role excluded from the XP pipeline).',
            });
        }

        const profile = await prisma.clinicianXP.findUnique({
            where: { userId: req.user.id },
            select: { totalXP: true },
        });

        res.json({
            xpAwarded: xpAmount,
            totalXP: profile?.totalXP ?? xpAmount,
            message: 'XP awarded for patient review',
        });
    } catch (err) {
        next(err);
    }
});

export default router;
