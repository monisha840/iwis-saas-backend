import prisma from '../lib/prisma.js';
import bcrypt from 'bcrypt';
import logger from '../lib/logger.js';

// AyurvedicSkill enum values — used to seed TherapistSkill rows when a
// therapist is created. Kept in sync with the Prisma enum (schema.prisma).
const THERAPIST_SKILLS = new Set([
    'ABHYANGA', 'SHIRODHARA', 'PANCHAKARMA_GENERAL', 'BASTI', 'VIRECHANA',
    'NASYA', 'KIZHI', 'NJAVARA', 'PIZHICHIL', 'MARMA_THERAPY', 'YOGA_THERAPY', 'NATUROPATHY',
]);

// Canonical gender values stored in DB. Legacy rows may be lowercase/mixed-case;
// canonicaliseGender() maps them to the canonical uppercase form on read/write.
const CANONICAL_GENDERS = new Set(['FEMALE', 'MALE', 'OTHER', 'PREFER_NOT_TO_SAY']);
function normaliseGender(input) {
    if (!input) return null;
    const upper = String(input).trim().toUpperCase().replace(/\s+/g, '_');
    if (CANONICAL_GENDERS.has(upper)) return upper;
    // Accept a handful of common free-form variants without failing the write.
    if (upper === 'F' || upper === 'WOMAN') return 'FEMALE';
    if (upper === 'M' || upper === 'MAN')   return 'MALE';
    return upper; // unknown — keep but canonicalised to upper
}

// Compute age (integer years) from a DOB string or Date. Returns null for invalid input.
function computeAge(dob) {
    if (!dob) return null;
    const d = dob instanceof Date ? dob : new Date(dob);
    if (Number.isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
}

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
            if (branchId) conditions.push({ OR: [{ branchId }, { branchId: null }] });
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
            include: {
                doctor: true, therapist: true, patient: true, pharmacist: true,
                branch: { select: { id: true, name: true, address: true } },
                hospital: { select: { id: true, name: true, slug: true, plan: true } },
            },
        });
        if (!user) throw new Error('User not found');

        // Derive age from dob so the API never returns a stale value. The stored
        // patient.age column is kept for query convenience but should never be
        // trusted as the source of truth.
        const patientPayload = user.patient
            ? {
                ...user.patient,
                onboardingCompleted: user.patient.onboardingCompleted,
                age: computeAge(user.patient.dob) ?? user.patient.age ?? null,
            }
            : null;

        return {
            id: user.id,
            email: user.email,
            role: user.role,
            createdAt: user.createdAt,
            emailVerifiedAt: user.emailVerifiedAt,
            mfaEnabled: user.mfaEnabled,
            branch: user.branch,
            hospital: user.hospital,
            doctor: user.doctor,
            therapist: user.therapist,
            pharmacist: user.pharmacist,
            patient: patientPayload,
        };
    }

    /**
     * Self-service profile update. Whitelisted fields only — role/branch/email
     * are identity/tenancy-level and require an admin.
     */
    static async updateMe(userId, data) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { doctor: true, therapist: true, patient: true, pharmacist: true },
        });
        if (!user) throw new Error('User not found');

        const {
            fullName, phoneNumber, profilePhoto, clinic,
            bio, languages,
            dob, gender: rawGender, therapyType,
        } = data || {};
        const gender = rawGender !== undefined ? normaliseGender(rawGender) : undefined;

        // Phone shape check — mirrors the appointment contact-details rule.
        if (phoneNumber && !/^\+?[0-9]{7,15}$/.test(phoneNumber.replace(/[\s-]/g, ''))) {
            const err = new Error('Invalid phone number format'); err.status = 400; throw err;
        }

        // Normalise languages once — trim, drop empties, dedupe (case-insensitive).
        const normalisedLanguages = languages !== undefined
            ? Array.from(new Map(
                languages
                    .map((l) => String(l || '').trim())
                    .filter(Boolean)
                    .map((l) => [l.toLowerCase(), l])
              ).values())
            : undefined;

        await prisma.$transaction(async (tx) => {
            if ((user.role === 'DOCTOR' || user.role === 'ADMIN_DOCTOR') && user.doctor) {
                await tx.doctor.update({
                    where: { id: user.doctor.id },
                    data: {
                        ...(fullName !== undefined && { fullName }),
                        ...(clinic !== undefined && { clinic: clinic || null }),
                        ...(profilePhoto !== undefined && { profilePhoto: profilePhoto || null }),
                        ...(phoneNumber !== undefined && { phoneNumber: phoneNumber || null }),
                        ...(bio !== undefined && { bio: bio || null }),
                        ...(normalisedLanguages !== undefined && { languages: normalisedLanguages }),
                    },
                });
            } else if (user.role === 'THERAPIST' && user.therapist) {
                await tx.therapist.update({
                    where: { id: user.therapist.id },
                    data: {
                        ...(fullName !== undefined && { fullName }),
                        ...(clinic !== undefined && { clinic: clinic || null }),
                        ...(profilePhoto !== undefined && { profilePhoto: profilePhoto || null }),
                        ...(phoneNumber !== undefined && { phoneNumber: phoneNumber || null }),
                        ...(bio !== undefined && { bio: bio || null }),
                        ...(normalisedLanguages !== undefined && { languages: normalisedLanguages }),
                    },
                });
            } else if (user.role === 'PHARMACIST' && user.pharmacist) {
                await tx.pharmacist.update({
                    where: { id: user.pharmacist.id },
                    data: {
                        ...(fullName !== undefined && { fullName }),
                        ...(profilePhoto !== undefined && { profilePhoto: profilePhoto || null }),
                        ...(phoneNumber !== undefined && { phoneNumber: phoneNumber || null }),
                        ...(bio !== undefined && { bio: bio || null }),
                        ...(normalisedLanguages !== undefined && { languages: normalisedLanguages }),
                    },
                });
            } else if (user.role === 'PATIENT' && user.patient) {
                const dobDate = dob ? new Date(dob + 'T00:00:00Z') : undefined;
                const age = dobDate
                    ? Math.floor((Date.now() - dobDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
                    : undefined;
                await tx.patient.update({
                    where: { id: user.patient.id },
                    data: {
                        ...(fullName !== undefined && { fullName }),
                        ...(phoneNumber !== undefined && { phoneNumber: phoneNumber || null }),
                        ...(profilePhoto !== undefined && { profilePhoto: profilePhoto || null }),
                        ...(dobDate !== undefined && { dob: dobDate }),
                        ...(age !== undefined && { age }),
                        ...(gender !== undefined && { gender: gender || null }),
                        ...(therapyType !== undefined && { therapyType: therapyType || null }),
                    },
                });
            }
            // ADMIN / SUPER_ADMIN have no role-specific profile row; nothing to update.
        });

        return this.getCurrentUser(userId);
    }

    static async updateOnboarding(userId, data) {
        const patient = await prisma.patient.findUnique({ where: { userId } });
        if (!patient) throw new Error('Patient profile not found');

        // Only award zen points on the *first* completion — prevents farming by
        // repeatedly re-submitting the onboarding endpoint.
        const isFirstCompletion = !patient.onboardingCompleted;

        return prisma.patient.update({
            where: { id: patient.id },
            data: {
                gender: data.gender || patient.gender,
                onboardingCompleted: true,
                onboardingData: data,
                ...(isFirstCompletion && { zenPoints: { increment: 50 } }),
            }
        });
    }

    /**
     * "My Patients" — reads from the PatientAssignment join table so
     * admin-made assignments propagate immediately.
     *
     * For THERAPIST we fall back to Journey (legacy) since therapists aren't
     * tracked in PatientAssignment yet — a future iteration can promote
     * Therapist onto PatientAssignment if needed.
     */
    static async getAssignedPatients(userId, role) {
        if (role === 'THERAPIST') {
            const therapist = await prisma.therapist.findUnique({ where: { userId } });
            if (!therapist) throw new Error('Therapist profile not found');
            const journeys = await prisma.journey.findMany({
                where:   { therapistId: therapist.id },
                include: { patient: { include: { user: { select: { email: true } } } } },
            });
            return journeys.map((j) => ({
                id:           j.patient.id,
                userId:       j.patient.userId,
                fullName:     j.patient.fullName,
                email:        j.patient.user?.email,
                phoneNumber:  j.patient.phoneNumber,
                status:       j.status,
                journeyType:  j.status,
            }));
        }

        if (role !== 'DOCTOR' && role !== 'ADMIN_DOCTOR') {
            throw new Error('Unauthorized role');
        }
        const doctor = await prisma.doctor.findUnique({ where: { userId } });
        if (!doctor) throw new Error('Doctor profile not found');

        // Branch scope — DOCTOR sees only their own branch; ADMIN_DOCTOR
        // sees all their assignments hospital-wide.
        const userBranchId = (await prisma.user.findUnique({ where: { id: userId } }))?.branchId;
        const where = {
            doctorId: doctor.id,
            status:   'ACTIVE',
            ...(userBranchId && role !== 'ADMIN_DOCTOR'
                ? { patient: { branchId: userBranchId } }
                : {}),
        };

        const assignments = await prisma.patientAssignment.findMany({
            where,
            include: {
                patient: {
                    include: {
                        user:    { select: { email: true } },
                        journeys: {
                            where:   { status: { in: ['IN_PROGRESS', 'ACTIVE'] } },
                            select:  { status: true, completedSessions: true, totalSessions: true },
                            orderBy: { createdAt: 'desc' },
                            take:    1,
                        },
                    },
                },
            },
            orderBy: { assignedAt: 'desc' },
        });

        return assignments.map((a) => {
            const journey = a.patient.journeys[0];
            return {
                id:                a.patient.id,
                userId:            a.patient.userId,
                fullName:          a.patient.fullName,
                email:             a.patient.user?.email,
                phoneNumber:       a.patient.phoneNumber,
                assignmentId:      a.id,
                assignmentType:    a.type,
                assignedAt:        a.assignedAt,
                status:            journey?.status || 'ACTIVE',
                completedSittings: journey?.completedSessions ?? 0,
                totalSittings:     journey?.totalSessions ?? 0,
                journeyType:       journey?.status || null,
            };
        });
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
        const {
            email, password, role, fullName, branchId: inputBranchId,
            phoneNumber, dob, gender: rawGender, therapyType,
            specialization, qualification, yearsExperience, clinic,
            registrationNumber,
            initialSkills,
        } = data;
        // Canonicalise gender to uppercase so downstream checks (e.g. pregnancy toggle)
        // don't have to worry about mixed-case history (Female / female / FEMALE).
        const gender = normaliseGender(rawGender);

        const branchId = await this._validateBranchId(inputBranchId);
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            const error = new Error('Email already registered');
            error.status = 409;
            throw error;
        }

        // rounds=12 to match AuthService.BCRYPT_ROUNDS (password reset flow).
        // Previously 10 — weaker than reset-initiated hashes. Unified here.
        const hashed = await bcrypt.hash(password, 12);
        return prisma.$transaction(async (tx) => {
            const newUser = await tx.user.create({ data: { email, password: hashed, role, branchId } });

            // Note: Doctor, Therapist, and Pharmacist schemas DO NOT include branchId.
            // Branch isolation for them is handled via the User record.
            if (role === 'DOCTOR' || role === 'ADMIN_DOCTOR') {
                await tx.doctor.create({
                    data: {
                        userId: newUser.id,
                        fullName,
                        specialization,
                        qualification,
                        yearsExperience,
                        clinic: clinic || null,
                        registrationNumber: registrationNumber || null,
                    },
                });
            } else if (role === 'THERAPIST') {
                const therapist = await tx.therapist.create({
                    data: {
                        userId: newUser.id,
                        fullName,
                        specialization,
                        qualification,
                        yearsExperience,
                        clinic: clinic || null,
                        registrationNumber: registrationNumber || null,
                    },
                });
                // Seed the therapist's skill matrix. Primary specialization is
                // always added as CERTIFIED (if it maps to an enum value);
                // additional picks default to EXPERIENCED. De-duped so a skill
                // listed in both slots only produces one row.
                const skillSet = new Map();
                if (specialization && THERAPIST_SKILLS.has(specialization)) {
                    skillSet.set(specialization, 'CERTIFIED');
                }
                if (Array.isArray(initialSkills)) {
                    for (const s of initialSkills) {
                        if (!skillSet.has(s)) skillSet.set(s, 'EXPERIENCED');
                    }
                }
                if (skillSet.size > 0) {
                    await tx.therapistSkill.createMany({
                        data: Array.from(skillSet.entries()).map(([skill, proficiency]) => ({
                            therapistId: therapist.id,
                            skill,
                            proficiency,
                        })),
                        skipDuplicates: true,
                    });
                }
            } else if (role === 'PATIENT') {
                const dobDate = dob ? new Date(dob + 'T00:00:00Z') : null;
                const age = dobDate
                    ? Math.floor((Date.now() - dobDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
                    : null;
                await tx.patient.create({
                    data: {
                        userId: newUser.id,
                        fullName,
                        branchId,
                        phoneNumber: phoneNumber || null,
                        dob: dobDate,
                        age,
                        gender: gender || null,
                        therapyType: therapyType || null,
                    },
                });
            } else if (role === 'PHARMACIST') {
                await tx.pharmacist.create({
                    data: {
                        userId: newUser.id,
                        fullName,
                        qualification,
                        yearsExperience,
                    },
                });
            }
            return newUser;
        });
    }

    /**
     * Assign a patient to a doctor.
     *
     * Writes to the PatientAssignment join table — the canonical source of
     * truth for "who's looking after this patient". Doctor-side reads
     * (`getAssignedPatients`) use the same table, so assignments propagate
     * immediately.
     *
     * Behaviour for PRIMARY (default):
     *   - Any existing ACTIVE PRIMARY for the patient is flipped to REPLACED
     *     inside the same transaction (preserves history, enforces the
     *     "one primary at a time" invariant).
     *
     * Branch parity is enforced unless the caller is ADMIN (ADMINs can
     * reassign cross-branch, e.g. when sharing staff between clinics).
     */
    static async assignPatient({ patientId, doctorId, assignedById, type = 'PRIMARY', reason = null, allowCrossBranch = false }) {
        const [patient, doctor] = await Promise.all([
            prisma.patient.findUnique({ where: { id: patientId }, include: { user: true } }),
            prisma.doctor.findUnique({  where: { id: doctorId },  include: { user: true } }),
        ]);
        if (!patient) { const e = new Error('Patient not found'); e.status = 404; throw e; }
        if (!doctor)  { const e = new Error('Doctor not found');  e.status = 404; throw e; }

        if (!allowCrossBranch
            && patient.branchId
            && doctor.user?.branchId
            && patient.branchId !== doctor.user.branchId) {
            const e = new Error('Cross-branch assignment is restricted to full admins');
            e.status = 403;
            throw e;
        }

        // Is this doctor *already* the active primary? Treat as a no-op so
        // clicking Assign twice doesn't create duplicate history rows.
        const existingForDoctor = await prisma.patientAssignment.findFirst({
            where: { patientId, doctorId, type, status: 'ACTIVE' },
        });
        if (existingForDoctor) return existingForDoctor;

        return prisma.$transaction(async (tx) => {
            if (type === 'PRIMARY') {
                // Replace (not delete) any existing active primary so the
                // history trail is preserved for audit.
                await tx.patientAssignment.updateMany({
                    where: { patientId, type: 'PRIMARY', status: 'ACTIVE' },
                    data:  { status: 'REPLACED', endedAt: new Date(), endReason: 'Replaced by new assignment' },
                });
            }
            return tx.patientAssignment.create({
                data: {
                    patientId, doctorId, type,
                    status: 'ACTIVE',
                    reason,
                    assignedById,
                },
                include: {
                    doctor:  { select: { id: true, fullName: true, specialization: true } },
                    patient: { select: { id: true, fullName: true } },
                },
            });
        });
    }

    /**
     * End an active assignment. Row status goes to ENDED (not deleted) to
     * preserve history. Pass `type` to disambiguate when a patient has
     * multiple active non-primary assignments with the same doctor.
     */
    static async unassignPatient({ patientId, doctorId, endedById, endReason = null, type }) {
        const where = { patientId, doctorId, status: 'ACTIVE' };
        if (type) where.type = type;

        const existing = await prisma.patientAssignment.findMany({ where });
        if (existing.length === 0) {
            const e = new Error('No active assignment found for this patient/doctor');
            e.status = 404;
            throw e;
        }

        await prisma.patientAssignment.updateMany({
            where,
            data: {
                status:    'ENDED',
                endedAt:   new Date(),
                endReason: endReason || null,
            },
        });
        // eslint-disable-next-line no-unused-vars
        const _auditedBy = endedById; // reserved for future audit-trail write
        return { patientId, doctorId, endedCount: existing.length };
    }

    /**
     * Current active assignments for a patient — what the AssignPatient UI
     * shows as "Currently assigned to: Dr. X" before the admin overrides.
     */
    static async getPatientAssignments(patientId, { status = 'ACTIVE' } = {}) {
        return prisma.patientAssignment.findMany({
            where: { patientId, ...(status ? { status } : {}) },
            include: {
                doctor:     { select: { id: true, fullName: true, specialization: true } },
                assignedBy: { select: { id: true, email: true } },
            },
            orderBy: { assignedAt: 'desc' },
        });
    }

    /**
     * Patients in a branch (or whole hospital for ADMIN) that have no
     * ACTIVE PRIMARY assignment. Drives the "Unassigned only" filter and
     * the AdminDashboard "Unassigned Patients" card.
     */
    static async listUnassignedPatients({ branchId = null, hospitalId = null } = {}) {
        const patients = await prisma.patient.findMany({
            where: {
                ...(branchId   ? { branchId } : {}),
                ...(hospitalId ? { user: { hospitalId } } : {}),
                user: { deletedAt: null },
            },
            include: {
                user:                { select: { id: true, email: true, branchId: true } },
                branch:              { select: { id: true, name: true } },
                patientAssignments:  {
                    where:  { type: 'PRIMARY', status: 'ACTIVE' },
                    select: { id: true },
                },
            },
        });
        return patients
            .filter((p) => p.patientAssignments.length === 0)
            .map((p) => ({
                id: p.id, fullName: p.fullName, email: p.user?.email,
                phoneNumber: p.phoneNumber, branchId: p.branchId, branchName: p.branch?.name,
            }));
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
        const { email, branchId, ...profileData } = data;
        let profile;
        if (type === 'doctor') profile = await prisma.doctor.findUnique({ where: { id }, include: { user: true } });
        else if (type === 'therapist') profile = await prisma.therapist.findUnique({ where: { id }, include: { user: true } });
        else if (type === 'patient') profile = await prisma.patient.findUnique({ where: { id }, include: { user: true } });
        else if (type === 'pharmacist') profile = await prisma.pharmacist.findUnique({ where: { id }, include: { user: true } });

        if (!profile) throw new Error(`${type} not found`);

        // Validate branchId if provided
        if (branchId) {
            await this._validateBranchId(branchId);
        }

        return prisma.$transaction(async (tx) => {
            // Update email if changed
            if (email && email !== profile.user.email) {
                if (await tx.user.findUnique({ where: { email } })) throw new Error('Email already in use');
                await tx.user.update({ where: { id: profile.userId }, data: { email } });
            }

            // Branch transfer: update the User record's branchId
            if (branchId && branchId !== profile.user.branchId) {
                const oldBranchId = profile.user.branchId;
                await tx.user.update({ where: { id: profile.userId }, data: { branchId } });

                // For patients, also update the Patient record's own branchId
                if (type === 'patient') {
                    await tx.patient.update({ where: { id }, data: { branchId } });
                }

                // Audit the branch transfer
                await tx.auditLog.create({
                    data: {
                        userId: profile.userId,
                        action: 'BRANCH_TRANSFER',
                        entityType: type.toUpperCase(),
                        entityId: id,
                        oldData: { branchId: oldBranchId },
                        newData: { branchId },
                    }
                });
            }

            // Update role-specific profile fields
            if (type === 'doctor') return tx.doctor.update({ where: { id }, data: profileData });
            if (type === 'therapist') return tx.therapist.update({ where: { id }, data: profileData });
            if (type === 'patient') return tx.patient.update({ where: { id }, data: profileData });
            if (type === 'pharmacist') return tx.pharmacist.update({ where: { id }, data: profileData });
        });
    }
}
