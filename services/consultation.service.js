import prisma from '../lib/prisma.js';

export class ConsultationService {
    static async getAvailability(userId, role, therapistIdQuery) {
        const therapistRecord = await prisma.therapist.findUnique({ where: { userId } });
        if (!therapistRecord && role === 'THERAPIST') throw new Error('Therapist profile not found');

        return prisma.availability.findMany({
            where: {
                therapistId: role === 'ADMIN' ? therapistIdQuery : therapistRecord.id
            },
            orderBy: { dayOfWeek: 'asc' }
        });
    }

    static async addAvailability(userId, role, data) {
        const { dayOfWeek, startTime, endTime } = data;
        const therapistRecord = await prisma.therapist.findUnique({ where: { userId } });
        if (!therapistRecord) throw new Error('Therapist profile not found');

        return prisma.availability.create({
            data: {
                therapistId: therapistRecord.id,
                dayOfWeek,
                startTime,
                endTime,
                isApproved: role === 'ADMIN'
            }
        });
    }

    static async startSession(appointmentId) {
        const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
        if (!appointment) throw new Error('Appointment not found');

        let updateData = { status: 'IN_PROGRESS' };
        if (appointment.consultationMode === 'ONLINE' && !appointment.meetingLink) {
            updateData.meetingLink = `https://meet.jit.si/Alshifa-${appointment.id}`;
        }

        return prisma.appointment.update({
            where: { id: appointmentId },
            data: updateData
        });
    }

    static async saveNotes(appointmentId, sessionNotes) {
        return prisma.appointment.update({
            where: { id: appointmentId },
            data: { sessionNotes }
        });
    }

    static async completeSession(appointmentId) {
        return prisma.appointment.update({
            where: { id: appointmentId },
            data: { status: 'COMPLETED' }
        });
    }

    static async getTherapistStats(userId) {
        const therapistRecord = await prisma.therapist.findUnique({ where: { userId } });
        if (!therapistRecord) throw new Error('Therapist profile not found');

        const therapistId = therapistRecord.id;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const [todaySittingsCount, activePatients, totalCompleted] = await Promise.all([
            prisma.appointment.count({ where: { therapistId, date: { gte: today, lt: tomorrow } } }),
            prisma.appointment.groupBy({ by: ['patientId'], where: { therapistId, status: { not: 'COMPLETED' } } }),
            prisma.appointment.count({ where: { therapistId, status: 'COMPLETED' } })
        ]);

        return {
            todaySittings: todaySittingsCount,
            activeCases: activePatients.length,
            completedSittings: totalCompleted,
            hoursWorked: (totalCompleted * 0.75).toFixed(1),
            recoveryProgress: 75,
            sessionAdherence: 92,
        };
    }
}
