import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

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

        // Calculate current medication adherence streak
        const adherenceStreak = await WellnessService.getMedicationAdherenceStreak(patient.id);

        return {
            zenPoints: patient.zenPoints,
            dailyCheckIns: patient.dailyCheckIns,
            level,
            adherenceStreak,
        };
    }

    /**
     * Count the current consecutive-day streak of medication adherence for a patient.
     * A "day" counts if the patient had at least one taken=true medication log.
     */
    static async getMedicationAdherenceStreak(patientId) {
        const today = new Date();
        const lookbackDate = new Date(today);
        lookbackDate.setDate(lookbackDate.getDate() - 60);

        const logs = await prisma.medicationLog.findMany({
            where: {
                prescription: { patientId },
                taken: true,
                date: { gte: lookbackDate },
            },
            select: { date: true },
            orderBy: { date: 'desc' },
        });

        const uniqueDates = [...new Set(logs.map(
            (l) => l.date.toISOString().split('T')[0]
        ))].sort().reverse();

        let streak = 0;
        const cursor = new Date(today.toISOString().split('T')[0]);
        for (const d of uniqueDates) {
            const cursorStr = cursor.toISOString().split('T')[0];
            if (d === cursorStr) {
                streak++;
                cursor.setDate(cursor.getDate() - 1);
            } else {
                break;
            }
        }

        return streak;
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

        // Validate quantity: must be a positive integer 1..50 (per-dose).
        // Blocks negatives (which would INCREASE stock via decrement) and
        // absurdly-large values that would zero out the remaining supply.
        const qty = Number.isFinite(quantityTaken) ? Math.floor(quantityTaken) : 1;
        if (qty < 1 || qty > 50) {
            throw Object.assign(
                new Error('quantityTaken must be an integer between 1 and 50'),
                { status: 400 },
            );
        }

        return prisma.$transaction(async (tx) => {
            const prescription = await tx.prescription.findUnique({
                where: { id: prescriptionId }
            });

            if (!prescription || prescription.patientId !== patient.id) {
                throw new Error('Prescription not found or access denied');
            }

            // Never decrement below zero.
            if (prescription.totalQuantity < qty) {
                throw Object.assign(
                    new Error('Not enough remaining medication to log this dose'),
                    { status: 400 },
                );
            }

            // Create log
            const log = await tx.medicationLog.create({
                data: {
                    prescriptionId,
                    date: new Date(date || Date.now()),
                    medicationName: prescription.medicationName,
                    dosage: prescription.dosage,
                    quantityTaken: qty,
                    taken: true,
                    takenAt: new Date(),
                    notes
                }
            });

            // Update remaining quantity
            const updatedPrescription = await tx.prescription.update({
                where: { id: prescriptionId },
                data: { totalQuantity: { decrement: qty } }
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
                    logger.warn('[WellnessService] Alert failed:', notifyErr.message);
                }
            }

            // ── Gamification: Zen Points for medication adherence ─────────
            const logDate = new Date(date || Date.now());
            const logDateStr = logDate.toISOString().split('T')[0];

            // Base points (5 per taken dose), but only once per day per patient
            const alreadyLoggedToday = await tx.medicationLog.count({
                where: {
                    prescription: { patientId: patient.id },
                    taken: true,
                    date: {
                        gte: new Date(`${logDateStr}T00:00:00.000Z`),
                        lt:  new Date(`${logDateStr}T23:59:59.999Z`),
                    },
                    id: { not: log.id }, // exclude the log we just created
                },
            });

            if (alreadyLoggedToday === 0) {
                // First taken log today — award base points + check streak
                await tx.patient.update({
                    where: { id: patient.id },
                    data: { zenPoints: { increment: 5 } },
                });

                // Compute consecutive adherence streak (up to 60 days lookback)
                const lookbackDate = new Date(logDate);
                lookbackDate.setDate(lookbackDate.getDate() - 60);

                const recentLogs = await tx.medicationLog.findMany({
                    where: {
                        prescription: { patientId: patient.id },
                        taken: true,
                        date: { gte: lookbackDate, lte: logDate },
                    },
                    select: { date: true },
                    orderBy: { date: 'desc' },
                });

                // Collect unique dates
                const uniqueDates = [...new Set(recentLogs.map(
                    (l) => l.date.toISOString().split('T')[0]
                ))].sort().reverse();

                // Count consecutive streak ending today
                let streak = 0;
                let cursor = new Date(logDateStr);
                for (const d of uniqueDates) {
                    const cursorStr = cursor.toISOString().split('T')[0];
                    if (d === cursorStr) {
                        streak++;
                        cursor.setDate(cursor.getDate() - 1);
                    } else {
                        break;
                    }
                }

                // Milestone bonuses (awarded only at exact milestone days)
                const MILESTONES = { 7: 20, 14: 30, 30: 50 };
                const bonus = MILESTONES[streak];
                if (bonus) {
                    await tx.patient.update({
                        where: { id: patient.id },
                        data: { zenPoints: { increment: bonus } },
                    });
                    try {
                        const { notificationService } = await import('./notification.service.js');
                        await notificationService.createNotification({
                            userId,
                            type: 'ADHERENCE_MILESTONE',
                            title: `🔥 ${streak}-day medication streak!`,
                            message: `Incredible! You've taken your medication consistently for ${streak} days. +${bonus} Zen Points awarded!`,
                            priority: 'MEDIUM',
                            data: { streak, bonusPoints: bonus },
                        });
                    } catch { /* non-fatal */ }
                }
            }

            return log;
        }).then(async (log) => {
            // Update the PatientStreak aggregate in real time so the
            // dashboard reflects the new state immediately. Best-effort —
            // the log is already persisted; a failed streak refresh is
            // recoverable via the nightly job.
            try {
                const { StreakService } = await import('./streak.service.js');
                await StreakService.updatePatientStreak(patient.id);
            } catch (err) {
                logger.warn('[WellnessService] Streak update failed:', err.message);
            }
            return log;
        });
    }
}
