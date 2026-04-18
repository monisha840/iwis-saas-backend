import prisma from '../lib/prisma.js';

export class SearchService {
    /**
     * Global search across patients, appointments, and prescriptions.
     * Uses Prisma's `contains` with mode: 'insensitive' for PostgreSQL.
     */
    static async globalSearch(query, { userId, userRole, limit = 20 } = {}) {
        if (!query || query.trim().length < 2) {
            return { patients: [], appointments: [], prescriptions: [] };
        }

        const q = query.trim();
        const isAdmin = ['ADMIN', 'ADMIN_DOCTOR'].includes(userRole);

        // Build branch/assignment scoping for non-admin users
        let patientScope = {};
        let appointmentScope = {};

        if (!isAdmin && ['DOCTOR', 'THERAPIST'].includes(userRole)) {
            // Clinicians only see their assigned patients
            const clinician = await prisma.user.findUnique({
                where: { id: userId },
                include: { doctor: true, therapist: true }
            });
            if (clinician?.doctor) {
                appointmentScope = { doctorId: clinician.doctor.id };
            } else if (clinician?.therapist) {
                appointmentScope = { therapistId: clinician.therapist.id };
            }
        }

        const [patients, appointments, prescriptions] = await Promise.all([
            // Search patients by name, phone, patientId
            prisma.patient.findMany({
                where: {
                    ...patientScope,
                    OR: [
                        { fullName: { contains: q, mode: 'insensitive' } },
                        { phoneNumber: { contains: q, mode: 'insensitive' } },
                        { patientId: { contains: q, mode: 'insensitive' } },
                    ]
                },
                select: {
                    id: true, fullName: true, phoneNumber: true, patientId: true, userId: true,
                },
                take: limit,
            }),

            // Search appointments by patient name or status
            prisma.appointment.findMany({
                where: {
                    ...appointmentScope,
                    OR: [
                        { patient: { fullName: { contains: q, mode: 'insensitive' } } },
                        { status: { contains: q, mode: 'insensitive' } },
                        { notes: { contains: q, mode: 'insensitive' } },
                    ]
                },
                select: {
                    id: true, date: true, status: true, consultationType: true,
                    patient: { select: { fullName: true } },
                    doctor: { select: { fullName: true } },
                    therapist: { select: { fullName: true } },
                },
                take: limit,
                orderBy: { date: 'desc' },
            }),

            // Search prescriptions by medication name
            prisma.prescription.findMany({
                where: {
                    OR: [
                        { medicationName: { contains: q, mode: 'insensitive' } },
                        { patient: { fullName: { contains: q, mode: 'insensitive' } } },
                    ]
                },
                select: {
                    id: true, medicationName: true, dosage: true, frequency: true,
                    patient: { select: { fullName: true } },
                },
                take: limit,
            }),
        ]);

        return { patients, appointments, prescriptions };
    }

    /**
     * Search patients specifically (used by list endpoints).
     */
    static async searchPatients(query, { branchId, limit = 20 } = {}) {
        if (!query || query.trim().length < 2) return [];
        const q = query.trim();
        const where = {
            OR: [
                { fullName: { contains: q, mode: 'insensitive' } },
                { phoneNumber: { contains: q, mode: 'insensitive' } },
                { patientId: { contains: q, mode: 'insensitive' } },
            ]
        };
        if (branchId) where.branchId = branchId;

        return prisma.patient.findMany({
            where,
            select: {
                id: true, fullName: true, phoneNumber: true, patientId: true, userId: true,
                user: { select: { email: true } },
            },
            take: limit,
        });
    }
}
