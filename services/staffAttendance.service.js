import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

/**
 * StaffAttendanceService — clock in/out, attendance history, and punctuality reporting.
 */
export class StaffAttendanceService {
    /**
     * Clock in for today.
     */
    static async clockIn(userId, branchId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const now = new Date();

        // Upsert attendance record for today
        const record = await prisma.staffAttendance.upsert({
            where: {
                userId_date: { userId, date: today },
            },
            create: {
                userId,
                branchId,
                date: today,
                clockIn: now,
                status: 'PRESENT',
            },
            update: {
                clockIn: now,
                status: 'PRESENT',
                branchId,
            },
            include: {
                user: { select: { id: true, email: true, role: true } },
                branch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[Attendance] Clock-in: user ${userId} at ${now.toISOString()}`);
        return record;
    }

    /**
     * Clock out for today.
     */
    static async clockOut(userId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const now = new Date();

        const record = await prisma.staffAttendance.update({
            where: {
                userId_date: { userId, date: today },
            },
            data: {
                clockOut: now,
            },
            include: {
                user: { select: { id: true, email: true, role: true } },
                branch: { select: { id: true, name: true } },
            },
        });

        logger.info(`[Attendance] Clock-out: user ${userId} at ${now.toISOString()}`);
        return record;
    }

    /**
     * Get attendance history for a user.
     */
    static async getAttendance(userId, { startDate, endDate }) {
        const where = { userId };
        if (startDate || endDate) {
            where.date = {};
            if (startDate) where.date.gte = new Date(startDate);
            if (endDate) where.date.lte = new Date(endDate);
        }

        return prisma.staffAttendance.findMany({
            where,
            orderBy: { date: 'desc' },
            include: {
                branch: { select: { id: true, name: true } },
            },
        });
    }

    /**
     * Get all staff attendance for a branch on a specific date.
     * Flattens the display name onto each row — User has no fullName; the
     * canonical name lives on the role-specific profile (Doctor / Therapist
     * / Pharmacist / Patient). Frontend reads `row.fullName` directly.
     */
    static async getBranchAttendance(branchId, date) {
        const day = new Date(date);
        day.setHours(0, 0, 0, 0);

        const records = await prisma.staffAttendance.findMany({
            where: {
                branchId,
                date: day,
            },
            include: {
                user: {
                    select: {
                        id: true, email: true, role: true,
                        doctor:     { select: { fullName: true } },
                        therapist:  { select: { fullName: true } },
                        pharmacist: { select: { fullName: true } },
                        patient:    { select: { fullName: true } },
                    },
                },
            },
            orderBy: { clockIn: 'asc' },
        });

        return records.map((r) => ({
            ...r,
            fullName: _extractFullName(r.user),
        }));
    }

    /**
     * Get attendance stats for a user over a date range.
     */
    static async getAttendanceStats(userId, { startDate, endDate }) {
        const where = { userId };
        if (startDate || endDate) {
            where.date = {};
            if (startDate) where.date.gte = new Date(startDate);
            if (endDate) where.date.lte = new Date(endDate);
        }

        const records = await prisma.staffAttendance.findMany({ where });

        const presentDays = records.filter((r) => r.status === 'PRESENT').length;
        const lateDays = records.filter((r) => r.status === 'LATE').length;
        const absentDays = records.filter((r) => r.status === 'ABSENT').length;
        const halfDays = records.filter((r) => r.status === 'HALF_DAY').length;
        const leaveDays = records.filter((r) => r.status === 'LEAVE').length;

        const lateRecords = records.filter((r) => r.lateMinutes > 0);
        const avgLateMinutes =
            lateRecords.length > 0
                ? lateRecords.reduce((sum, r) => sum + r.lateMinutes, 0) / lateRecords.length
                : 0;

        return {
            totalDays: records.length,
            presentDays,
            lateDays,
            absentDays,
            halfDays,
            leaveDays,
            avgLateMinutes: Math.round(avgLateMinutes * 10) / 10,
        };
    }

    /**
     * Get punctuality report for all staff in a branch.
     */
    static async getPunctualityReport(branchId, { startDate, endDate }) {
        const where = { branchId };
        if (startDate || endDate) {
            where.date = {};
            if (startDate) where.date.gte = new Date(startDate);
            if (endDate) where.date.lte = new Date(endDate);
        }

        const records = await prisma.staffAttendance.findMany({
            where,
            include: {
                user: {
                    select: {
                        id: true, email: true, role: true,
                        doctor:     { select: { fullName: true } },
                        therapist:  { select: { fullName: true } },
                        pharmacist: { select: { fullName: true } },
                        patient:    { select: { fullName: true } },
                    },
                },
            },
        });

        // Group by user
        const grouped = {};
        for (const record of records) {
            const uid = record.userId;
            if (!grouped[uid]) {
                grouped[uid] = {
                    user: record.user,
                    fullName: _extractFullName(record.user),
                    totalDays: 0,
                    presentDays: 0,
                    lateDays: 0,
                    absentDays: 0,
                    totalLateMinutes: 0,
                };
            }
            grouped[uid].totalDays++;
            if (record.status === 'PRESENT') grouped[uid].presentDays++;
            if (record.status === 'LATE') grouped[uid].lateDays++;
            if (record.status === 'ABSENT') grouped[uid].absentDays++;
            grouped[uid].totalLateMinutes += record.lateMinutes;
        }

        return Object.values(grouped).map((entry) => ({
            ...entry,
            avgLateMinutes:
                entry.lateDays > 0
                    ? Math.round((entry.totalLateMinutes / entry.lateDays) * 10) / 10
                    : 0,
            punctualityRate:
                entry.totalDays > 0
                    ? Math.round(((entry.presentDays / entry.totalDays) * 100) * 10) / 10
                    : 0,
        }));
    }
}

/** Pick the clinical display name from whichever role profile is populated.
 *  Falls back to email (so something legible shows up for rare admin-only
 *  accounts) and finally null if nothing is available. */
function _extractFullName(user) {
    if (!user) return null;
    return user.doctor?.fullName
        ?? user.therapist?.fullName
        ?? user.pharmacist?.fullName
        ?? user.patient?.fullName
        ?? user.email
        ?? null;
}
