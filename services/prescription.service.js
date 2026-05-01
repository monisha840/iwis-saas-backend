import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import PDFDocument from 'pdfkit';
import { inventoryService } from './inventory.service.js';
import { emitToUser } from '../websocket/index.js';
import HomeTherapyService from './homeTherapy.service.js';

const includeDetails = {
    doctor: { include: { user: true } },
    therapist: { include: { user: true } },
};

// Empty-result placeholders for the search RBAC short-circuit paths.
const emptyFacets = () => ({ active: 0, discontinued: 0, withVideo: 0 });
const emptyPagination = (page, limit) => ({ total: 0, page, limit, totalPages: 1 });

export class PrescriptionService {
    static async getPatientPrescriptions(patientId, user) {
        let allowed = false;

        if (user.role === 'PATIENT') {
            const patientRecord = await prisma.patient.findUnique({ where: { userId: user.id }, select: { id: true } });
            if (patientRecord?.id === patientId) allowed = true;
        }
        if (user.role === 'DOCTOR') {
            const doctor = await prisma.doctor.findUnique({ where: { userId: user.id }, select: { id: true } });
            if (doctor) {
                const appointment = await prisma.appointment.findFirst({ where: { patientId, doctorId: doctor.id } });
                if (appointment) allowed = true;
            }
        }
        if (user.role === 'THERAPIST') {
            const therapist = await prisma.therapist.findUnique({ where: { userId: user.id }, select: { id: true } });
            if (therapist) {
                const appointment = await prisma.appointment.findFirst({ where: { patientId, therapistId: therapist.id } });
                if (appointment) allowed = true;
            }
        }

        if (!allowed && !['ADMIN', 'ADMIN_DOCTOR'].includes(user.role)) {
            const error = new Error('Access denied');
            error.status = 403;
            throw error;
        }

        return prisma.prescription.findMany({
            where: {
                patientId,
                ...(user.branchId && user.role !== 'ADMIN_DOCTOR' ? { branchId: user.branchId } : {})
            },
            include: includeDetails,
            orderBy: { createdAt: 'desc' }
        });
    }

    static async addPrescription(user, data, filename) {
        const { patientId, medicationName, dosage, frequency, duration, notes, timing, vehicle, medicineId, videoUrl, appointmentId } = data;
        const fileUrl = filename ? `/uploads/prescriptions/${filename}` : null;
        let doctorId = null, therapistId = null;
        let allowed = false;

        if (['ADMIN', 'ADMIN_DOCTOR'].includes(user.role)) {
            allowed = true;
            if (user.role === 'ADMIN_DOCTOR') {
                const doctor = await prisma.doctor.findUnique({ where: { userId: user.id }, select: { id: true } });
                if (doctor) doctorId = doctor.id;
            }
        }

        if (user.role === 'DOCTOR') {
            const doctor = await prisma.doctor.findUnique({ where: { userId: user.id }, select: { id: true } });
            if (doctor) {
                doctorId = doctor.id;
                const appointment = await prisma.appointment.findFirst({ where: { patientId, doctorId } });
                if (appointment) allowed = true;
            }
        }

        if (user.role === 'THERAPIST') {
            const therapist = await prisma.therapist.findUnique({ where: { userId: user.id }, select: { id: true } });
            if (therapist) {
                therapistId = therapist.id;
                const appointment = await prisma.appointment.findFirst({ where: { patientId, therapistId } });
                if (appointment) allowed = true;
            }
        }

        if (!allowed) {
            const error = new Error('You are not assigned to this patient');
            error.status = 403;
            throw error;
        }

        const patient = await prisma.patient.findUnique({ where: { id: patientId } });
        if (!patient) throw new Error('Patient not found');
        // Patient.branchId may be null for patients who haven't completed
        // onboarding. Fall back to the prescriber's branch so the row is
        // never silently "unbranched" — otherwise the pharmacist's
        // branch-scoped query at /api/prescriptions/search would never
        // surface it.
        const effectiveBranchId = patient.branchId || user.branchId || null;
        if (!patient.branchId) {
            logger.warn('[PrescriptionService] Patient has no branchId; using prescriber branch', {
                patientId,
                fallbackBranchId: effectiveBranchId,
            });
        }

        const prescription = await prisma.prescription.create({
            data: {
                patientId,
                doctorId,
                therapistId,
                medicineId,
                fileUrl,
                medicationName,
                dosage,
                frequency,
                duration,
                notes,
                videoUrl,
                sku: data.sku,
                branchId: effectiveBranchId,
                lowStockThreshold: data.lowStockThreshold ? parseInt(data.lowStockThreshold) : 5,
                appointmentId: appointmentId || null,
            }
        });

        // Try to update inventory-linked fields if possible
        // Note: Prescription model doesn't have timing/vehicle yet, but we can store them in 'notes' for now
        // OR we should update the schema. For now, I will stick to existing schema but enhance the service logic.
        // Actually, let's see if I can add fields to the model later.

        let stockStatus = null;
        try {
            stockStatus = await inventoryService.checkStockByMedicineName(medicationName);
        } catch (stockErr) {
            logger.warn('Real-time stock check failed:', stockErr);
        }

        return {
            ...prescription,
            stockStatus: stockStatus || { available: 'unknown', reason: 'Stock check service unavailable' }
        };
    }

    static async createBatchPrescriptions(user, patientId, medicines, { packageId = null, journey = null, homeTherapy = null } = {}) {
        let doctorId = null, therapistId = null;
        let allowed = false;

        if (['ADMIN', 'ADMIN_DOCTOR'].includes(user.role)) {
            allowed = true;
            if (user.role === 'ADMIN_DOCTOR') {
                const doctor = await prisma.doctor.findUnique({ where: { userId: user.id }, select: { id: true } });
                if (doctor) doctorId = doctor.id;
            }
        }

        if (user.role === 'DOCTOR') {
            const doctor = await prisma.doctor.findUnique({ where: { userId: user.id }, select: { id: true } });
            if (doctor) {
                doctorId = doctor.id;
                const appointment = await prisma.appointment.findFirst({ where: { patientId, doctorId } });
                if (appointment) allowed = true;
            }
        }

        if (user.role === 'THERAPIST') {
            const therapist = await prisma.therapist.findUnique({ where: { userId: user.id }, select: { id: true } });
            if (therapist) {
                therapistId = therapist.id;
                const appointment = await prisma.appointment.findFirst({ where: { patientId, therapistId } });
                if (appointment) allowed = true;
            }
        }

        if (!allowed) {
            const error = new Error('You are not assigned to this patient');
            error.status = 403;
            throw error;
        }

        const patient = await prisma.patient.findUnique({
            where: { id: patientId },
            select: { id: true, branchId: true, userId: true },
        });
        if (!patient) throw new Error('Patient not found');

        // Sanity-check the package: must exist, belong to the same branch
        // (or no patient branch), and be active. Bad ids are dropped to
        // null rather than failing the whole batch — the prescriptions
        // themselves are still useful without the package context.
        let resolvedPackageId = null;
        if (packageId) {
            const pkg = await prisma.treatmentPackage.findUnique({
                where: { id: packageId },
                select: { id: true, branchId: true, isActive: true },
            });
            if (pkg && pkg.isActive && (!patient.branchId || pkg.branchId === patient.branchId)) {
                resolvedPackageId = pkg.id;
            }
        }

        // Validate the home-therapy fragment BEFORE opening the transaction
        // so a malformed payload short-circuits with a 400 instead of
        // rolling back a half-built prescription save. Only DOCTOR and
        // ADMIN_DOCTOR may author a request — the form is hidden for
        // others, so this is a defence-in-depth check.
        if (homeTherapy) {
            if (!['DOCTOR', 'ADMIN_DOCTOR'].includes(user.role)) {
                const err = new Error('Only doctors can author a home-therapy request');
                err.status = 403;
                throw err;
            }
            HomeTherapyService.validateHomeTherapyPayload(homeTherapy);
            // Doctor.id is required to attribute the request — DOCTOR will
            // already have one from the assignment lookup above; ADMIN_DOCTOR
            // gets it from the same Doctor.findUnique-by-userId call.
            if (!doctorId) {
                const err = new Error('Could not resolve requesting doctor for home-therapy request');
                err.status = 400;
                throw err;
            }
            if (!patient.branchId) {
                const err = new Error('Patient has no branch — cannot create home-therapy request');
                err.status = 400;
                throw err;
            }
        }

        // Validate the journey payload (if any) BEFORE opening the transaction.
        // Phase durationDays must be ≥ 1 — a 0-day phase is an off-by-one bug
        // that would silently make the journey "complete" the moment it activates.
        if (journey) {
            if (!journey.title || !journey.condition || !journey.goal) {
                const err = new Error('journey.title, journey.condition, and journey.goal are required');
                err.status = 400;
                throw err;
            }
            if (!Array.isArray(journey.phases) || journey.phases.length === 0) {
                const err = new Error('journey.phases must contain at least one phase');
                err.status = 400;
                throw err;
            }
            for (const phase of journey.phases) {
                if (!phase.name || !Number.isFinite(phase.durationDays) || phase.durationDays < 1) {
                    const err = new Error('Each phase requires a name and durationDays >= 1');
                    err.status = 400;
                    throw err;
                }
                if (!Array.isArray(phase.tasks)) continue;
                for (const t of phase.tasks) {
                    if (!t.title || !t.frequency || !t.type) {
                        const err = new Error('Each task requires type, title, and frequency');
                        err.status = 400;
                        throw err;
                    }
                    if (!['MEDICATION', 'EXERCISE', 'DIET', 'THERAPY', 'LIFESTYLE'].includes(t.type)) {
                        const err = new Error(`Invalid task type: ${t.type}`);
                        err.status = 400;
                        throw err;
                    }
                    // Therapists may not author MEDICATION tasks (mirrors the journey-route guard).
                    if (user.role === 'THERAPIST' && t.type === 'MEDICATION') {
                        const err = new Error('THERAPIST_MEDICATION_RESTRICTION');
                        err.status = 403;
                        throw err;
                    }
                }
            }
        }

        // ── Atomic save: prescriptions + (optional) journey ──────────────
        // Order:
        //   1. prescription.create (one per medicine)
        //   2. treatmentJourney.create (status: ACTIVE, startDate: now)
        //   3. journeyPhase.create (loop, with durationDays)
        //   4. phaseTask.create (loop)
        //   5. prescription.update — backfill journeyId on all created rxes
        // Any throw rolls back everything.
        // Patient.branchId can be null when onboarding is incomplete. Fall
        // back to the prescriber's branch so the prescription always lands
        // in some branch's pharmacy queue — otherwise pharmacists would
        // never see it (their search filters by user.branchId).
        const effectiveBranchId = patient.branchId || user.branchId || null;
        const result = await prisma.$transaction(async (tx) => {
            const createdRxes = await Promise.all(medicines.map((med) => {
                const extendedNotes = [
                    med.notes,
                    med.timing ? `Timing: ${med.timing}` : null,
                    med.vehicle ? `Anupana (Vehicle): ${med.vehicle}` : null,
                ].filter(Boolean).join(' | ');

                return tx.prescription.create({
                    data: {
                        patientId,
                        doctorId,
                        therapistId,
                        medicineId: med.medicineId,
                        medicationName: med.medicationName,
                        dosage: med.dosage,
                        frequency: med.frequency,
                        duration: med.duration,
                        notes: extendedNotes,
                        videoUrl: med.videoUrl,
                        sku: med.sku,
                        branchId: effectiveBranchId,
                        lowStockThreshold: med.lowStockThreshold || 5,
                        packageId: resolvedPackageId,
                    },
                });
            }));

            // Home-therapy referral. Linked to the FIRST prescription in
            // this batch — same patient + branch context, and a single
            // approval queue entry per save.
            let homeTherapyRequest = null;
            if (homeTherapy) {
                homeTherapyRequest = await HomeTherapyService.createRequestInTx(tx, {
                    prescriptionId: createdRxes[0].id,
                    patientId,
                    requestingDoctorId: doctorId,
                    branchId: patient.branchId,
                    payload: homeTherapy,
                });
            }

            if (!journey) return { prescriptions: createdRxes, journey: null, homeTherapyRequest };

            // TreatmentJourney requires a User.id for doctorId. The patient's
            // User.id is patient.userId; the clinician's User.id is user.id.
            const journeyRow = await tx.treatmentJourney.create({
                data: {
                    patientId: patient.userId,
                    doctorId:  user.id,
                    branchId:  patient.branchId || (await tx.user.findUnique({
                        where: { id: user.id }, select: { branchId: true },
                    }))?.branchId,
                    title:     journey.title,
                    condition: journey.condition,
                    targetDate: journey.targetEndDate ? new Date(journey.targetEndDate) : null,
                    status:    'ACTIVE',
                    startDate: new Date(),
                },
            });

            // Phases — first phase auto-activates so the journey starts immediately.
            for (let i = 0; i < journey.phases.length; i++) {
                const phase = journey.phases[i];
                const phaseRow = await tx.journeyPhase.create({
                    data: {
                        journeyId:    journeyRow.id,
                        name:         phase.name,
                        order:        i,
                        durationDays: phase.durationDays,
                        status:       i === 0 ? 'ACTIVE' : 'UPCOMING',
                        startedAt:    i === 0 ? new Date() : null,
                    },
                });
                if (Array.isArray(phase.tasks)) {
                    for (const task of phase.tasks) {
                        await tx.phaseTask.create({
                            data: {
                                phaseId:     phaseRow.id,
                                type:        task.type,
                                title:       task.title,
                                description: task.description || null,
                                frequency:   task.frequency,
                            },
                        });
                    }
                }
            }

            // Backfill journeyId on every prescription in this batch.
            await tx.prescription.updateMany({
                where: { id: { in: createdRxes.map((r) => r.id) } },
                data:  { journeyId: journeyRow.id },
            });

            const totalDays = journey.phases.reduce((s, p) => s + p.durationDays, 0);
            return {
                prescriptions: createdRxes.map((r) => ({ ...r, journeyId: journeyRow.id })),
                journey: { id: journeyRow.id, title: journeyRow.title, totalDays },
                homeTherapyRequest,
            };
        });

        // Post-commit side effects: real-time fanout to the patient socket.
        if (result.journey && patient.userId) {
            try {
                emitToUser(patient.userId, 'journey_assigned', {
                    journeyId: result.journey.id,
                    title:     result.journey.title,
                    totalDays: result.journey.totalDays,
                });
            } catch (err) {
                logger.warn('[PrescriptionService] journey_assigned emit failed', { err: err.message });
            }
        }

        // Home-therapy approval queue: notify admins / admin-doctors / branch
        // admins so the dashboard surfaces a "New" badge in real time.
        if (result.homeTherapyRequest) {
            HomeTherapyService.emitRequestCreated(result.homeTherapyRequest);
        }

        // Existing callers consume the prescriptions array directly. The
        // homeTherapyRequest is attached as a non-array property so old
        // call sites (which expect an array) keep working: arrays accept
        // arbitrary properties without breaking iteration.
        const out = result.prescriptions;
        if (result.homeTherapyRequest) {
            Object.defineProperty(out, 'homeTherapyRequest', {
                value: result.homeTherapyRequest,
                enumerable: true,
            });
        }
        return out;
    }

    static async viewAnyPatientPrescriptions(patientId) {
        return prisma.prescription.findMany({
            where: { patientId },
            include: includeDetails,
            orderBy: { createdAt: 'desc' }
        });
    }

    /**
     * Advanced prescription search for the pharmacy verification queue
     * + clinician dashboards. Combines text search across medication
     * name / SKU / patient name with status (active / discontinued /
     * fully-dispensed), date range, prescriber, and a hasVideo toggle.
     * Returns a paginated envelope plus facet counts.
     *
     * RBAC scoping:
     *   - PATIENT: limited to own prescriptions (patientId derived from user).
     *   - DOCTOR / THERAPIST: own-prescribed only (doctor.userId or therapist.userId match).
     *   - ADMIN_DOCTOR / ADMIN / PHARMACIST: hospital scope (via branchId).
     *
     * Filter contract:
     *   q              — substring match on medicationName, sku, patient.fullName
     *   status         — ACTIVE | DISCONTINUED | FULLY_DISPENSED | OUT_OF_SUPPLY
     *   patientId      — Patient.id (admin/clinician use)
     *   prescriberId   — User.id of prescribing doctor or therapist
     *   medicineId     — exact Medicine.id
     *   hasVideo       — boolean
     *   branchId       — restricts to a specific branch
     *   dateFrom/To    — ISO date strings (createdAt range)
     *   sortBy         — createdAt | medicationName | totalQuantity
     *   sortOrder      — asc | desc
     *   page / limit   — pagination (default 1 / 20, max 100)
     */
    static async searchPrescriptions(user, filters = {}) {
        const {
            q, status, patientId, prescriberId, medicineId, hasVideo,
            branchId, dateFrom, dateTo,
            sortBy = 'createdAt', sortOrder = 'desc',
            page = 1, limit = 20,
        } = filters;

        const pageInt = Math.max(1, parseInt(page, 10) || 1);
        const limitInt = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

        const where = {};

        // RBAC scoping ------------------------------------------------
        if (user.role === 'PATIENT') {
            const patientRecord = await prisma.patient.findUnique({
                where: { userId: user.id }, select: { id: true },
            });
            if (!patientRecord) {
                return { prescriptions: [], facets: emptyFacets(), pagination: emptyPagination(pageInt, limitInt) };
            }
            where.patientId = patientRecord.id;
        } else if (user.role === 'DOCTOR') {
            const doctor = await prisma.doctor.findUnique({ where: { userId: user.id }, select: { id: true } });
            if (doctor) where.doctorId = doctor.id;
            else where.id = '__none__'; // no doctor profile → no results
        } else if (user.role === 'THERAPIST') {
            const therapist = await prisma.therapist.findUnique({ where: { userId: user.id }, select: { id: true } });
            if (therapist) where.therapistId = therapist.id;
            else where.id = '__none__';
        } else if (user.role === 'PHARMACIST' || user.role === 'ADMIN_DOCTOR' || user.role === 'ADMIN') {
            // Branch-scoped staff fall back to their own branch unless
            // an explicit branchId was passed (admin-doctor cross-branch).
            if (user.branchId) where.branchId = user.branchId;
        }

        // Caller-supplied scope overrides (admins only)
        if (branchId && (user.role === 'ADMIN' || user.role === 'ADMIN_DOCTOR')) {
            where.branchId = branchId;
        }
        if (patientId) where.patientId = patientId;
        if (medicineId) where.medicineId = medicineId;

        if (prescriberId) {
            // Match either doctor or therapist user.id
            where.OR = [
                { doctor: { userId: prescriberId } },
                { therapist: { userId: prescriberId } },
            ];
        }

        if (q && q.trim()) {
            const term = q.trim();
            const textOr = [
                { medicationName: { contains: term, mode: 'insensitive' } },
                { sku:            { contains: term, mode: 'insensitive' } },
                { patient: { fullName: { contains: term, mode: 'insensitive' } } },
                { medicine: { name: { contains: term, mode: 'insensitive' } } },
            ];
            // Merge with any existing OR (prescriberId) — combine via AND
            if (where.OR) {
                where.AND = [{ OR: where.OR }, { OR: textOr }];
                delete where.OR;
            } else {
                where.OR = textOr;
            }
        }

        if (hasVideo === true || hasVideo === 'true') where.videoUrl = { not: null };

        if (status === 'DISCONTINUED') where.discontinuedAt = { not: null };
        if (status === 'ACTIVE') where.discontinuedAt = null;
        if (status === 'FULLY_DISPENSED') {
            // Active and fully dispensed (rare clinical state — usually
            // means the patient finished the course).
            where.discontinuedAt = null;
            where.AND = [...(where.AND || []), { dispensedQty: { gt: 0 } }];
        }
        if (status === 'OUT_OF_SUPPLY') {
            where.discontinuedAt = null;
            where.totalQuantity = { lte: 0 };
        }

        if (dateFrom || dateTo) {
            where.createdAt = {};
            if (dateFrom) where.createdAt.gte = new Date(dateFrom);
            if (dateTo)   where.createdAt.lte = new Date(dateTo);
        }

        const sortable = new Set(['createdAt', 'medicationName', 'totalQuantity', 'dispensedQty']);
        const orderBy = sortable.has(sortBy)
            ? { [sortBy]: sortOrder === 'asc' ? 'asc' : 'desc' }
            : { createdAt: 'desc' };

        const [rows, total, activeCount, discontinuedCount, withVideoCount] = await Promise.all([
            prisma.prescription.findMany({
                where,
                include: {
                    ...includeDetails,
                    patient: { select: { id: true, fullName: true, phoneNumber: true } },
                    medicine: { select: { id: true, name: true, sku: true, videoUrl: true } },
                },
                orderBy,
                skip: (pageInt - 1) * limitInt,
                take: limitInt,
            }),
            prisma.prescription.count({ where }),
            prisma.prescription.count({ where: { ...where, discontinuedAt: null } }),
            prisma.prescription.count({ where: { ...where, discontinuedAt: { not: null } } }),
            prisma.prescription.count({ where: { ...where, videoUrl: { not: null } } }),
        ]);

        return {
            prescriptions: rows,
            facets: {
                active: activeCount,
                discontinued: discontinuedCount,
                withVideo: withVideoCount,
            },
            pagination: {
                total,
                page: pageInt,
                limit: limitInt,
                totalPages: Math.max(1, Math.ceil(total / limitInt)),
            },
        };
    }

    /**
     * Discontinue an active prescription. Once discontinued, the lifecycle
     * sweeps (missed-dose + refill-forecast) skip it and markMedicationTaken
     * rejects further doses.
     *
     * RBAC:
     *   - DOCTOR / THERAPIST: only their own (prescriber must match).
     *   - ADMIN / ADMIN_DOCTOR: any prescription in their hospital.
     *   - PATIENT: forbidden (must go through their clinician).
     */
    static async discontinuePrescription(user, prescriptionId, reason) {
        const rx = await prisma.prescription.findUnique({
            where: { id: prescriptionId },
            select: {
                id: true, discontinuedAt: true, medicationName: true, patientId: true,
                doctor: { select: { userId: true } },
                therapist: { select: { userId: true } },
                branch: { select: { hospitalId: true } },
                patient: { select: { fullName: true, user: { select: { id: true } } } },
            },
        });
        if (!rx) {
            const err = new Error('Prescription not found');
            err.status = 404;
            throw err;
        }
        if (rx.discontinuedAt) {
            const err = new Error('Prescription already discontinued');
            err.status = 409;
            throw err;
        }

        let allowed = false;
        if (user.role === 'ADMIN' || user.role === 'ADMIN_DOCTOR') {
            // ADMIN_DOCTOR and ADMIN can discontinue anything in their hospital.
            if (!user.hospitalId || !rx.branch?.hospitalId || rx.branch.hospitalId === user.hospitalId) {
                allowed = true;
            }
        } else if (user.role === 'DOCTOR' && rx.doctor?.userId === user.id) {
            allowed = true;
        } else if (user.role === 'THERAPIST' && rx.therapist?.userId === user.id) {
            allowed = true;
        }

        if (!allowed) {
            const err = new Error('Forbidden: you cannot discontinue this prescription');
            err.status = 403;
            throw err;
        }

        const updated = await prisma.prescription.update({
            where: { id: prescriptionId },
            data: {
                discontinuedAt: new Date(),
                discontinuedReason: reason || null,
                // Clear pending reminder stamps so an accidental re-activation
                // doesn't instantly re-fire stale reminders.
                threeDayNotifiedAt: null,
                lastDayNotifiedAt: null,
                missedDoseNotifiedAt: null,
                missedDoseStreak: 0,
            },
        });

        // Best-effort patient notification — never fails the discontinuation.
        try {
            if (rx.patient?.user?.id) {
                const { notificationService } = await import('./notification.service.js');
                await notificationService.createNotification({
                    userId: rx.patient.user.id,
                    type: 'PRESCRIPTION_DISCONTINUED',
                    title: `⛔ ${rx.medicationName} discontinued`,
                    message: reason
                        ? `Your prescription for ${rx.medicationName} has been discontinued by your care team. Reason: ${reason}`
                        : `Your prescription for ${rx.medicationName} has been discontinued by your care team.`,
                    priority: 'MEDIUM',
                    relatedId: prescriptionId,
                    data: { prescriptionId },
                });
            }
        } catch (err) {
            logger.warn('[PrescriptionService] discontinue notify failed', { err: err.message });
        }

        logger.audit('DISCONTINUE_PRESCRIPTION', user.id, prescriptionId, { reason });
        return updated;
    }

    /**
     * Authorize the caller to read a prescription, then stream a PDF rendition
     * of it directly to the response. Includes the prescriber's full name and
     * qualification, the patient block, the hospital + branch banner, and one
     * row per dosage/frequency/duration field.
     *
     * RBAC mirrors getPatientPrescriptions:
     *   PATIENT — only their own
     *   DOCTOR / THERAPIST — only if they were the prescriber
     *   ADMIN / ADMIN_DOCTOR — any prescription in scope
     */
    static async streamPdf(prescriptionId, user, res) {
        const rx = await prisma.prescription.findUnique({
            where: { id: prescriptionId },
            include: {
                patient: { include: { user: { select: { email: true } } } },
                doctor:    { include: { user: { select: { email: true } } } },
                therapist: { include: { user: { select: { email: true } } } },
                branch:    { include: { hospital: { select: { name: true } } } },
            },
        });
        if (!rx) {
            const err = new Error('Prescription not found');
            err.status = 404;
            throw err;
        }

        // RBAC — anchor row's prescriber/patient gates the whole visit, since
        // every sibling in the visit group shares both.
        let allowed = false;
        if (['ADMIN', 'ADMIN_DOCTOR'].includes(user.role)) {
            allowed = true;
        } else if (user.role === 'PATIENT') {
            const patient = await prisma.patient.findUnique({
                where: { userId: user.id },
                select: { id: true },
            });
            allowed = patient?.id === rx.patientId;
        } else if (user.role === 'DOCTOR') {
            const doctor = await prisma.doctor.findUnique({
                where: { userId: user.id },
                select: { id: true },
            });
            allowed = !!doctor && doctor.id === rx.doctorId;
        } else if (user.role === 'THERAPIST') {
            const therapist = await prisma.therapist.findUnique({
                where: { userId: user.id },
                select: { id: true },
            });
            allowed = !!therapist && therapist.id === rx.therapistId;
        }
        if (!allowed) {
            const err = new Error('Access denied');
            err.status = 403;
            throw err;
        }

        // ─── Resolve the visit grouping ────────────────────────────────────
        // A single visit can produce multiple Prescription rows (one per
        // medicine). We render them as one document so the patient gets the
        // full prescription, not a per-medicine slip.
        //
        // Grouping rule:
        //   1. If the anchor row has appointmentId → all rows tied to that
        //      appointment.
        //   2. Otherwise (ad-hoc prescription) → same patient + same
        //      prescriber + same calendar day as the anchor row.
        //
        // The same prescriber filter keeps unrelated rows out (e.g. another
        // doctor wrote a prescription for the same patient on the same day).
        let visitWhere;
        if (rx.appointmentId) {
            visitWhere = { appointmentId: rx.appointmentId };
        } else {
            const dayStart = new Date(rx.createdAt);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayEnd.getDate() + 1);
            visitWhere = {
                patientId: rx.patientId,
                doctorId: rx.doctorId,
                therapistId: rx.therapistId,
                createdAt: { gte: dayStart, lt: dayEnd },
            };
        }

        const siblings = await prisma.prescription.findMany({
            where: visitWhere,
            orderBy: { createdAt: 'asc' },
        });
        // Always include the anchor — guards against grouping edge cases.
        const seen = new Set();
        const items = [];
        for (const row of [rx, ...siblings]) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            items.push(row);
        }
        items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        const prescriber = rx.doctor || rx.therapist;
        const prescriberRole = rx.doctor ? 'Doctor' : (rx.therapist ? 'Therapist' : 'Clinician');
        const prescriberName = prescriber?.fullName || prescriber?.user?.email || 'Unknown';
        const qualification = prescriber?.qualification || null;
        const specialization = prescriber?.specialization || null;
        const registrationNumber = prescriber?.registrationNumber || null;
        const namePrefix = rx.doctor ? 'Dr.' : '';
        const headerName = `${namePrefix} ${prescriberName}`.trim();
        const patientName = rx.patient?.fullName || rx.patient?.user?.email || 'Patient';
        const patientCode = rx.patient?.patientId || null;
        const hospitalName = rx.branch?.hospital?.name || 'IWIS';
        const branchName = rx.branch?.name || null;
        const visitDate = new Date(rx.createdAt).toLocaleDateString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric',
        });

        // ─── Stream the PDF ─────────────────────────────────────────────────
        const dateSlug = new Date(rx.createdAt).toISOString().slice(0, 10);
        const filename = items.length > 1
            ? `prescription-visit-${dateSlug}-${rx.id.slice(0, 8)}.pdf`
            : `prescription-${rx.id.slice(0, 8)}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        doc.pipe(res);

        // Hospital banner
        doc.fontSize(18).font('Helvetica-Bold').text(hospitalName, { align: 'center' });
        if (branchName) {
            doc.fontSize(11).font('Helvetica').text(branchName, { align: 'center' });
        }
        doc.moveDown(0.3);
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#0D6E6E')
            .text('Prescription', { align: 'center' });
        doc.fillColor('black').moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke();
        doc.moveDown(0.8);

        // Prescriber block
        doc.fontSize(11).font('Helvetica-Bold').text('Prescribed by');
        doc.font('Helvetica').fontSize(12).text(`${headerName}${qualification ? `, ${qualification}` : ''}`);
        if (specialization) {
            doc.fontSize(10).fillColor('#555').text(specialization);
        }
        if (registrationNumber) {
            doc.fontSize(9).fillColor('#777').text(`Reg. No: ${registrationNumber}`);
        }
        doc.fontSize(9).fillColor('#777').text(`Role: ${prescriberRole}`);
        doc.fillColor('black').moveDown(0.8);

        // Patient block
        doc.fontSize(11).font('Helvetica-Bold').text('Patient');
        doc.font('Helvetica').fontSize(11).text(patientName);
        if (patientCode) doc.fontSize(9).fillColor('#777').text(`Patient ID: ${patientCode}`);
        doc.fillColor('black').moveDown(0.3);

        doc.fontSize(9).fillColor('#777').text(`Date: ${visitDate}`);
        if (items.length > 1) {
            doc.fontSize(9).fillColor('#777')
                .text(`Medications on this visit: ${items.length}`);
        }
        doc.fillColor('black').moveDown(0.8);

        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke();
        doc.moveDown(0.6);

        const row = (label, value) => {
            if (!value) return;
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#444')
                .text(`${label}: `, { continued: true });
            doc.font('Helvetica').fillColor('black').text(String(value));
        };

        // Medication blocks — one per Prescription row in the visit.
        items.forEach((med, idx) => {
            // Inserts a separator between meds, but not before the first.
            if (idx > 0) {
                doc.moveDown(0.6);
                doc.moveTo(50, doc.y).lineTo(545, doc.y)
                    .strokeColor('#e5e5e5').dash(2, { space: 2 }).stroke().undash();
                doc.moveDown(0.6);
            }

            const heading = items.length > 1
                ? `${idx + 1}. ${med.medicationName}`
                : med.medicationName;
            doc.fontSize(13).font('Helvetica-Bold').fillColor('black').text(heading);
            doc.moveDown(0.4);

            row('Dosage', med.dosage);
            row('Frequency', med.frequency);
            row('Duration', med.duration);
            if (med.notes) {
                doc.moveDown(0.3);
                doc.font('Helvetica-Bold').fontSize(10).fillColor('#444').text('Notes');
                doc.font('Helvetica').fillColor('black').fontSize(10).text(med.notes, { align: 'left' });
            }

            if (med.discontinuedAt) {
                doc.moveDown(0.4);
                doc.font('Helvetica-Bold').fontSize(10).fillColor('#b91c1c')
                    .text(`Discontinued on ${new Date(med.discontinuedAt).toLocaleDateString('en-GB')}`);
                if (med.discontinuedReason) {
                    doc.font('Helvetica').fontSize(9).text(`Reason: ${med.discontinuedReason}`);
                }
                doc.fillColor('black');
            }
        });

        doc.moveDown(2);
        doc.moveTo(380, doc.y).lineTo(545, doc.y).strokeColor('#999').stroke();
        doc.moveDown(0.2);
        doc.font('Helvetica').fontSize(9).fillColor('#444')
            .text(`${headerName}${qualification ? `, ${qualification}` : ''}`, 380, doc.y, { align: 'right', width: 165 });
        doc.fontSize(8).fillColor('#777')
            .text('Authorised signatory', 380, doc.y, { align: 'right', width: 165 });

        doc.moveDown(2);
        doc.fontSize(8).fillColor('#999')
            .text('This prescription was generated electronically by the IWIS healthcare management system.', 50, doc.y, { align: 'center' });

        doc.end();
    }
}
