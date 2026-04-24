import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

const MS_IN_A_DAY = 24 * 60 * 60 * 1000;

/**
 * StreakService — tracks consecutive active days for clinicians and patients.
 *
 * Clinician streaks: an "active day" = at least 1 completed appointment OR
 * message response OR prescription written.
 * Grace rule: 1 off-day per week without breaking the streak (weekends/leave).
 *
 * Streak multiplier tiers:
 *   0–6  days → 1.0x
 *   7–13 days → 1.03x
 *  14–29 days → 1.05x
 *  30+   days → 1.08x (capped to prevent runaway)
 */
export class StreakService {
    static MULTIPLIER_TIERS = [
        { minDays: 30, multiplier: 1.08 },
        { minDays: 14, multiplier: 1.05 },
        { minDays: 7, multiplier: 1.03 },
        { minDays: 0, multiplier: 1.0 },
    ];

    /**
     * Calculate the streak multiplier for a given streak length.
     */
    static getMultiplier(streakDays) {
        for (const tier of this.MULTIPLIER_TIERS) {
            if (streakDays >= tier.minDays) return tier.multiplier;
        }
        return 1.0;
    }

    /**
     * Update clinician streak based on today's activity.
     * Should be called once per clinician per day (by the scheduler).
     */
    static async updateClinicianStreak(participantId, role) {
        // TODO: Use hospital.timezone when per-participant hospital context is available.
        // Invariant: streaks are computed against UTC midnight for consistency.
        const now = new Date();
        const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const todayStr = today.toISOString().split('T')[0];

        const yesterday = new Date(today.getTime() - MS_IN_A_DAY);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        // Check if the clinician was active today
        const wasActiveToday = await this._wasActiveOnDate(participantId, today);

        let streak = await prisma.clinicianStreak.findUnique({
            where: { participantId }
        });

        if (!streak) {
            streak = await prisma.clinicianStreak.create({
                data: {
                    participantId,
                    participantRole: role,
                    currentStreak: wasActiveToday ? 1 : 0,
                    longestStreak: wasActiveToday ? 1 : 0,
                    lastActiveDate: wasActiveToday ? today : null,
                    streakMultiplier: 1.0,
                    graceUsedThisWeek: false
                }
            });
            return streak;
        }

        const lastActiveDateStr = streak.lastActiveDate
            ? new Date(streak.lastActiveDate).toISOString().split('T')[0]
            : null;

        // Already processed today
        if (lastActiveDateStr === todayStr) return streak;

        // Reset grace on Monday
        const isMonday = today.getDay() === 1;
        const graceUsed = isMonday ? false : streak.graceUsedThisWeek;

        if (wasActiveToday) {
            const isConsecutive = lastActiveDateStr === yesterdayStr;
            const gapDays = streak.lastActiveDate
                ? Math.floor((today.getTime() - new Date(streak.lastActiveDate).getTime()) / MS_IN_A_DAY)
                : 999;

            let newStreak;
            if (isConsecutive || gapDays === 1) {
                newStreak = streak.currentStreak + 1;
            } else if (gapDays === 2 && !graceUsed) {
                // Grace day: 1 off-day allowed per week
                newStreak = streak.currentStreak + 1;
            } else {
                // Streak broken
                newStreak = 1;
            }

            const newLongest = Math.max(streak.longestStreak, newStreak);
            const multiplier = this.getMultiplier(newStreak);

            return prisma.clinicianStreak.update({
                where: { participantId },
                data: {
                    currentStreak: newStreak,
                    longestStreak: newLongest,
                    lastActiveDate: today,
                    streakMultiplier: multiplier,
                    graceUsedThisWeek: gapDays === 2 ? true : graceUsed
                }
            });
        } else {
            // Not active today — check if streak should break
            const gapDays = streak.lastActiveDate
                ? Math.floor((today.getTime() - new Date(streak.lastActiveDate).getTime()) / MS_IN_A_DAY)
                : 999;

            if (gapDays > 2 || (gapDays === 2 && graceUsed)) {
                // Streak broken
                return prisma.clinicianStreak.update({
                    where: { participantId },
                    data: {
                        currentStreak: 0,
                        streakMultiplier: 1.0,
                        graceUsedThisWeek: graceUsed
                    }
                });
            }

            // Within grace window — don't update yet
            return streak;
        }
    }

    /**
     * Check if a clinician had activity on a given date.
     */
    static async _wasActiveOnDate(participantId, date) {
        const d = new Date(date);
        const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const dayEnd = new Date(dayStart.getTime() + MS_IN_A_DAY - 1);

        const [appointmentCount, messageCount, prescriptionCount] = await Promise.all([
            prisma.appointment.count({
                where: {
                    OR: [{ doctorId: participantId }, { therapistId: participantId }],
                    status: 'COMPLETED',
                    date: { gte: dayStart, lte: dayEnd }
                }
            }),
            prisma.message.count({
                where: {
                    senderId: participantId,
                    createdAt: { gte: dayStart, lte: dayEnd }
                }
            }),
            prisma.prescription.count({
                where: {
                    OR: [{ doctorId: participantId }, { therapistId: participantId }],
                    createdAt: { gte: dayStart, lte: dayEnd }
                }
            })
        ]);

        return (appointmentCount + messageCount + prescriptionCount) > 0;
    }

    /**
     * Update patient streak — active = logged a vital, completed a task, or did a check-in.
     */
    static async updatePatientStreak(patientId) {
        // TODO: Use patient.hospital.timezone when available.
        // Invariant: streaks are computed against UTC midnight for consistency.
        const now = new Date();
        const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const todayStr = today.toISOString().split('T')[0];

        const yesterday = new Date(today.getTime() - MS_IN_A_DAY);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        let streak = await prisma.patientStreak.findUnique({
            where: { patientId }
        });

        if (!streak) {
            streak = await prisma.patientStreak.create({
                data: { patientId, currentStreak: 1, longestStreak: 1, lastActiveDate: today }
            });
            return streak;
        }

        const lastActiveDateStr = streak.lastActiveDate
            ? new Date(streak.lastActiveDate).toISOString().split('T')[0]
            : null;

        // Already processed today
        if (lastActiveDateStr === todayStr) return streak;

        const isConsecutive = lastActiveDateStr === yesterdayStr;
        const newStreak = isConsecutive ? streak.currentStreak + 1 : 1;
        const newLongest = Math.max(streak.longestStreak, newStreak);

        return prisma.patientStreak.update({
            where: { patientId },
            data: {
                currentStreak: newStreak,
                longestStreak: newLongest,
                lastActiveDate: today
            }
        });
    }

    /**
     * Batch-update all clinician streaks — called by the daily scheduler.
     */
    static async updateAllClinicianStreaks() {
        const [doctors, therapists] = await Promise.all([
            prisma.doctor.findMany({ select: { id: true } }),
            prisma.therapist.findMany({ select: { id: true } })
        ]);

        let updated = 0;
        for (const d of doctors) {
            try { await this.updateClinicianStreak(d.id, 'DOCTOR'); updated++; } catch (e) {
                logger.error(`[StreakService] Failed streak update for doctor ${d.id}:`, e.message);
            }
        }
        for (const t of therapists) {
            try { await this.updateClinicianStreak(t.id, 'THERAPIST'); updated++; } catch (e) {
                logger.error(`[StreakService] Failed streak update for therapist ${t.id}:`, e.message);
            }
        }

        logger.info(`[StreakService] Updated ${updated} clinician streaks`);
        return updated;
    }
}
