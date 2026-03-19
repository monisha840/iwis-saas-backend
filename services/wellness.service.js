import prisma from '../lib/prisma.js';

export class WellnessService {
    static async getStats(userId) {
        const patient = await prisma.patient.findUnique({
            where: { userId },
            include: {
                dailyCheckIns: { orderBy: { createdAt: 'desc' }, take: 7 }
            }
        });
        if (!patient) throw new Error('Patient profile not found');

        const level = patient.zenPoints >= 1000 ? 'Zen Master' : patient.zenPoints >= 500 ? 'Peaceful Soul' : 'Mindful Beginner';

        return {
            zenPoints: patient.zenPoints,
            dailyCheckIns: patient.dailyCheckIns,
            level
        };
    }

    static async submitCheckIn(userId, data) {
        const patient = await prisma.patient.findUnique({ where: { userId } });
        if (!patient) throw new Error('Patient profile not found. Please complete onboarding.');

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const existingCheckIn = await prisma.dailyCheckIn.findFirst({
            where: { patientId: patient.id, createdAt: { gte: today } }
        });
        if (existingCheckIn) throw new Error('You have already checked in today.');

        return prisma.$transaction(async (tx) => {
            const checkIn = await tx.dailyCheckIn.create({
                data: {
                    patientId: patient.id,
                    painLevel: data.painLevel,
                    mobilityScore: data.mobilityScore,
                    sleepHours: data.sleepHours,
                    mood: data.mood,
                    notes: data.notes
                }
            });
            await tx.patient.update({
                where: { id: patient.id },
                data: { zenPoints: { increment: 10 } }
            });
            return checkIn;
        });
    }

    static async getVideos() {
        return prisma.exerciseVideo.findMany();
    }

    static async getMyPrescriptions(userId) {
        const patient = await prisma.patient.findUnique({ where: { userId } });
        if (!patient) throw new Error('Patient not found');
        return prisma.videoPrescription.findMany({
            where: { patientId: patient.id },
            include: { video: true, doctor: true, therapist: true }
        });
    }

    static async prescribeVideo(userId, data) {
        const { patientId, videoId, notes } = data;
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { doctor: true, therapist: true }
        });

        const prescriber = {};
        if (user.doctor) prescriber.doctorId = user.doctor.id;
        else if (user.therapist) prescriber.therapistId = user.therapist.id;

        return prisma.videoPrescription.create({
            data: { patientId, videoId, notes, ...prescriber }
        });
    }
    static async getMyMedications(userId) {
        const patient = await prisma.patient.findUnique({ where: { userId } });
        if (!patient) throw new Error('Patient not found');

        return prisma.prescription.findMany({
            where: { patientId: patient.id, totalQuantity: { gt: 0 } },
            orderBy: { createdAt: 'desc' }
        });
    }

    static async submitMedicationLog(userId, data) {
        const { prescriptionId, quantityTaken, date, notes } = data;
        const patient = await prisma.patient.findUnique({ where: { userId } });
        if (!patient) throw new Error('Patient not found');

        return prisma.$transaction(async (tx) => {
            const prescription = await tx.prescription.findUnique({
                where: { id: prescriptionId }
            });

            if (!prescription || prescription.patientId !== patient.id) {
                throw new Error('Prescription not found or access denied');
            }

            // Create log
            const log = await tx.medicationLog.create({
                data: {
                    prescriptionId,
                    date: new Date(date || Date.now()),
                    medicationName: prescription.medicationName,
                    dosage: prescription.dosage,
                    quantityTaken: quantityTaken || 1,
                    taken: true,
                    takenAt: new Date(),
                    notes
                }
            });

            // Update remaining quantity
            const updatedPrescription = await tx.prescription.update({
                where: { id: prescriptionId },
                data: { totalQuantity: { decrement: quantityTaken || 1 } }
            });

            // Check threshold and notify
            if (updatedPrescription.totalQuantity <= updatedPrescription.lowStockThreshold) {
                try {
                    const { notificationService } = await import('./notification.service.js');
                    await notificationService.sendClientLowMedicationAlert({
                        patientId: patient.id,
                        patientName: patient.fullName || 'Patient',
                        medicineName: updatedPrescription.medicationName,
                        remainingQuantity: updatedPrescription.totalQuantity,
                        urgency: updatedPrescription.totalQuantity <= 2 ? 'critical' : 'normal'
                    });
                } catch (notifyErr) {
                    console.warn('[WellnessService] Alert failed:', notifyErr.message);
                }
            }

            return log;
        });
    }
}
