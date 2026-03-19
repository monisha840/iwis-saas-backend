import prisma from '../lib/prisma.js';
import { notificationService } from './notification.service.js';

/**
 * RefillService — manages prescription refill requests and expiry detection.
 */
export class RefillService {
    /**
     * Patient requests a refill for an existing prescription.
     * Creates a RefillRequest with status PENDING and notifies the prescribing doctor/therapist.
     */
    static async requestRefill(userId, prescriptionId, notes = '') {
        // Verify the prescription belongs to this patient
        const patientRecord = await prisma.patient.findUnique({ where: { userId } });
        if (!patientRecord) throw new Error('Patient profile not found');

        const prescription = await prisma.prescription.findUnique({
            where: { id: prescriptionId },
            include: {
                doctor:   { include: { user: true } },
                therapist:{ include: { user: true } },
                patient:  true,
            },
        });

        if (!prescription) throw new Error('Prescription not found');
        if (prescription.patientId !== patientRecord.id) throw new Error('Access denied');

        // Prevent duplicate pending requests
        const existingPending = await prisma.refillRequest.findFirst({
            where: { prescriptionId, patientId: patientRecord.id, status: 'PENDING' },
        });
        if (existingPending) throw new Error('A refill request for this prescription is already pending');

        const refillRequest = await prisma.refillRequest.create({
            data: {
                prescriptionId,
                patientId:     patientRecord.id,
                requestedById: userId,
                status:        'PENDING',
                notes:         notes || null,
            },
        });

        // Notify the prescribing doctor or therapist
        const prescriberId = prescription.doctor?.user?.id || prescription.therapist?.user?.id;
        if (prescriberId) {
            await notificationService.createNotification({
                userId:   prescriberId,
                type:     'REFILL_REQUEST',
                title:    `💊 Refill request — ${prescription.medicationName}`,
                message:  `${prescription.patient?.fullName || 'A patient'} has requested a refill for ${prescription.medicationName} (${prescription.dosage}).`,
                priority: 'MEDIUM',
                data: { refillRequestId: refillRequest.id, prescriptionId },
            });
        }

        return refillRequest;
    }

    /**
     * Clinician approves or rejects a refill request.
     * On approval, extends the prescription with a new entry and awards a pharmacy auto-order placeholder.
     */
    static async processRefill(userId, refillRequestId, action, notes = '') {
        if (!['APPROVED', 'REJECTED'].includes(action)) throw new Error('Invalid action');

        const refill = await prisma.refillRequest.findUnique({
            where: { id: refillRequestId },
            include: {
                prescription: {
                    include: {
                        patient: { include: { user: true } },
                        doctor:  { include: { user: true } },
                        medicine: true,
                    },
                },
            },
        });
        if (!refill) throw new Error('Refill request not found');

        const updated = await prisma.refillRequest.update({
            where: { id: refillRequestId },
            data: { status: action, notes: notes || refill.notes, updatedAt: new Date() },
        });

        // Notify patient
        if (refill.prescription.patient?.user?.id) {
            await notificationService.createNotification({
                userId:   refill.prescription.patient.user.id,
                type:     'REFILL_PROCESSED',
                title:    action === 'APPROVED'
                    ? `✅ Refill approved — ${refill.prescription.medicationName}`
                    : `❌ Refill declined — ${refill.prescription.medicationName}`,
                message:  action === 'APPROVED'
                    ? `Your refill request for ${refill.prescription.medicationName} has been approved. Please collect from the pharmacy.`
                    : `Your refill request for ${refill.prescription.medicationName} was declined.${notes ? ' Note: ' + notes : ''}`,
                priority: action === 'APPROVED' ? 'MEDIUM' : 'LOW',
                data: { refillRequestId },
            });
        }

        return updated;
    }

    /**
     * Return all pending refill requests for the logged-in clinician's patients.
     */
    static async getPendingRefillsForClinician(userId) {
        // Find the doctor or therapist profile
        const doctor    = await prisma.doctor.findUnique({ where: { userId }, select: { id: true } });
        const therapist = !doctor
            ? await prisma.therapist.findUnique({ where: { userId }, select: { id: true } })
            : null;

        if (!doctor && !therapist) throw new Error('Clinician profile not found');

        return prisma.refillRequest.findMany({
            where: {
                status: 'PENDING',
                prescription: doctor
                    ? { doctorId: doctor.id }
                    : { therapistId: therapist.id },
            },
            include: {
                prescription: {
                    include: {
                        patient: { select: { fullName: true, id: true } },
                        medicine: { select: { name: true, category: true } },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Return all refill requests for the current patient.
     */
    static async getPatientRefills(userId) {
        const patientRecord = await prisma.patient.findUnique({ where: { userId } });
        if (!patientRecord) throw new Error('Patient profile not found');

        return prisma.refillRequest.findMany({
            where: { patientId: patientRecord.id },
            include: {
                prescription: {
                    select: { medicationName: true, dosage: true, frequency: true, duration: true },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Detect prescriptions expiring within the next `daysAhead` days and
     * notify both patient and prescribing clinician.
     * Called by: scheduler.service.js (daily cron)
     */
    static async detectExpiringPrescriptions(daysAhead = 5) {
        // We parse duration strings like "30 days", "7 days", "1 month"
        // and compute an approximate end date from createdAt
        const parseDurationDays = (durationStr) => {
            if (!durationStr) return 30;
            const lower = durationStr.toLowerCase();
            const num = parseFloat(lower);
            if (lower.includes('month')) return Math.round(num * 30);
            if (lower.includes('week'))  return num * 7;
            return num || 30;
        };

        const prescriptions = await prisma.prescription.findMany({
            include: {
                patient:  { include: { user: true } },
                doctor:   { include: { user: true } },
                therapist:{ include: { user: true } },
            },
        });

        const now = new Date();
        let alertCount = 0;

        for (const rx of prescriptions) {
            const durationDays = parseDurationDays(rx.duration);
            const endDate = new Date(rx.createdAt);
            endDate.setDate(endDate.getDate() + durationDays);

            const daysLeft = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));

            if (daysLeft > 0 && daysLeft <= daysAhead) {
                // Patient notification
                if (rx.patient?.user?.id) {
                    await notificationService.createNotification({
                        userId:   rx.patient.user.id,
                        type:     'PRESCRIPTION_EXPIRY',
                        title:    `⏰ Prescription expiring in ${daysLeft} day(s)`,
                        message:  `Your prescription for ${rx.medicationName} (${rx.dosage}) expires in ${daysLeft} day(s). Request a refill from your doctor before it runs out.`,
                        priority: 'MEDIUM',
                        data: { prescriptionId: rx.id },
                    });
                }

                // Clinician notification
                const prescriberId = rx.doctor?.user?.id || rx.therapist?.user?.id;
                if (prescriberId) {
                    await notificationService.createNotification({
                        userId:   prescriberId,
                        type:     'PRESCRIPTION_EXPIRY_CLINICIAN',
                        title:    `📋 Prescription expiring — ${rx.patient?.fullName || 'Patient'}`,
                        message:  `${rx.patient?.fullName || 'A patient'}'s prescription for ${rx.medicationName} expires in ${daysLeft} day(s).`,
                        priority: 'LOW',
                        data: { prescriptionId: rx.id },
                    });
                }

                alertCount++;
            }
        }

        return alertCount;
    }
}
