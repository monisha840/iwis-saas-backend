
import prisma from '../lib/prisma.js';

export class AdherenceService {
    /**
     * Get the medication schedule for a patient for a specific date (defaults to today)
     */
    static async getTodaySchedule(patientId, dateStr = null) {
        const date = dateStr ? new Date(dateStr) : new Date();
        date.setHours(0, 0, 0, 0);
        const nextDate = new Date(date);
        nextDate.setDate(date.getDate() + 1);

        // Fetch active prescriptions (Duration not expired if provided, or simple non-deleted records)
        // For simplicity, we fetch all prescriptions for the patient. 
        // Real-world logic would check duration/expiry.
        const prescriptions = await prisma.prescription.findMany({
            where: { patientId },
        });

        // Fetch existing logs for the specific date to avoid duplicates and show status
        const logs = await prisma.medicationLog.findMany({
            where: {
                prescriptionId: { in: prescriptions.map(p => p.id) },
                date: {
                    gte: date,
                    lt: nextDate
                }
            }
        });

        const schedule = [];

        prescriptions.forEach(p => {
            const slots = this.parseFrequencyToSlots(p.frequency);

            slots.forEach(slot => {
                const log = logs.find(l => l.prescriptionId === p.id && l.slot === slot.name);

                schedule.push({
                    prescriptionId: p.id,
                    medicationName: p.medicationName,
                    dosage: p.dosage,
                    slot: slot.name,
                    scheduledTime: slot.time,
                    frequency: p.frequency,
                    status: log ? (log.taken ? 'TAKEN' : 'NOT_TAKEN') : 'PENDING',
                    logId: log?.id || null,
                    takenAt: log?.takenAt || null,
                    notes: log?.notes || null
                });
            });
        });

        return schedule;
    }

    /**
     * Map common frequency notations to daily slots
     */
    static parseFrequencyToSlots(frequency) {
        const freq = frequency.toUpperCase();

        if (freq === 'OD' || freq.includes('ONCE')) {
            return [{ name: 'Morning', time: '09:00' }];
        }
        if (freq === 'BD' || freq.includes('TWICE') || freq.includes('2 TIMES')) {
            return [
                { name: 'Morning', time: '09:00' },
                { name: 'Evening', time: '20:00' }
            ];
        }
        if (freq === 'TDS' || freq.includes('THRICE') || freq.includes('3 TIMES')) {
            return [
                { name: 'Morning', time: '09:00' },
                { name: 'Afternoon', time: '13:00' },
                { name: 'Evening', time: '20:00' }
            ];
        }
        if (freq === 'QDS' || freq.includes('4 TIMES')) {
            return [
                { name: 'Morning', time: '09:00' },
                { name: 'Afternoon', time: '13:00' },
                { name: 'Evening', time: '18:00' },
                { name: 'Night', time: '22:00' }
            ];
        }

        // Default or specific slots mentioned in frequency
        const items = [];
        if (freq.includes('MORNING')) items.push({ name: 'Morning', time: '09:00' });
        if (freq.includes('AFTERNOON')) items.push({ name: 'Afternoon', time: '13:00' });
        if (freq.includes('EVENING')) items.push({ name: 'Evening', time: '19:00' });
        if (freq.includes('NIGHT')) items.push({ name: 'Night', time: '22:00' });

        return items.length > 0 ? items : [{ name: 'Daily', time: '10:00' }];
    }

    /**
     * Log adherence for a specific prescription and slot
     */
    static async logAdherence({ patientId, prescriptionId, slot, scheduledTime, taken, notes, dateStr }) {
        const date = dateStr ? new Date(dateStr) : new Date();
        date.setHours(0, 0, 0, 0);

        const prescription = await prisma.prescription.findUnique({
            where: { id: prescriptionId }
        });

        if (!prescription) throw new Error('Prescription not found');

        // Check if log already exists for this slot and date
        const existing = await prisma.medicationLog.findFirst({
            where: {
                prescriptionId,
                slot,
                date: {
                    equals: date
                }
            }
        });

        if (existing) {
            // Update existing log (controlled edit)
            return prisma.medicationLog.update({
                where: { id: existing.id },
                data: {
                    taken,
                    takenAt: taken ? new Date() : null,
                    notes
                }
            });
        }

        // Create new log
        return prisma.medicationLog.create({
            data: {
                prescriptionId,
                date,
                medicationName: prescription.medicationName,
                dosage: prescription.dosage,
                slot,
                scheduledTime,
                taken,
                takenAt: taken ? new Date() : null,
                notes
                // Although MedicationLog currently relates via journey or prescription, 
                // we should ensure it's linked correctly.
                // Wait, schema has prescriptionId and journeyId.
            }
        });
    }

    /**
     * Get adherence statistics for a patient
     */
    static async getAdherenceStats(patientId, days = 30) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        startDate.setHours(0, 0, 0, 0);

        const logs = await prisma.medicationLog.findMany({
            where: {
                prescription: { patientId },
                date: { gte: startDate }
            }
        });

        const totalDoses = logs.length;
        const dosesTaken = logs.filter(l => l.taken).length;
        const percentage = totalDoses > 0 ? Math.round((dosesTaken / totalDoses) * 100) : 100;

        return {
            totalDoses,
            dosesTaken,
            percentage,
            period: `${days} days`
        };
    }
}
