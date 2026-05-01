import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * Therapy Room management (IWIS competitor feature 1)
 * Models rooms as a first-class bookable resource alongside therapists.
 */
export class TherapyRoomService {
    /**
     * List therapy rooms.
     *
     * Caller passes either `branchId` (single-branch view) or `hospitalId`
     * (cross-branch view, used when an admin picks "All Branches" from the
     * navbar scope switcher). At least one must be supplied — without
     * either, we'd return rooms across the whole platform.
     *
     * The `branch` relation is included so the cross-branch UI can label
     * rooms by their owning branch.
     */
    static async listRooms({ branchId, hospitalId } = {}) {
        if (!branchId && !hospitalId) {
            throw Object.assign(
                new Error('listRooms requires branchId or hospitalId'),
                { status: 400 },
            );
        }
        const where = { isActive: true };
        if (branchId) where.branchId = branchId;
        else where.branch = { hospitalId };
        return prisma.therapyRoom.findMany({
            where,
            orderBy: [{ type: 'asc' }, { name: 'asc' }],
            include: {
                _count: { select: { bookings: true } },
                branch: { select: { id: true, name: true } },
            },
        });
    }

    static validateRoomShape(data) {
        // A GROUP room without room for at least two people is a misconfiguration
        // — bookRoom's overlap check caps at capacity, so capacity=1 makes GROUP
        // behave like a private room.
        if (data?.type === 'GROUP' && typeof data.capacity === 'number' && data.capacity < 2) {
            throw Object.assign(new Error('GROUP rooms must have capacity >= 2'), { status: 400 });
        }
    }

    static async createRoom(data) {
        TherapyRoomService.validateRoomShape(data);
        return prisma.therapyRoom.create({ data });
    }

    static async updateRoom(id, data) {
        if (data?.type || data?.capacity != null) {
            const current = await prisma.therapyRoom.findUnique({ where: { id }, select: { type: true, capacity: true } });
            const merged = { type: data.type ?? current?.type, capacity: data.capacity ?? current?.capacity };
            TherapyRoomService.validateRoomShape(merged);
        }
        return prisma.therapyRoom.update({ where: { id }, data });
    }

    static async deactivateRoom(id) {
        return prisma.therapyRoom.update({ where: { id }, data: { isActive: false } });
    }

    /**
     * Build a minute-level availability view for a room on a given date.
     * Returns booked slots plus the room meta needed to render free ranges in UI.
     */
    static async getRoomAvailability(roomId, date) {
        const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
        const dayEnd   = new Date(date); dayEnd.setHours(23, 59, 59, 999);

        const room = await prisma.therapyRoom.findUnique({ where: { id: roomId } });
        if (!room) return null;

        const bookings = await prisma.therapyRoomBooking.findMany({
            where: { roomId, date: { gte: dayStart, lte: dayEnd } },
            include: {
                appointment: {
                    select: { id: true, patientId: true, doctorId: true, therapistId: true, status: true, consultationType: true }
                }
            },
            orderBy: { startTime: 'asc' },
        });

        return { room, bookings, date };
    }

    /**
     * Atomically reserve a room for an appointment. Enforces no overlapping
     * bookings inside a transaction so concurrent writes can't double-book.
     */
    static async bookRoom({ roomId, appointmentId, date, startTime, endTime, notes }) {
        return prisma.$transaction(async (tx) => {
            const room = await tx.therapyRoom.findUnique({ where: { id: roomId } });
            if (!room) throw Object.assign(new Error('Room not found'), { status: 404 });
            if (!room.isActive) throw Object.assign(new Error('Room is not active'), { status: 400 });

            // Overlap check: any booking whose time range intersects with the requested window.
            const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
            const dayEnd   = new Date(date); dayEnd.setHours(23, 59, 59, 999);
            const overlapping = await tx.therapyRoomBooking.findMany({
                where: {
                    roomId,
                    date: { gte: dayStart, lte: dayEnd },
                    AND: [{ startTime: { lt: endTime } }, { endTime: { gt: startTime } }],
                }
            });
            // A GROUP room may have capacity > 1; non-group rooms cap at 1.
            const limit = room.type === 'GROUP' ? room.capacity : 1;
            if (overlapping.length >= limit) {
                throw Object.assign(new Error('Room is already booked for this time range'), { status: 409 });
            }

            const booking = await tx.therapyRoomBooking.create({
                data: { roomId, appointmentId, date, startTime, endTime, notes },
            });
            await tx.appointment.update({ where: { id: appointmentId }, data: { therapyRoomId: roomId } });
            return booking;
        });
    }

    static async cancelBooking(id) {
        return prisma.$transaction(async (tx) => {
            const booking = await tx.therapyRoomBooking.findUnique({ where: { id } });
            if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
            await tx.therapyRoomBooking.delete({ where: { id } });
            await tx.appointment.update({ where: { id: booking.appointmentId }, data: { therapyRoomId: null } }).catch(() => {});
            return { success: true };
        });
    }

    static async getTherapistSchedule(therapistId, date) {
        const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
        const dayEnd   = new Date(date); dayEnd.setHours(23, 59, 59, 999);
        return prisma.appointment.findMany({
            where: { therapistId, date: { gte: dayStart, lte: dayEnd } },
            include: {
                patient: { include: { user: { select: { email: true } } } },
                therapyRoomBooking: { include: { room: true } },
            },
            orderBy: { date: 'asc' },
        });
    }
}
