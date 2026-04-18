import prisma from '../lib/prisma.js';

// Default slot durations by consultation type (in minutes)
const DEFAULT_SLOT_DURATIONS = {
    DOCTOR: 30,
    THERAPIST: 45,
    COMBINED: 60,
};

// Minimum buffer between appointments (minutes)
const MIN_BUFFER_MINUTES = 10;

export class SlotOptimizationService {
    /**
     * Analyze historical appointment data to suggest optimal slot durations.
     * Looks at actual consultation durations (start→complete timestamps) grouped by type.
     */
    static async getOptimalSlotDurations(clinicianId) {
        // Find completed appointments with consultation sessions that have start/end times
        const completedAppointments = await prisma.appointment.findMany({
            where: {
                OR: [
                    { doctorId: clinicianId },
                    { therapistId: clinicianId },
                ],
                status: 'COMPLETED',
                consultation: { isNot: null },
            },
            include: {
                consultation: {
                    select: { startedAt: true, completedAt: true },
                },
            },
            orderBy: { date: 'desc' },
            take: 200, // Last 200 completed appointments
        });

        // Calculate actual durations grouped by consultation type
        const durationsByType = {};

        for (const apt of completedAppointments) {
            if (!apt.consultation?.startedAt || !apt.consultation?.completedAt) continue;

            const durationMs = new Date(apt.consultation.completedAt).getTime() - new Date(apt.consultation.startedAt).getTime();
            const durationMin = Math.round(durationMs / 60000);

            // Filter out outliers (< 5 min or > 180 min)
            if (durationMin < 5 || durationMin > 180) continue;

            const type = apt.consultationType || 'DOCTOR';
            if (!durationsByType[type]) durationsByType[type] = [];
            durationsByType[type].push(durationMin);
        }

        // Calculate statistics for each type
        const suggestions = {};
        for (const [type, durations] of Object.entries(durationsByType)) {
            if (durations.length < 3) {
                suggestions[type] = {
                    recommended: DEFAULT_SLOT_DURATIONS[type] || 30,
                    sampleSize: durations.length,
                    confidence: 'low',
                    note: 'Insufficient data — using default',
                };
                continue;
            }

            durations.sort((a, b) => a - b);
            const median = durations[Math.floor(durations.length / 2)];
            const p75 = durations[Math.floor(durations.length * 0.75)];
            const avg = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
            const min = durations[0];
            const max = durations[durations.length - 1];

            // Recommend the 75th percentile (covers most appointments without over-allocating)
            // Round up to nearest 5 minutes
            const recommended = Math.ceil(p75 / 5) * 5;

            suggestions[type] = {
                recommended: Math.max(15, Math.min(recommended, 90)), // Clamp 15-90 min
                median,
                average: avg,
                p75,
                min,
                max,
                sampleSize: durations.length,
                confidence: durations.length >= 20 ? 'high' : durations.length >= 10 ? 'medium' : 'low',
            };
        }

        // Fill in defaults for types without data
        for (const type of Object.keys(DEFAULT_SLOT_DURATIONS)) {
            if (!suggestions[type]) {
                suggestions[type] = {
                    recommended: DEFAULT_SLOT_DURATIONS[type],
                    sampleSize: 0,
                    confidence: 'none',
                    note: 'No historical data — using default',
                };
            }
        }

        return suggestions;
    }

    /**
     * Detect overbooking patterns — days/times where a clinician has more
     * appointments than they can reasonably handle.
     */
    static async detectOverbooking(clinicianId, { from, to } = {}) {
        const dateFilter = {};
        if (from) dateFilter.gte = new Date(from);
        if (to) dateFilter.lte = new Date(to);
        if (!from) {
            dateFilter.gte = new Date();
            dateFilter.lte = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // Next 30 days
        }

        const appointments = await prisma.appointment.findMany({
            where: {
                OR: [
                    { doctorId: clinicianId },
                    { therapistId: clinicianId },
                ],
                date: dateFilter,
                status: { notIn: ['CANCELLED', 'REJECTED'] },
            },
            orderBy: { date: 'asc' },
            select: {
                id: true,
                date: true,
                consultationType: true,
                status: true,
                patient: { select: { fullName: true } },
            },
        });

        // Group by date
        const byDate = {};
        for (const apt of appointments) {
            const dateKey = apt.date.toISOString().split('T')[0];
            if (!byDate[dateKey]) byDate[dateKey] = [];
            byDate[dateKey].push(apt);
        }

        const warnings = [];
        const WORKING_HOURS = 9; // 9:00 - 18:00

        for (const [dateKey, dayAppointments] of Object.entries(byDate)) {
            // Check total count vs available hours
            const totalSlots = Math.floor((WORKING_HOURS * 60) / 30); // max 30-min slots
            if (dayAppointments.length > totalSlots) {
                warnings.push({
                    date: dateKey,
                    type: 'OVERBOOKED_DAY',
                    severity: 'HIGH',
                    message: `${dayAppointments.length} appointments scheduled but only ${totalSlots} slots available`,
                    appointmentCount: dayAppointments.length,
                    maxSlots: totalSlots,
                });
            } else if (dayAppointments.length > totalSlots * 0.85) {
                warnings.push({
                    date: dateKey,
                    type: 'NEAR_CAPACITY',
                    severity: 'MEDIUM',
                    message: `${dayAppointments.length}/${totalSlots} slots filled (${Math.round(dayAppointments.length / totalSlots * 100)}% capacity)`,
                    appointmentCount: dayAppointments.length,
                    maxSlots: totalSlots,
                });
            }

            // Check for back-to-back appointments without buffer
            const sorted = [...dayAppointments].sort((a, b) => a.date.getTime() - b.date.getTime());
            for (let i = 0; i < sorted.length - 1; i++) {
                const current = sorted[i];
                const next = sorted[i + 1];
                const gapMinutes = (next.date.getTime() - current.date.getTime()) / 60000;

                if (gapMinutes < MIN_BUFFER_MINUTES && gapMinutes >= 0) {
                    warnings.push({
                        date: dateKey,
                        type: 'NO_BUFFER',
                        severity: 'LOW',
                        message: `Only ${Math.round(gapMinutes)} min gap between ${current.patient?.fullName || 'Patient'} and ${next.patient?.fullName || 'Patient'}`,
                        appointmentIds: [current.id, next.id],
                    });
                }
            }
        }

        return {
            totalAppointments: appointments.length,
            daysAnalyzed: Object.keys(byDate).length,
            warnings: warnings.sort((a, b) => {
                const severityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
                return (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3);
            }),
        };
    }

    /**
     * Calculate utilization metrics for a clinician over a date range.
     */
    static async getUtilizationMetrics(clinicianId, { from, to } = {}) {
        const now = new Date();
        const startDate = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
        const endDate = to ? new Date(to) : now;

        const [appointments, blocks] = await Promise.all([
            prisma.appointment.findMany({
                where: {
                    OR: [
                        { doctorId: clinicianId },
                        { therapistId: clinicianId },
                    ],
                    date: { gte: startDate, lte: endDate },
                    status: { notIn: ['CANCELLED', 'REJECTED'] },
                },
                select: { date: true, status: true, consultationType: true },
            }),
            prisma.blockedSlot.findMany({
                where: {
                    OR: [
                        { doctorId: clinicianId },
                        { therapistId: clinicianId },
                    ],
                },
            }),
        ]);

        // Count working days in range (exclude weekends)
        let workingDays = 0;
        const d = new Date(startDate);
        while (d <= endDate) {
            if (d.getDay() !== 0 && d.getDay() !== 6) workingDays++; // Skip Sun/Sat
            d.setDate(d.getDate() + 1);
        }

        const SLOTS_PER_DAY = 18; // 9 hours * 2 (30-min slots)
        const totalAvailableSlots = workingDays * SLOTS_PER_DAY;

        // Count blocked slots
        const blockedSlotCount = blocks.reduce((count, block) => {
            const duration = (parseInt(block.endTime.split(':')[0]) * 60 + parseInt(block.endTime.split(':')[1]))
                - (parseInt(block.startTime.split(':')[0]) * 60 + parseInt(block.startTime.split(':')[1]));
            return count + Math.ceil(duration / 30);
        }, 0);

        const bookedSlots = appointments.length;
        const completedSlots = appointments.filter(a => a.status === 'COMPLETED').length;
        const noShowSlots = appointments.filter(a => a.status === 'NO_SHOW').length;
        const netAvailable = Math.max(0, totalAvailableSlots - blockedSlotCount);

        // Group by day of week for pattern analysis
        const byDayOfWeek = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
        for (const apt of appointments) {
            byDayOfWeek[apt.date.getDay()]++;
        }

        const dayLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const peakDay = byDayOfWeek.indexOf(Math.max(...byDayOfWeek));
        const quietDay = byDayOfWeek.slice(1, 6).indexOf(Math.min(...byDayOfWeek.slice(1, 6))) + 1; // Weekdays only

        return {
            period: { from: startDate.toISOString(), to: endDate.toISOString() },
            workingDays,
            totalAvailableSlots,
            blockedSlots: blockedSlotCount,
            netAvailableSlots: netAvailable,
            bookedSlots,
            completedSlots,
            noShowSlots,
            utilizationRate: netAvailable > 0 ? Math.round((bookedSlots / netAvailable) * 100) : 0,
            completionRate: bookedSlots > 0 ? Math.round((completedSlots / bookedSlots) * 100) : 0,
            noShowRate: bookedSlots > 0 ? Math.round((noShowSlots / bookedSlots) * 100) : 0,
            avgAppointmentsPerDay: workingDays > 0 ? Math.round((bookedSlots / workingDays) * 10) / 10 : 0,
            peakDay: { day: dayLabels[peakDay], count: byDayOfWeek[peakDay] },
            quietDay: { day: dayLabels[quietDay], count: byDayOfWeek[quietDay] },
            weekdayDistribution: dayLabels.map((label, i) => ({ day: label, count: byDayOfWeek[i] })),
        };
    }

    /**
     * Generate smart scheduling suggestions based on current booking patterns.
     */
    static async getSchedulingSuggestions(clinicianId) {
        const suggestions = [];

        // 1. Check optimal slot durations
        const durations = await this.getOptimalSlotDurations(clinicianId);
        for (const [type, data] of Object.entries(durations)) {
            if (data.confidence !== 'none' && data.recommended !== DEFAULT_SLOT_DURATIONS[type]) {
                suggestions.push({
                    type: 'SLOT_DURATION',
                    priority: 'MEDIUM',
                    title: `Adjust ${type} slot duration`,
                    description: `Based on ${data.sampleSize} completed sessions, ${type} consultations average ${data.average} min. Consider ${data.recommended} min slots instead of the default ${DEFAULT_SLOT_DURATIONS[type]} min.`,
                    data: { consultationType: type, current: DEFAULT_SLOT_DURATIONS[type], suggested: data.recommended },
                });
            }
        }

        // 2. Check utilization
        const utilization = await this.getUtilizationMetrics(clinicianId);
        if (utilization.utilizationRate < 50 && utilization.workingDays > 5) {
            suggestions.push({
                type: 'LOW_UTILIZATION',
                priority: 'LOW',
                title: 'Low schedule utilization',
                description: `Only ${utilization.utilizationRate}% of available slots are booked. Consider reducing available hours or promoting open slots.`,
                data: { rate: utilization.utilizationRate },
            });
        }
        if (utilization.utilizationRate > 90) {
            suggestions.push({
                type: 'HIGH_UTILIZATION',
                priority: 'HIGH',
                title: 'Schedule near capacity',
                description: `${utilization.utilizationRate}% of slots are filled. Consider extending hours or adding buffer time to prevent burnout.`,
                data: { rate: utilization.utilizationRate },
            });
        }

        // 3. Check no-show rate
        if (utilization.noShowRate > 15 && utilization.bookedSlots > 10) {
            suggestions.push({
                type: 'HIGH_NO_SHOW',
                priority: 'MEDIUM',
                title: 'High no-show rate detected',
                description: `${utilization.noShowRate}% no-show rate. Consider enabling appointment reminders or requiring confirmation 24h before.`,
                data: { rate: utilization.noShowRate },
            });
        }

        // 4. Check overbooking
        const overbooking = await this.detectOverbooking(clinicianId);
        const highWarnings = overbooking.warnings.filter(w => w.severity === 'HIGH');
        if (highWarnings.length > 0) {
            suggestions.push({
                type: 'OVERBOOKING',
                priority: 'HIGH',
                title: `${highWarnings.length} overbooked day(s) detected`,
                description: `There are days where appointments exceed available slots. Review and redistribute.`,
                data: { dates: highWarnings.map(w => w.date) },
            });
        }

        return suggestions.sort((a, b) => {
            const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
            return (order[a.priority] || 3) - (order[b.priority] || 3);
        });
    }
}
