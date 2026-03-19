import prisma from '../lib/prisma.js';
import bcrypt from 'bcrypt';
import logger from '../lib/logger.js';


export class UserService {
    static async listTherapists({ search = '', branchId = null } = {}) {
        try {
            // Build root-level AND conditions so that the OR search clause does not
            // inadvertently bypass the deletedAt / branchId guards.
            const conditions = [{ user: { deletedAt: null } }];
            if (branchId) conditions.push({ user: { branchId } });
            if (search)   conditions.push({ fullName: { contains: search, mode: 'insensitive' } });
            const where = conditions.length === 1 ? conditions[0] : { AND: conditions };

            const therapists = await prisma.therapist.findMany({
                where,
                include: { user: { include: { branch: true } } }
            });
            return therapists.map((ther) => ({
                id: ther.id,
                fullName: ther.fullName,
                specialization: ther.specialization,
                profilePhoto: ther.profilePhoto,
                yearsExperience: ther.yearsExperience,
                qualification: ther.qualification,
                clinic: ther.clinic,
                email: ther.user?.email,
                branchId: ther.user?.branchId,
                branchName: ther.user?.branch?.name,
            }));
        } catch (err) {
            logger.error('[UserService.listTherapists]', err);
            throw err;
        }
    }

    static async getClinicalGamification() {
        const [doctors, therapists] = await Promise.all([
            prisma.doctor.findMany({
                where: { user: { role: { notIn: ['ADMIN', 'ADMIN_DOCTOR'] } } },
                include: {
                    user: true,
                    appointments: true,
                    journeys: true,
                },
            }),
            prisma.therapist.findMany({
                where: { user: { role: { notIn: ['ADMIN', 'ADMIN_DOCTOR'] } } },
                include: {
                    user: true,
                    appointments: true,
                    journeys: true,
                },
            })
        ]);

        const clinicians = [...doctors, ...therapists];

        const stats = clinicians.map((clinician) => {
            const appointmentCount = clinician.appointments.length;
            const journeys = clinician.journeys || [];
            let totalExpectedSessions = 0;
            let totalCompletedSessions = 0;
            journeys.forEach(j => {
                totalExpectedSessions += j.totalSessions || 0;
                totalCompletedSessions += j.completedSessions || 0;
            });

            const recoveryRate = totalExpectedSessions > 0 ? Math.round((totalCompletedSessions / totalExpectedSessions) * 100) : 0;
            const uniquePatientsCount = new Set(journeys.map(j => j.patientId)).size;
            const completedJourneysCount = journeys.filter(j => j.status === 'COMPLETED').length;
            const volumeScore = Math.min((appointmentCount / 100) * 100, 100);
            const excellenceScore = Math.round((recoveryRate * 0.7) + (volumeScore * 0.3));

            return {
                id: clinician.id,
                fullName: clinician.fullName,
                specialization: clinician.specialization,
                profilePhoto: clinician.profilePhoto,
                email: clinician.user?.email,
                role: clinician.user?.role,
                appointmentCount,
                recoveryRate,
                uniquePatientsCount,
                completedJourneysCount,
                excellenceScore,
            };
        });

        return stats.sort((a, b) => b.excellenceScore - a.excellenceScore || b.appointmentCount - a.appointmentCount);
    }

    static async listDoctors(options = null) {
        // Supports legacy positional call listDoctors(branchId) and new object form listDoctors({ branchId, search })
        const branchId = typeof options === 'string' ? options : (options?.branchId ?? null);
        const search   = typeof options === 'string' ? ''      : (options?.search   ?? '');

        try {
            // Build root-level AND conditions so each filter is composed cleanly
            const conditions = [{ user: { deletedAt: null } }];
            if (branchId) conditions.push({ user: { branchId } });
            if (search)   conditions.push({ fullName: { contains: search, mode: 'insensitive' } });
            const where = conditions.length === 1 ? conditions[0] : { AND: conditions };

            const doctors = await prisma.doctor.findMany({
                where,
                include: { user: { include: { branch: true } }, _count: { select: { appointments: true } } }
            });
            return doctors.map((doc) => ({
                id: doc.id,
                fullName: doc.fullName,
                specialization: doc.specialization,
                profilePhoto: doc.profilePhoto,
                yearsExperience: doc.yearsExperience,
                qualification: doc.qualification,
                clinic: doc.clinic,
                email: doc.user?.email,
                branchId: doc.user?.branchId,
                branchName: doc.user?.branch?.name,
                appointmentCount: doc._count?.appointments || 0,
            }));
        } catch (err) {
            logger.error('[UserService.listDoctors]', err);
            throw err;
        }
    }

    static async listPharmacists() {
        try {
            const pharmacists = await prisma.pharmacist.findMany({
                where: { user: { deletedAt: null } },
                include: { user: true }
            });
            return pharmacists.map((pharma) => ({
                id: pharma.id,
                userId: pharma.userId,
                fullName: pharma.fullName,
                profilePhoto: pharma.profilePhoto,
                yearsExperience: pharma.yearsExperience,
                qualification: pharma.qualification,
                email: pharma.user?.email,
            }));
        } catch (err) {
            logger.error('[UserService.listPharmacists]', err);
            throw err;
        }
    }

    static async listPatients({ search = '', branchId = null } = {}) {
        try {
            // Use explicit AND so that the OR search clause is scoped correctly alongside
            // the user.deletedAt filter and the optional branchId filter. Without explicit
            // AND, a root-level OR could shadow the sibling filter keys in some Prisma versions.
            const conditions = [{ user: { deletedAt: null } }];
            if (branchId) conditions.push({ branchId });
            if (search) {
                conditions.push({
                    OR: [
                        { fullName:    { contains: search, mode: 'insensitive' } },
                        { patientId:   { contains: search, mode: 'insensitive' } },
                        { phoneNumber: { contains: search, mode: 'insensitive' } },
                    ],
                });
            }
            const where = conditions.length === 1 ? conditions[0] : { AND: conditions };

            const patients = await prisma.patient.findMany({
                where,
                include: { user: true, branch: true }
            });
            return patients.map((pat) => ({
                id: pat.id,
                fullName: pat.fullName,
                dob: pat.dob,
                age: pat.age,
                gender: pat.gender,
                phoneNumber: pat.phoneNumber,
                patientId: pat.patientId,
                therapyType: pat.therapyType,
                email: pat.user?.email,
                branchId: pat.branchId,
                branchName: pat.branch?.name,
            }));
        } catch (err) {
            logger.error('[UserService.listPatients]', err);
            throw err;
        }
    }

    static async getCurrentUser(userId) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { doctor: true, therapist: true, patient: true, pharmacist: true },
        });
        if (!user) throw new Error('User not found');
        return {
            id: user.id, email: user.email, role: user.role,
            doctor: user.doctor, therapist: user.therapist, pharmacist: user.pharmacist,
            patient: user.patient ? { ...user.patient, onboardingCompleted: user.patient.onboardingCompleted } : null,
        };
    }

    static async updateOnboarding(userId, data) {
        const patient = await prisma.patient.findUnique({ where: { userId } });
        if (!patient) throw new Error('Patient profile not found');
        return prisma.patient.update({
            where: { id: patient.id },
            data: {
                gender: data.gender || patient.gender,
                onboardingCompleted: true,
                onboardingData: data,
                zenPoints: { increment: 50 }
            }
        });
    }

    static async getAssignedPatients(userId, role) {
        let where = {};
        if (role === 'THERAPIST') {
            const therapist = await prisma.therapist.findUnique({ where: { userId } });
            if (!therapist) throw new Error('Therapist profile not found');
            where = { therapistId: therapist.id };
        } else if (role === 'DOCTOR' || role === 'ADMIN_DOCTOR') {
            const doctor = await prisma.doctor.findUnique({ where: { userId } });
            if (!doctor) throw new Error('Doctor profile not found');
            where = { doctorId: doctor.id };
        } else {
            throw new Error('Unauthorized role');
        }

        const userBranchId = (await prisma.user.findUnique({ where: { id: userId } }))?.branchId;
        if (userBranchId && role !== 'ADMIN_DOCTOR') {
            where.patient = { branchId: userBranchId };
        }

        const journeys = await prisma.journey.findMany({
            where,
            include: {
                patient: {
                    include: { user: { select: { email: true } } }
                }
            }
        });

        return journeys.map(j => ({
            id: j.patient.id,
            userId: j.patient.userId,
            fullName: j.patient.fullName,
            email: j.patient.user?.email,
            phoneNumber: j.patient.phoneNumber,
            status: j.status,
            completedSittings: j.completedSessions,
            totalSittings: j.totalSessions,
            journeyType: j.status
        }));
    }

    static async _validateBranchId(branchId) {
        if (!branchId) return null;
        const branch = await prisma.branch.findUnique({ where: { id: branchId } });
        if (!branch) {
            const error = new Error('Invalid branchId: Branch does not exist');
            error.status = 400;
            throw error;
        }
        return branchId;
    }

    static async createUser(data) {
        const { email, password, role, fullName, branchId: inputBranchId } = data;
        const branchId = await this._validateBranchId(inputBranchId);
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            const error = new Error('Email already registered');
            error.status = 409;
            throw error;
        }

        const hashed = await bcrypt.hash(password, 10);
        return prisma.$transaction(async (tx) => {
            const newUser = await tx.user.create({ data: { email, password: hashed, role, branchId } });

            // Note: Doctor, Therapist, and Pharmacist schemas DO NOT include branchId.
            // Branch isolation for them is handled via the User record.
            const profileData = { userId: newUser.id, fullName };

            if (role === 'DOCTOR' || role === 'ADMIN_DOCTOR') {
                await tx.doctor.create({ data: { ...profileData, userId: newUser.id } });
            } else if (role === 'THERAPIST') {
                await tx.therapist.create({ data: profileData });
            } else if (role === 'PATIENT') {
                await tx.patient.create({ data: { ...profileData, branchId } });
            } else if (role === 'PHARMACIST') {
                await tx.pharmacist.create({ data: profileData });
            }
            return newUser;
        });
    }

    static async assignPatient(data) {
        const { patientId, doctorId } = data;
        const [patient, doctor] = await Promise.all([
            prisma.patient.findUnique({ where: { id: patientId }, include: { user: true } }),
            prisma.doctor.findUnique({ where: { id: doctorId }, include: { user: true } })
        ]);

        if (!patient || !doctor) throw new Error('Patient or Doctor not found');

        // Branch Parity Check
        if (patient.branchId && doctor.user?.branchId && patient.branchId !== doctor.user.branchId) {
            throw new Error('Cross-branch assignment is restricted to administrators');
        }

        // Real-time Availability Check
        const { AvailabilityService } = await import('./availability.service.js');
        const now = new Date();
        const startTime = now.toTimeString().slice(0, 5);
        const endTime = new Date(now.getTime() + 60 * 60 * 1000).toTimeString().slice(0, 5);

        const availability = await AvailabilityService.checkAvailability(
            doctorId,
            now.toISOString(),
            startTime,
            endTime
        );

        if (!availability.available) {
            const availableSlots = await AvailabilityService.getAvailableSlots(doctorId, now);
            const error = new Error(`Doctor is currently unavailable: ${availability.reason}`);
            error.status = 403;
            error.availableSlots = availableSlots;
            throw error;
        }

        return prisma.appointment.create({
            data: {
                patientId: patient.id,
                doctorId: doctor.id,
                date: now,
                status: 'ASSIGNED',
                branchId: patient.branchId
            },
        });
    }

    static async getPatientById(requestedPatientId, user) {
        const isAdmin = ['ADMIN', 'ADMIN_DOCTOR'].includes(user.role);
        const isOwnProfile = user.role === 'PATIENT' && (user.patient?.id === requestedPatientId || user.id === requestedPatientId);

        const patient = await prisma.patient.findUnique({
            where: { id: requestedPatientId },
            include: {
                user: true,
                branch: true,
                appointments: { include: { doctor: { include: { user: true } }, therapist: { include: { user: true } } } },
                triageSessions: { orderBy: { createdAt: 'desc' }, take: 1 } // Fetch latest triage session
            },
        });
        if (!patient) throw new Error('Patient not found');

        // Branch Isolation Check
        if (!isAdmin && user.branchId && patient.branchId !== user.branchId && !isOwnProfile) {
            throw new Error('Forbidden: Patient belongs to another branch');
        }
        return { ...patient, email: patient.user?.email };
    }

    static async getDoctorStats(userId) {
        const doctorRecord = await prisma.doctor.findUnique({ where: { userId } });
        if (!doctorRecord) throw new Error('Doctor profile not found');
        const doctorId = doctorRecord.id;

        const journeys = await prisma.journey.findMany({
            where: { doctorId },
            include: { patient: true, medications: true }
        });

        const activeJourneys = journeys.filter(j => j.status === 'ACTIVE' || j.status === 'AT_RISK');
        const atRiskJourneys = journeys.filter(j => j.status === 'AT_RISK');
        const wellnessEligibleJourneys = journeys.filter(j =>
            j.status === 'ACTIVE' && j.totalSessions > 0 && (j.completedSessions / j.totalSessions) >= 0.8
        );

        let totalProgress = 0;
        journeys.forEach(j => { if (j.totalSessions > 0) totalProgress += (j.completedSessions / j.totalSessions) * 100; });
        const recoveryProgress = journeys.length > 0 ? Math.round(totalProgress / journeys.length) : 0;

        let totalTaken = 0, totalLogs = 0;
        journeys.forEach(j => { j.medications.forEach(m => { totalLogs++; if (m.taken) totalTaken++; }); });
        const medicationAdherence = totalLogs > 0 ? Math.round((totalTaken / totalLogs) * 100) : 0;

        return {
            activeJourneys: activeJourneys.length,
            atRisk: atRiskJourneys.length,
            wellnessEligible: wellnessEligibleJourneys.length,
            completed: journeys.filter(j => j.status === 'COMPLETED').length,
            recoveryProgress, medicationAdherence,
            patientsNeedingAttention: atRiskJourneys.map(j => ({ id: j.id, name: j.patient.fullName, reason: j.progressNotes || "Needs clinical review", status: "needs-attention" })).slice(0, 5),
            patientsNearingWellness: wellnessEligibleJourneys.map(j => ({ id: j.id, name: j.patient.fullName, sittings: { current: j.completedSessions, total: j.totalSessions }, status: "on-track" })).slice(0, 5)
        };
    }

    static async getAdminStats() {
        const [totalPatients, journeys] = await Promise.all([
            prisma.patient.count(),
            prisma.journey.findMany({ include: { patient: true, doctor: true } })
        ]);

        const activeJourneys = journeys.filter(j => j.status === 'ACTIVE' || j.status === 'AT_RISK');
        const atRiskJourneys = journeys.filter(j => j.status === 'AT_RISK');
        const wellnessEligibleJourneys = journeys.filter(j =>
            j.status === 'ACTIVE' && j.totalSessions > 0 && (j.completedSessions / j.totalSessions) >= 0.8
        );

        return {
            activeJourneys: activeJourneys.length,
            atRisk: atRiskJourneys.length,
            wellnessEligible: wellnessEligibleJourneys.length,
            completed: journeys.filter(j => j.status === 'COMPLETED').length,
            totalPatients,
            atRiskJourneys: atRiskJourneys.map(j => ({ id: j.id, patientName: j.patient.fullName, doctorName: j.doctor?.fullName, reason: j.progressNotes, status: "at-risk" })).slice(0, 10),
            wellnessEligibleJourneys: wellnessEligibleJourneys.map(j => ({ id: j.id, patientName: j.patient.fullName, sittings: { current: j.completedSessions, total: j.totalSessions }, status: "on-track" })).slice(0, 10),
            recentAlerts: atRiskJourneys.map(j => ({ id: `alert-${j.id}`, message: `Critical: ${j.patient.fullName} at risk. Review with Dr. ${j.doctor?.fullName}.`, priority: 1 })).slice(0, 5)
        };
    }

    static async deleteUser(type, id) {
        let profile;
        if (type === 'doctor') profile = await prisma.doctor.findUnique({ where: { id }, include: { user: true } });
        else if (type === 'therapist') profile = await prisma.therapist.findUnique({ where: { id }, include: { user: true } });
        else if (type === 'patient') profile = await prisma.patient.findUnique({ where: { id }, include: { user: true } });
        else if (type === 'pharmacist') profile = await prisma.pharmacist.findUnique({ where: { id }, include: { user: true } });

        if (!profile) throw new Error(`${type} not found`);
        return prisma.user.update({ where: { id: profile.userId }, data: { deletedAt: new Date() } });
    }

    static async updateProfile(type, id, data) {
        const { email, ...profileData } = data;
        let profile;
        if (type === 'doctor') profile = await prisma.doctor.findUnique({ where: { id }, include: { user: true } });
        else if (type === 'therapist') profile = await prisma.therapist.findUnique({ where: { id }, include: { user: true } });
        else if (type === 'patient') profile = await prisma.patient.findUnique({ where: { id }, include: { user: true } });
        else if (type === 'pharmacist') profile = await prisma.pharmacist.findUnique({ where: { id }, include: { user: true } });

        if (!profile) throw new Error(`${type} not found`);

        return prisma.$transaction(async (tx) => {
            if (email && email !== profile.user.email) {
                if (await tx.user.findUnique({ where: { email } })) throw new Error('Email already in use');
                await tx.user.update({ where: { id: profile.userId }, data: { email } });
            }
            if (type === 'doctor') return tx.doctor.update({ where: { id }, data: profileData });
            if (type === 'therapist') return tx.therapist.update({ where: { id }, data: profileData });
            if (type === 'patient') return tx.patient.update({ where: { id }, data: profileData });
            if (type === 'pharmacist') return tx.pharmacist.update({ where: { id }, data: profileData });
        });
    }
}
