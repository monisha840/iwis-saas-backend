import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { inventoryService } from './inventory.service.js';

const includeDetails = {
    doctor: { include: { user: true } },
    therapist: { include: { user: true } },
};

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

    static async createBatchPrescriptions(user, patientId, medicines) {
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
}
