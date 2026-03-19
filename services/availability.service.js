import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
const DEFAULT_SLOT_INTERVAL = 30;
const CLINICAL_DAY_START = 9;
const CLINICAL_DAY_END = 18;

export class AvailabilityService {
    static async createBlock(data) {
        const { doctorId, therapistId, date, dayOfWeek, startTime, endTime, reason } = data;

        if (!doctorId && !therapistId) {
            throw new Error('Either doctorId or therapistId is required');
        }

        // Validate time format HH:mm
        const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
        if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
            throw new Error('Invalid time format. Use HH:mm');
        }

        if (startTime >= endTime) {
            throw new Error('Start time must be before end time');
        }

        await this.validateBlockOverlap(data);

        // Check for conflicting appointments
        const clinicianFilter = doctorId
            ? { doctorId }
            : { therapistId: therapistId || null };

        const appointmentWhere = {
            ...clinicianFilter,
            status: { notIn: ['CANCELLED', 'REJECTED'] },
        };

        if (date) {
            const startOfDate = new Date(new Date(date).setHours(0, 0, 0, 0));
            const endOfDate = new Date(new Date(date).setHours(23, 59, 59, 999));
            appointmentWhere.date = { gte: startOfDate, lte: endOfDate };
        } else if (dayOfWeek !== undefined) {
            const futureDate = new Date();
            const threeMonthsLater = new Date();
            threeMonthsLater.setMonth(futureDate.getMonth() + 3);
            appointmentWhere.date = { gte: futureDate, lte: threeMonthsLater };
        }

        const conflictingAppointments = await prisma.appointment.findMany({
            where: appointmentWhere,
            include: { patient: true }
        });

        for (const apt of conflictingAppointments) {
            // Use UTC time so comparison is consistent with slot labels stored/generated in UTC.
            const aptStart = apt.date.toISOString().slice(11, 16);
            const aptEnd = new Date(apt.date.getTime() + 60 * 60 * 1000).toISOString().slice(11, 16);

            if (dayOfWeek !== undefined && apt.date.getDay() !== parseInt(dayOfWeek)) continue;

            if (startTime < aptEnd && endTime > aptStart) {
                throw new Error(`Conflict: ${apt.patient.fullName} has an appointment scheduled during this time on ${apt.date.toLocaleDateString()}`);
            }
        }

        return prisma.blockedSlot.create({
            data: {
                doctorId: doctorId || null,
                therapistId: therapistId || null,
                date: date ? new Date(date) : null,
                dayOfWeek: dayOfWeek !== undefined ? parseInt(dayOfWeek) : null,
                startTime,
                endTime,
                reason
            }
        });
    }

    static async updateBlock(id, data) {
        const { startTime, endTime, date, dayOfWeek, reason } = data;

        const existing = await prisma.blockedSlot.findUnique({ where: { id } });
        if (!existing) throw new Error('Block not found');

        // Merge existing and new data for validation
        const validationData = {
            ...existing,
            ...data,
            excludeId: id
        };

        // Re-validate time if provided
        if (startTime || endTime) {
            const s = startTime || existing.startTime;
            const e = endTime || existing.endTime;
            if (s >= e) throw new Error('Start time must be before end time');
        }

        await this.validateBlockOverlap(validationData);

        return prisma.blockedSlot.update({
            where: { id },
            data: {
                date: date ? new Date(date) : undefined,
                dayOfWeek: dayOfWeek !== undefined ? parseInt(dayOfWeek) : undefined,
                startTime: data.startTime,
                endTime: data.endTime,
                reason: data.reason
            }
        });
    }

    static async validateBlockOverlap(data) {
        const { doctorId, therapistId, date, dayOfWeek, startTime, endTime, excludeId } = data;

        const clinicianFilter = doctorId
            ? { doctorId }
            : { therapistId: therapistId || null };

        // Fetch potential overlaps
        // We fetch candidates and filter in JS to ensure absolute precision between specific dates and recurring days
        const candidates = await prisma.blockedSlot.findMany({
            where: {
                ...clinicianFilter,
                id: { not: excludeId }
            }
        });

        const newDateObj = date ? new Date(date) : null;
        const newDay = dayOfWeek !== undefined ? parseInt(dayOfWeek) : (newDateObj ? newDateObj.getDay() : null);

        for (const block of candidates) {
            let matchesDay = false;

            if (date && block.date) {
                // Both specific dates - must be same day
                matchesDay = new Date(date).toISOString().split('T')[0] === new Date(block.date).toISOString().split('T')[0];
            } else if (dayOfWeek !== undefined && block.dayOfWeek !== null) {
                // Both recurring - must be same day of week
                matchesDay = parseInt(dayOfWeek) === block.dayOfWeek;
            } else if (date && block.dayOfWeek !== null) {
                // New is specific, existing is recurring
                matchesDay = new Date(date).getDay() === block.dayOfWeek;
            } else if (dayOfWeek !== undefined && block.date) {
                // New is recurring, existing is specific
                matchesDay = new Date(block.date).getDay() === parseInt(dayOfWeek);
            }

            if (matchesDay) {
                // Overlap if (newStart < existingEnd) AND (newEnd > existingStart)
                if (startTime < block.endTime && endTime > block.startTime) {
                    logger.info(`[Availability Conflict] User: ${doctorId || therapistId} | Input: ${startTime}-${endTime} | Conflict: ${block.startTime}-${block.endTime} (${block.reason || 'No reason'})`);
                    throw new Error(`Time slot overlaps with an existing blocked slot (${block.reason || 'Leave/Blocked'})`);
                }
            }
        }
    }

    static async deleteBlock(id) {
        return prisma.blockedSlot.delete({ where: { id } });
    }

    static async getBlocks(clinicianId) {
        return prisma.blockedSlot.findMany({
            where: {
                OR: [
                    { doctorId: clinicianId },
                    { therapistId: clinicianId }
                ]
            },
            orderBy: [
                { date: 'asc' },
                { dayOfWeek: 'asc' },
                { startTime: 'asc' }
            ]
        });
    }

    static async checkAvailability(clinicianId, dateString, startTime, endTime) {
        const appointmentDate = new Date(dateString);
        const dayOfWeek = appointmentDate.getDay(); // 0-6 Sunday-Saturday

        // Get all blocks for this doctor/therapist that match either the date OR the day of week
        const dateStrOnly = new Date(dateString).toISOString().split('T')[0];
        const blocks = await prisma.blockedSlot.findMany({
            where: {
                OR: [
                    { doctorId: clinicianId },
                    { therapistId: clinicianId }
                ],
                AND: [
                    {
                        OR: [
                            {
                                date: {
                                    gte: new Date(dateStrOnly + 'T00:00:00.000Z'),
                                    lte: new Date(dateStrOnly + 'T23:59:59.999Z')
                                }
                            },
                            {
                                dayOfWeek: dayOfWeek,
                                date: null
                            }
                        ]
                    }
                ]
            }
        });

        // 2. Check for time overlap
        // Request: Start A, End B
        // Block: Start C, End D
        // Overlap if (A < D) and (B > C)

        for (const block of blocks) {
            // Check time overlap
            if (startTime < block.endTime && endTime > block.startTime) {
                return {
                    available: false,
                    reason: block.reason || 'Doctor unavailable'
                };
            }
        }

        return { available: true };
    }

    static async getAvailableSlots(clinicianId, date, intervalMinutes = DEFAULT_SLOT_INTERVAL) {
        const checkDate = new Date(date);
        const dayOfWeek = checkDate.getDay();
        const dateString = checkDate.toISOString().split('T')[0];

        // 1. Define working hours (extracted constants)
        const workingStart = CLINICAL_DAY_START;
        const workingEnd = CLINICAL_DAY_END;

        // 2. Fetch all blocks and appointments for the day
        const [blocks, appointments] = await Promise.all([
            prisma.blockedSlot.findMany({
                where: {
                    OR: [{ doctorId: clinicianId }, { therapistId: clinicianId }],
                    AND: [
                        {
                            OR: [
                                { date: { gte: new Date(dateString), lt: new Date(new Date(dateString).getTime() + 24 * 60 * 60 * 1000) } },
                                { dayOfWeek: dayOfWeek, date: null }
                            ]
                        }
                    ]
                }
            }),
            prisma.appointment.findMany({
                where: {
                    OR: [{ doctorId: clinicianId }, { therapistId: clinicianId }],
                    date: { gte: new Date(dateString), lt: new Date(new Date(dateString).getTime() + 24 * 60 * 60 * 1000) },
                    status: { notIn: ['CANCELLED', 'REJECTED'] }
                }
            })
        ]);

        const slots = [];
        const totalMinutes = (workingEnd - workingStart) * 60;

        for (let offset = 0; offset < totalMinutes; offset += intervalMinutes) {
            const startHour = Math.floor(offset / 60) + workingStart;
            const startMin = offset % 60;
            const endOffset = offset + intervalMinutes;
            const endHour = Math.floor(endOffset / 60) + workingStart;
            const endMin = endOffset % 60;

            const slotStart = `${startHour.toString().padStart(2, '0')}:${startMin.toString().padStart(2, '0')}`;
            const slotEnd = `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`;
            const slotLabel = `${slotStart} - ${slotEnd}`;

            if (endHour > workingEnd || (endHour === workingEnd && endMin > 0)) break;

            // Check if blocked by leave
            const block = blocks.find(b => slotStart < b.endTime && slotEnd > b.startTime);
            if (block) {
                slots.push({
                    slot: slotLabel,
                    startTime: slotStart,
                    endTime: slotEnd,
                    status: 'BLOCKED',
                    reason: block.reason || 'Doctor unavailable (Leave)'
                });
                continue;
            }

            // Check if booked by appointment.
            // Use .toISOString() (UTC) not .toTimeString() (server local) so slot labels
            // always line up with the UTC-based working-hours grid (09:00–18:00 UTC).
            const appointment = appointments.find(a => {
                const start = a.date.toISOString().slice(11, 16);
                const end = new Date(a.date.getTime() + 60 * 60 * 1000).toISOString().slice(11, 16);
                return slotStart < end && slotEnd > start;
            });

            if (appointment) {
                slots.push({
                    slot: slotLabel,
                    startTime: slotStart,
                    endTime: slotEnd,
                    status: 'BOOKED',
                    reason: 'Slot already reserved'
                });
                continue;
            }

            slots.push({
                slot: slotLabel,
                startTime: slotStart,
                endTime: slotEnd,
                status: 'AVAILABLE'
            });
        }

        return slots;
    }

    static async findNextAvailableSlot(clinicianId, originalDate, intervalMinutes = DEFAULT_SLOT_INTERVAL) {
        const slots = await this.getAvailableSlots(clinicianId, originalDate, intervalMinutes);
        const originalTimeStr = new Date(originalDate).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

        // Find slots that are at least 30 mins away from the original time
        // We look both forward and backward, but prioritize forward
        const availableSlots = slots.filter(s => s.status === 'AVAILABLE');

        if (availableSlots.length === 0) return null;

        const originalInMinutes = (new Date(originalDate).getHours() * 60) + new Date(originalDate).getMinutes();
        const buffer = DEFAULT_SLOT_INTERVAL;

        // Filter valid candidates (at least 30 mins away)
        const candidates = availableSlots.map(s => {
            const [h, m] = s.startTime.split(':').map(Number);
            const slotMinutes = (h * 60) + m;
            return { ...s, diff: Math.abs(slotMinutes - originalInMinutes), slotMinutes };
        }).filter(s => s.diff >= buffer);

        if (candidates.length === 0) return null;

        // Sort by closest diff
        candidates.sort((a, b) => a.diff - b.diff);

        // Return the best candidate's label
        return candidates[0].slot;
    }
}
