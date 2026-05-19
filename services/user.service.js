import prisma from '../lib/prisma.js';
import bcrypt from 'bcrypt';
import logger from '../lib/logger.js';
import { geocodePatientAddress } from './geocoding.service.js';

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
    /**
     * Upsert the flattened UserSnapshot row for a given userId. Called from
     * createUser, deleteUser, and any role-specific update endpoint so the
     * admin export endpoint can serve a single denormalised query without
     * having to join across Doctor / Therapist / Patient / Pharmacist.
     *
     * Failures here MUST NOT roll back the parent operation — we log and
     * continue. The snapshot is a reporting cache, not the source of truth.
     */
    static async upsertSnapshot(userId, { tx } = {}) {
        const client = tx || prisma;
        try {
            const u = await client.user.findUnique({
                where: { id: userId },
                include: {
                    branch:     { select: { id: true, name: true } },
                    doctor:     { select: { fullName: true } },
                    therapist:  { select: { fullName: true } },
                    patient:    { select: { fullName: true, phoneNumber: true } },
                    pharmacist: { select: { fullName: true } },
                },
            });
            if (!u) return;

            const fullName = u.doctor?.fullName
                ?? u.therapist?.fullName
                ?? u.patient?.fullName
                ?? u.pharmacist?.fullName
                ?? null;
            const status = u.deletedAt ? 'DELETED'
                : (u.emailVerifiedAt ? 'ACTIVE' : 'INVITED');

            await client.userSnapshot.upsert({
                where: { userId: u.id },
                create: {
                    userId:      u.id,
                    fullName,
                    email:       u.email,
                    role:        u.role,
                    branchId:    u.branchId,
                    branchName:  u.branch?.name || null,
                    hospitalId:  u.hospitalId,
                    phoneNumber: u.patient?.phoneNumber || null,
                    status,
                    createdAt:   u.createdAt,
                },
                update: {
                    fullName,
                    email:       u.email,
                    role:        u.role,
                    branchId:    u.branchId,
                    branchName:  u.branch?.name || null,
                    hospitalId:  u.hospitalId,
                    phoneNumber: u.patient?.phoneNumber || null,
                    status,
                },
            });
        } catch (err) {
            logger.warn?.(`UserSnapshot upsert failed for ${userId}: ${err.message}`);
        }
    }

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
                gender: ther.gender,
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
                // specialization is only set on Doctor; gender is only set
                // on Therapist after the schema split. Each role drops the
                // other field naturally because Prisma returns undefined.
                specialization: clinician.specialization,
                gender: clinician.gender,
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
        // Supports legacy positional call listDoctors(branchId) and new object form
        // listDoctors({ branchId, search, excludeUserId, includeAvailability }).
        const branchId          = typeof options === 'string' ? options : (options?.branchId ?? null);
        const search            = typeof options === 'string' ? ''      : (options?.search   ?? '');
        const excludeUserId     = typeof options === 'object' && options !== null
            ? (options.excludeUserId ?? null)
            : null;
        const includeAvailability = typeof options === 'object' && options !== null
            ? options.includeAvailability !== false
            : true;

        try {
            // Both DOCTOR and ADMIN_DOCTOR get a Doctor profile at user-creation time
            // (see createUser), so we don't filter by role — ADMIN_DOCTOR doctors
            // need to be assignable as a regular doctor target.
            //
            // Filters consolidated into a single `user` block (mirrors
            // listPharmacists). The previous AND-of-multiple-`user`-objects shape
            // produced inconsistent filtering on nested relations and was the
            // suspected cause of the "Assign Patients dropdown only shows self"
            // bug for admin doctors.
            const where = {
                user: {
                    deletedAt: null,
                    ...(branchId ? { branchId } : {}),
                    ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
                },
                ...(search ? { fullName: { contains: search, mode: 'insensitive' } } : {}),
            };

            const doctors = await prisma.doctor.findMany({
                where,
                include: {
                    user: { include: { branch: true } },
                    _count: { select: { appointments: true } },
                },
            });

            // Best-effort availability check: a doctor is "unavailable today" if
            // they have a BlockedSlot covering today's date (LEAVE / WFH / OFF) or
            // their appointment count for today is at-or-above a soft cap.
            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            const todayEnd   = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);

            let blockedByDoctorId = new Map();
            let appointmentsTodayByDoctorId = new Map();
            if (includeAvailability && doctors.length > 0) {
                const doctorIds = doctors.map((d) => d.id);
                const [blocks, todayAppts] = await Promise.all([
                    prisma.blockedSlot.findMany({
                        where: {
                            doctorId: { in: doctorIds },
                            OR: [
                                { date: { gte: todayStart, lt: todayEnd } },
                                { date: null }, // recurring (dayOfWeek-based) blocks
                            ],
                        },
                        select: { doctorId: true, kind: true, reason: true, date: true, dayOfWeek: true },
                    }).catch(() => []),
                    prisma.appointment.groupBy({
                        by: ['doctorId'],
                        where: {
                            doctorId: { in: doctorIds },
                            date: { gte: todayStart, lt: todayEnd },
                            status: { in: ['PENDING', 'CONFIRMED', 'ASSIGNED', 'ACCEPTED'] },
                        },
                        _count: { _all: true },
                    }).catch(() => []),
                ]);

                const todayDow = todayStart.getDay();
                for (const b of blocks) {
                    if (b.date) {
                        blockedByDoctorId.set(b.doctorId, b);
                    } else if (b.dayOfWeek === todayDow) {
                        blockedByDoctorId.set(b.doctorId, b);
                    }
                }
                for (const a of todayAppts) {
                    appointmentsTodayByDoctorId.set(a.doctorId, a._count._all);
                }
            }

            const SOFT_DAILY_CAP = 12; // doctors with >=12 appointments today flagged AT_CAPACITY

            return doctors.map((doc) => {
                const block = blockedByDoctorId.get(doc.id) || null;
                const apptsToday = appointmentsTodayByDoctorId.get(doc.id) || 0;
                let availability = 'AVAILABLE';
                let unavailableReason = null;
                if (block) {
                    availability = 'UNAVAILABLE';
                    unavailableReason = block.kind === 'LEAVE'
                        ? `On leave${block.reason ? ` — ${block.reason}` : ''}`
                        : block.kind === 'WFH'
                            ? 'Working from home'
                            : block.kind === 'OFF'
                                ? 'Off today'
                                : (block.reason || 'Unavailable today');
                } else if (apptsToday >= SOFT_DAILY_CAP) {
                    availability = 'AT_CAPACITY';
                    unavailableReason = `Fully booked today (${apptsToday} appointments)`;
                }

                return {
                    id: doc.id,
                    userId: doc.userId,
                    fullName: doc.fullName,
                    specialization: doc.specialization,
                    profilePhoto: doc.profilePhoto,
                    yearsExperience: doc.yearsExperience,
                    qualification: doc.qualification,
                    clinic: doc.clinic,
                    email: doc.user?.email,
                    role: doc.user?.role || 'DOCTOR',
                    branchId: doc.user?.branchId,
                    branchName: doc.user?.branch?.name,
                    appointmentCount: doc._count?.appointments || 0,
                    appointmentsToday: apptsToday,
                    availability,
                    unavailableReason,
                };
            });
        } catch (err) {
            logger.error('[UserService.listDoctors]', err);
            throw err;
        }
    }

    static async listPharmacists({ branchId = null } = {}) {
        try {
            // Branch scoping mirrors listDoctors / listTherapists: when a
            // branchId is passed (BRANCH_ADMIN's JWT-pinned branch), only
            // pharmacists assigned to that branch are returned.
            const where = { user: { deletedAt: null, ...(branchId ? { branchId } : {}) } };
            const pharmacists = await prisma.pharmacist.findMany({
                where,
                include: { user: { include: { branch: true } } }
            });
            return pharmacists.map((pharma) => ({
                id: pharma.id,
                userId: pharma.userId,
                fullName: pharma.fullName,
                profilePhoto: pharma.profilePhoto,
                yearsExperience: pharma.yearsExperience,
                qualification: pharma.qualification,
                email: pharma.user?.email,
                branchId: pharma.user?.branchId ?? null,
                branchName: pharma.user?.branch?.name ?? null,
            }));
        } catch (err) {
            logger.error('[UserService.listPharmacists]', err);
            throw err;
        }
    }

    static async listPatients({ search = '', branchId = null, assignedDoctorId = null, assignedTherapistId = null } = {}) {
        try {
            // Use explicit AND so that the OR search clause is scoped correctly alongside
            // the user.deletedAt filter and the optional branchId filter. Without explicit
            // AND, a root-level OR could shadow the sibling filter keys in some Prisma versions.
            const conditions = [{ user: { deletedAt: null } }];
            if (search) {
                conditions.push({
                    OR: [
                        { fullName:    { contains: search, mode: 'insensitive' } },
                        { patientId:   { contains: search, mode: 'insensitive' } },
                        { phoneNumber: { contains: search, mode: 'insensitive' } },
                    ],
                });
            }
            // Restrict to patients assigned to the calling clinician. We check
            // BOTH sources of truth and OR them together so a patient appears
            // for the doctor regardless of whether the relationship was
            // established via an explicit assignment (the canonical
            // PatientAssignment row created when an admin assigns a doctor or
            // when a freshly created doctor receives initial patients) or via
            // a confirmed/completed appointment (legacy data path before the
            // assignment table existed). Without the PatientAssignment branch
            // a newly-created doctor whose patients were assigned via the
            // admin UI but who hasn't booked any appointments yet would see
            // an empty list on the prescription page.
            const ASSIGNED_STATUSES = ['CONFIRMED', 'COMPLETED', 'ASSIGNED'];
            const hasAssignmentFilter = !!(assignedDoctorId || assignedTherapistId);
            if (assignedDoctorId) {
                conditions.push({
                    OR: [
                        { patientAssignments: { some: { doctorId: assignedDoctorId, status: 'ACTIVE' } } },
                        { appointments:       { some: { doctorId: assignedDoctorId, status: { in: ASSIGNED_STATUSES } } } },
                    ],
                });
            }
            if (assignedTherapistId) {
                conditions.push({
                    appointments: { some: { therapistId: assignedTherapistId, status: { in: ASSIGNED_STATUSES } } },
                });
            }
            // Branch scoping applies ONLY when the caller hasn't pre-filtered to
            // their own assignments. An explicit PatientAssignment is a stronger
            // scope than branch — admins legitimately assign cross-branch coverage
            // (relocating patient, covering clinician, specialist consult), and
            // without this carve-out a doctor at Branch A literally cannot see a
            // patient at Branch B even after the admin has formally linked them.
            // For the unscoped browse case (e.g. ADMIN listing all patients at a
            // branch), the filter still applies.
            if (branchId && !hasAssignmentFilter) {
                conditions.push({ OR: [{ branchId }, { branchId: null }] });
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
                therapyTypes: pat.therapyTypes,
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
            branchId: user.branchId,
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
            dob, gender: rawGender, therapyTypes,
            addressLine1, addressLine2, city, state, pincode,
            primaryPhone, alternativePhone,
        } = data || {};
        const gender = rawGender !== undefined ? normaliseGender(rawGender) : undefined;
        // Empty-string → null so the DB never holds a string like "" that fails
        // the next geocode round-trip. Only converts when the field is *being*
        // updated; untouched fields pass through as `undefined`.
        const emptyToNull = (v) => (v === '' ? null : v);

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

                // If any of the five address pieces is being updated, re-geocode
                // using the merged (incoming ?? existing) address so we never
                // miss a hit just because the patient cleared one optional line.
                const addressTouched = [addressLine1, addressLine2, city, state, pincode]
                    .some((v) => v !== undefined);
                let geo = null;
                if (addressTouched) {
                    const merged = {
                        addressLine1: addressLine1 !== undefined ? emptyToNull(addressLine1) : user.patient.addressLine1,
                        addressLine2: addressLine2 !== undefined ? emptyToNull(addressLine2) : user.patient.addressLine2,
                        city:         city         !== undefined ? emptyToNull(city)         : user.patient.city,
                        state:        state        !== undefined ? emptyToNull(state)        : user.patient.state,
                        pincode:      pincode      !== undefined ? emptyToNull(pincode)      : user.patient.pincode,
                    };
                    geo = await geocodePatientAddress(merged);
                    if (!geo.locationVerified) {
                        logger?.warn?.(`[updateMe] geocoding failed for patient ${user.patient.id} — locationVerified=false`);
                    }
                }

                await tx.patient.update({
                    where: { id: user.patient.id },
                    data: {
                        ...(fullName !== undefined && { fullName }),
                        ...(phoneNumber !== undefined && { phoneNumber: phoneNumber || null }),
                        ...(profilePhoto !== undefined && { profilePhoto: profilePhoto || null }),
                        ...(dobDate !== undefined && { dob: dobDate }),
                        ...(age !== undefined && { age }),
                        ...(gender !== undefined && { gender: gender || null }),
                        // Patient.therapyType is String? (singular). `undefined`
                        // skip (no change); empty array / empty string clears
                        // the column; non-empty array writes the first entry.
                        ...(therapyTypes !== undefined && {
                            therapyType: Array.isArray(therapyTypes) && therapyTypes.length > 0
                                ? therapyTypes[0]
                                : (typeof therapyTypes === 'string' && therapyTypes.trim() ? therapyTypes.trim() : null),
                        }),

                        ...(addressLine1     !== undefined && { addressLine1:     emptyToNull(addressLine1) }),
                        ...(addressLine2     !== undefined && { addressLine2:     emptyToNull(addressLine2) }),
                        ...(city             !== undefined && { city:             emptyToNull(city) }),
                        ...(state            !== undefined && { state:            emptyToNull(state) }),
                        ...(pincode          !== undefined && { pincode:          emptyToNull(pincode) }),
                        ...(primaryPhone     !== undefined && { primaryPhone:     emptyToNull(primaryPhone) }),
                        ...(alternativePhone !== undefined && { alternativePhone: emptyToNull(alternativePhone) }),
                        ...(geo && {
                            latitude:         geo.latitude,
                            longitude:        geo.longitude,
                            locationVerified: geo.locationVerified,
                        }),
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
                // Persist the patient's preferred therapy into the dedicated
                // `therapyType` column (singular String?). The onboarding
                // payload submits an array (`therapyTypes`) from the
                // multi-select chip group, so we collapse to the first entry
                // here. `undefined` / empty-array skipped so a partial
                // submission doesn't wipe a previously-saved value.
                ...(Array.isArray(data.therapyTypes) && data.therapyTypes.length > 0
                    && { therapyType: data.therapyTypes[0] }),
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

            // Therapists' patient roster is the union of:
            //   1. Patients linked via legacy Journey.therapistId
            //   2. Patients on any Appointment for this therapist that is
            //      currently active (PENDING / CONFIRMED / SCHEDULED) or
            //      already COMPLETED — i.e. patients the therapist has
            //      worked with or is about to. The Journey-only query
            //      missed everyone for therapists with no journey rows.
            const [journeys, appointments] = await Promise.all([
                prisma.journey.findMany({
                    where:   { therapistId: therapist.id },
                    include: { patient: { include: { user: { select: { email: true, branchId: true } } } } },
                }),
                prisma.appointment.findMany({
                    where: {
                        therapistId: therapist.id,
                        status: { in: ['PENDING', 'CONFIRMED', 'SCHEDULED', 'ACCEPTED', 'COMPLETED', 'PENDING_DOCTOR_APPROVAL', 'PENDING_THERAPIST_APPROVAL'] },
                    },
                    include: { patient: { include: { user: { select: { email: true, branchId: true } } } } },
                    orderBy: { date: 'desc' },
                }),
            ]);

            // De-dupe by patient.id while preserving the most useful
            // status column from a journey when present.
            const byId = new Map();
            for (const j of journeys) {
                if (!j.patient) continue;
                byId.set(j.patient.id, {
                    id:           j.patient.id,
                    userId:       j.patient.userId,
                    fullName:     j.patient.fullName,
                    email:        j.patient.user?.email,
                    phoneNumber:  j.patient.phoneNumber,
                    branchId:     j.patient.branchId ?? j.patient.user?.branchId ?? null,
                    therapyTypes: j.patient.therapyTypes,
                    status:       j.status,
                    journeyType:  j.status,
                    completedSittings: j.completedSessions ?? 0,
                    totalSittings:     j.totalSessions ?? 0,
                });
            }
            for (const a of appointments) {
                if (!a.patient) continue;
                if (byId.has(a.patient.id)) continue;
                byId.set(a.patient.id, {
                    id:           a.patient.id,
                    userId:       a.patient.userId,
                    fullName:     a.patient.fullName,
                    email:        a.patient.user?.email,
                    phoneNumber:  a.patient.phoneNumber,
                    branchId:     a.patient.branchId ?? a.patient.user?.branchId ?? null,
                    therapyTypes: a.patient.therapyTypes,
                    // No journey → derive a synthetic status from the most
                    // recent appointment status so the UI can still bucket.
                    status:       a.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
                    journeyType:  null,
                    completedSittings: 0,
                    totalSittings:     0,
                });
            }
            return Array.from(byId.values());
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
        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            select: { id: true, hospitalId: true },
        });
        if (!branch) {
            const error = new Error('Invalid branchId: Branch does not exist');
            error.status = 400;
            throw error;
        }
        return branch;
    }

    static async createUser(data) {
        const {
            email, password, role, fullName, branchId: inputBranchId,
            phoneNumber, dob, gender: rawGender, therapyTypes,
            specialization, qualification, yearsExperience, clinic,
            registrationNumber,
            initialSkills,
            patientId,
            medicalHistory,
            // Home Therapy: location & contact (PATIENT only)
            addressLine1, addressLine2, city, state, pincode,
            primaryPhone, alternativePhone,
        } = data;
        // Canonicalise gender to uppercase so downstream checks (e.g. pregnancy toggle)
        // don't have to worry about mixed-case history (Female / female / FEMALE).
        const gender = normaliseGender(rawGender);

        const branch = await this._validateBranchId(inputBranchId);
        const branchId = branch?.id ?? null;
        // Inherit the hospital from the assigned branch — User.hospitalId is
        // the tenancy isolation column read by checkHospitalStatus on every
        // request. Without it the user gets 403 NO_HOSPITAL on the very
        // first call (e.g. GET /api/user/me right after login).
        const hospitalId = branch?.hospitalId ?? null;
        // Branch isolation: a DOCTOR without a branchId would defeat the
        // requireBranchScoped middleware (their JWT would have no branchId
        // claim and every scoped route would 403). Reject at intake — a DB
        // CHECK constraint enforces the same rule, but failing here gives a
        // friendlier 400 than a Prisma constraint violation.
        if (role === 'DOCTOR' && !branchId) {
            const error = new Error('branchId is required for DOCTOR users');
            error.status = 400;
            throw error;
        }
        // BRANCH_ADMIN is hard-pinned to a single branch — without a
        // branchId on the User record every branch-scoped query would
        // return empty results and the role becomes useless.
        if (role === 'BRANCH_ADMIN' && !branchId) {
            const error = new Error('branchId is required for BRANCH_ADMIN users');
            error.status = 400;
            throw error;
        }
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            const error = new Error('Email already registered');
            error.status = 409;
            throw error;
        }

        // rounds=12 to match AuthService.BCRYPT_ROUNDS (password reset flow).
        // Previously 10 — weaker than reset-initiated hashes. Unified here.
        const hashed = await bcrypt.hash(password, 12);
        // Geocode the patient's home address up-front so the live-map +
        // distance computations have coordinates immediately. Geocoding can
        // fail (no key in dev, transient network error, address not found);
        // we still persist the typed address with locationVerified = false
        // so the admin can re-trigger geocoding via PUT /patient/:id later.
        let geo = { latitude: null, longitude: null, locationVerified: false };
        if (role === 'PATIENT' && (addressLine1 || addressLine2 || city || state || pincode)) {
            geo = await geocodePatientAddress({ addressLine1, addressLine2, city, state, pincode });
            if (!geo.locationVerified) {
                logger?.warn?.(`[createUser] geocoding failed for patient ${email} — saving address with locationVerified=false`);
            }
        }
        return prisma.$transaction(async (tx) => {
            const newUser = await tx.user.create({
                data: { email, password: hashed, role, branchId, hospitalId, emailVerifiedAt: new Date() },
            });

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
                        // Therapists are categorized only by gender (MALE /
                        // FEMALE). The specialization column was dropped in
                        // 20260428120000_therapist_gender_drop_specialization.
                        gender: gender || null,
                        qualification,
                        yearsExperience,
                        clinic: clinic || null,
                        registrationNumber: registrationNumber || null,
                    },
                });
                // Seed the therapist's skill matrix from the admin-supplied
                // initialSkills array. Each entry is either a bare enum
                // string (legacy clients — defaults to EXPERIENCED) or
                // `{ skill, proficiency }` from the Create User form.
                const skillSet = new Map();
                if (Array.isArray(initialSkills)) {
                    for (const entry of initialSkills) {
                        if (typeof entry === 'string') {
                            if (!skillSet.has(entry)) skillSet.set(entry, 'EXPERIENCED');
                        } else if (entry && typeof entry === 'object' && entry.skill) {
                            skillSet.set(entry.skill, entry.proficiency || 'EXPERIENCED');
                        }
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
                // Patient.patientId is unique — if the auto-generated value
                // collides (e.g. two patients share a first name), append
                // a short suffix until we find a free slot. Cap retries so
                // we never spin on pathological inputs.
                let resolvedPatientId = patientId || null;
                if (resolvedPatientId) {
                    let candidate = resolvedPatientId;
                    for (let attempt = 0; attempt < 25; attempt += 1) {
                        const clash = await tx.patient.findUnique({
                            where: { patientId: candidate },
                            select: { id: true },
                        });
                        if (!clash) {
                            resolvedPatientId = candidate;
                            break;
                        }
                        candidate = `${resolvedPatientId}_${attempt + 2}`;
                        if (attempt === 24) resolvedPatientId = candidate; // best-effort
                    }
                }
                await tx.patient.create({
                    data: {
                        userId: newUser.id,
                        fullName,
                        branchId,
                        phoneNumber: phoneNumber || null,
                        dob: dobDate,
                        age,
                        gender: gender || null,
                        // Patient model has `therapyType` (String?, singular),
                        // not `therapyTypes`. Input from clients still arrives
                        // as an array (multi-select form + zod array schema +
                        // CSV importer), so we coerce to the first element here
                        // — the canonical "preferred therapy" for the patient.
                        // Older comments in this file claimed the column was
                        // String[]; that was wrong and was the root cause of
                        // every patient-create / update Prisma rejection.
                        therapyType: Array.isArray(therapyTypes) && therapyTypes.length > 0
                            ? therapyTypes[0]
                            : (typeof therapyTypes === 'string' && therapyTypes.trim() ? therapyTypes.trim() : null),
                        patientId: resolvedPatientId,
                        // Medical history is stashed in the existing
                        // onboardingData JSON column so we don't need a
                        // schema migration for the intake fields.
                        onboardingData: medicalHistory
                            ? {
                                patientType: medicalHistory.patientType,
                                previousDoctorName: medicalHistory.previousDoctorName ?? null,
                                previousDoctorDetails: medicalHistory.previousDoctorDetails ?? null,
                                capturedAt: new Date().toISOString(),
                            }
                            : undefined,
                        // Home Therapy address & contact (server-geocoded above)
                        addressLine1:     addressLine1 || null,
                        addressLine2:     addressLine2 || null,
                        city:             city || null,
                        state:            state || null,
                        pincode:          pincode || null,
                        primaryPhone:     primaryPhone || null,
                        alternativePhone: alternativePhone || null,
                        latitude:         geo.latitude,
                        longitude:        geo.longitude,
                        locationVerified: geo.locationVerified,
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
            // Sync the flattened reporting row inside the same transaction
            // so we never have a User without a matching UserSnapshot.
            await UserService.upsertSnapshot(newUser.id, { tx });
            return newUser;
        });
    }

    /**
     * List every user in a flattened, role-agnostic shape. Used by the
     * admin "Export All Users" endpoint. Reads from UserSnapshot when
     * available; falls back to a JOIN-based query for legacy rows where
     * the snapshot was never written.
     */
    static async exportAllUsers({ branchId = null, role = null, includeDeleted = false } = {}) {
        const where = {};
        if (branchId) where.branchId = branchId;
        if (role)     where.role     = role;
        if (!includeDeleted) where.status = { not: 'DELETED' };

        const rows = await prisma.userSnapshot.findMany({
            where,
            orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
        });

        return rows.map((r) => ({
            id:          r.userId,
            fullName:    r.fullName,
            email:       r.email,
            role:        r.role,
            branchId:    r.branchId,
            branchName:  r.branchName,
            phoneNumber: r.phoneNumber,
            status:      r.status,
            createdAt:   r.createdAt,
            updatedAt:   r.updatedAt,
        }));
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

        // Guard against soft-deleted target doctors. Both DOCTOR and ADMIN_DOCTOR
        // user records map to a Doctor profile and are valid assignee targets;
        // this is the explicit confirmation that ADMIN_DOCTOR self-assignment
        // (assignedById === doctor.userId) is permitted.
        if (doctor.user?.deletedAt) {
            const e = new Error('Cannot assign to a deactivated doctor');
            e.status = 400;
            throw e;
        }
        const targetRole = doctor.user?.role;
        if (targetRole && !['DOCTOR', 'ADMIN_DOCTOR'].includes(targetRole)) {
            const e = new Error(`Cannot assign patient to a user with role ${targetRole}`);
            e.status = 400;
            throw e;
        }

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
            // TEMPORARY (or CONSULTING) assignments leave the existing PRIMARY
            // intact — the patient's primary doctor relationship is preserved
            // for the duration of the unavailability.
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
        // Build the user filter atomically — previously the spread for
        // hospitalId and the explicit deletedAt key collided on the
        // `user` field, silently dropping the hospital scope.
        const userFilter = { deletedAt: null };
        if (hospitalId) userFilter.hospitalId = hospitalId;

        const patients = await prisma.patient.findMany({
            where: {
                ...(branchId ? { branchId } : {}),
                user: userFilter,
            },
            include: {
                user:                { select: { id: true, email: true, branchId: true } },
                branch:              { select: { id: true, name: true } },
                patientAssignments:  {
                    where:  { type: 'PRIMARY', status: 'ACTIVE' },
                    select: { id: true },
                },
            },
            orderBy: { createdAt: 'desc' },
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
        const updated = await prisma.user.update({ where: { id: profile.userId }, data: { deletedAt: new Date() } });
        // Reflect the soft-delete on the snapshot row.
        await UserService.upsertSnapshot(profile.userId);
        return updated;
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

        // Patient address change → re-geocode and stamp locationVerified.
        // We re-geocode whenever any address component is in the payload
        // (even if unchanged) so admins can use the "Re-verify Location"
        // button to retry a failed geocode without editing the address.
        if (type === 'patient') {
            const ADDRESS_KEYS = ['addressLine1', 'addressLine2', 'city', 'state', 'pincode'];
            const hasAddressEdit = ADDRESS_KEYS.some((k) => Object.prototype.hasOwnProperty.call(profileData, k));
            if (hasAddressEdit) {
                const merged = {
                    addressLine1: profileData.addressLine1 ?? profile.addressLine1,
                    addressLine2: profileData.addressLine2 ?? profile.addressLine2,
                    city:         profileData.city         ?? profile.city,
                    state:        profileData.state        ?? profile.state,
                    pincode:      profileData.pincode      ?? profile.pincode,
                };
                const geo = await geocodePatientAddress(merged);
                profileData.latitude         = geo.latitude;
                profileData.longitude        = geo.longitude;
                profileData.locationVerified = geo.locationVerified;
                if (!geo.locationVerified) {
                    logger?.warn?.(`[updateProfile] geocoding failed for patient ${id} — locationVerified=false`);
                }
            }
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

