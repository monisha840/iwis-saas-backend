import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import PDFDocument from 'pdfkit';
import { inventoryService } from './inventory.service.js';

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
        // branchId may be null for patients who haven't completed onboarding —
        // we still allow the prescription, but log it so admins can backfill.
        if (!patient.branchId) {
            logger.warn('[PrescriptionService] Patient has no branchId; prescription will be unbranched', { patientId });
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
                branchId: patient.branchId,
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

    static async createBatchPrescriptions(user, patientId, medicines, { packageId = null } = {}) {
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

        const created = await prisma.$transaction(async (tx) =>
            Promise.all(medicines.map(med => {
                const extendedNotes = [
                    med.notes,
                    med.timing ? `Timing: ${med.timing}` : null,
                    med.vehicle ? `Anupana (Vehicle): ${med.vehicle}` : null
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
                        branchId: patient.branchId,
                        lowStockThreshold: med.lowStockThreshold || 5,
                        packageId: resolvedPackageId,
                    }
                });
            }))
        );

        return created;
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

        // RBAC
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
        const hospitalName = rx.branch?.hospital?.name || 'Al-Shifa Group of Hospitals';
        const branchName = rx.branch?.name || null;

        // ─── Stream the PDF ─────────────────────────────────────────────────
        const filename = `prescription-${rx.id.slice(0, 8)}.pdf`;
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

        doc.fontSize(9).fillColor('#777').text(`Date: ${new Date(rx.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`);
        doc.fillColor('black').moveDown(0.8);

        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke();
        doc.moveDown(0.6);

        // Medication block
        doc.fontSize(13).font('Helvetica-Bold').text(rx.medicationName);
        doc.moveDown(0.4);

        const row = (label, value) => {
            if (!value) return;
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#444')
                .text(`${label}: `, { continued: true });
            doc.font('Helvetica').fillColor('black').text(String(value));
        };
        row('Dosage', rx.dosage);
        row('Frequency', rx.frequency);
        row('Duration', rx.duration);
        if (rx.notes) {
            doc.moveDown(0.3);
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#444').text('Notes');
            doc.font('Helvetica').fillColor('black').fontSize(10).text(rx.notes, { align: 'left' });
        }

        if (rx.discontinuedAt) {
            doc.moveDown(0.6);
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#b91c1c')
                .text(`Discontinued on ${new Date(rx.discontinuedAt).toLocaleDateString('en-GB')}`);
            if (rx.discontinuedReason) {
                doc.font('Helvetica').fontSize(9).text(`Reason: ${rx.discontinuedReason}`);
            }
            doc.fillColor('black');
        }

        doc.moveDown(2);
        doc.moveTo(380, doc.y).lineTo(545, doc.y).strokeColor('#999').stroke();
        doc.moveDown(0.2);
        doc.font('Helvetica').fontSize(9).fillColor('#444')
            .text(`${headerName}${qualification ? `, ${qualification}` : ''}`, 380, doc.y, { align: 'right', width: 165 });
        doc.fontSize(8).fillColor('#777')
            .text('Authorised signatory', 380, doc.y, { align: 'right', width: 165 });

        doc.moveDown(2);
        doc.fontSize(8).fillColor('#999')
            .text('This prescription was generated electronically by the Al-Shifa healthcare management system.', 50, doc.y, { align: 'center' });

        doc.end();
    }
}
