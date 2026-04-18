import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import crypto from 'crypto';
import { notificationService } from './notification.service.js';
import { AvailabilityService } from './availability.service.js';

const includeDetails = {
    doctor: { include: { user: { select: { email: true } } } },
    therapist: { include: { user: { select: { email: true } } } },
    patient: { include: { user: { select: { email: true } } } },
    triageSession: true,
    branch: { select: { id: true, name: true, address: true } },
};

export class AppointmentService {
    static async getAppointments({ id, role }, filters = {}) {
        logger.info(`Trace: Entering getAppointments [User: ${id}, Role: ${role}]`, { filters });

        try {
            const { status, date, sort } = filters;
            const requestedPage = parseInt(filters.page) || 1;
            const page = Math.max(1, requestedPage);
            const MAX_LIMIT = 100;
            const limit = Math.min(parseInt(filters.limit) || 20, MAX_LIMIT);
            const skip = (page - 1) * limit;
            const take = limit;

            // Build sort order — branch-name or default date-desc
            const orderBy = sort === 'branch'
                ? [{ branch: { name: 'asc' } }, { date: 'desc' }]
                : { date: 'desc' };

            let where = {
                ...(status && { status }),
                ...(date && { date: { gte: new Date(date), lt: new Date(new Date(date).getTime() + 86400000) } })
            };

            // 1. Resolve Target Record (Patient/Doctor/Therapist)
            if (role === 'PATIENT') {
                const patientRecord = await prisma.patient.findUnique({
                    where: { userId: id },
                    select: { id: true },
                });
                if (!patientRecord) {
                    logger.warn(`Search aborted: Patient profile missing for userId ${id}`);
                    throw new Error('Patient profile not found. Please complete your profile.');
                }
                where.patientId = patientRecord.id;
            } else if (role === 'DOCTOR' || role === 'ADMIN_DOCTOR') {
                const doctorRecord = await prisma.doctor.findUnique({
                    where: { userId: id },
                    select: { id: true },
                });
                if (!doctorRecord && role !== 'ADMIN_DOCTOR') {
                    logger.warn(`Profile missing for Doctor userId ${id}`);
                    throw new Error('Doctor profile not found');
                }
                if (doctorRecord) where.doctorId = doctorRecord.id;
            } else if (role === 'THERAPIST') {
                const therapistRecord = await prisma.therapist.findUnique({
                    where: { userId: id },
                    select: { id: true },
                });
                if (!therapistRecord) {
                    logger.warn(`Profile missing for Therapist userId ${id}`);
                    throw new Error('Therapist profile not found');
                }
                where.therapistId = therapistRecord.id;
            }

            // 2. Branch Locking (Except for Admin Doctor)
            const user = await prisma.user.findUnique({ where: { id }, select: { branchId: true } });
            if (user?.branchId && role !== 'ADMIN_DOCTOR') {
                where.branchId = user.branchId;
            }

            // 3. Admin-only branch filter — allows ADMIN / ADMIN_DOCTOR to scope by branch
            //    Applies only when no branch-lock is already in effect (i.e. super-admin)
            if ((role === 'ADMIN' || role === 'ADMIN_DOCTOR') && filters.branchId) {
                where.branchId = filters.branchId;
            }

            logger.info(`Trace: Executing Appointment query`, { where, skip, take, sort });

            // 4. Parallel Fetching (Optimized with skip/take)
            const [appointments, total] = await Promise.all([
                prisma.appointment.findMany({
                    where,
                    include: includeDetails,
                    orderBy,
                    skip,
                    take
                }),
                prisma.appointment.count({ where })
            ]);

            logger.info(`Trace: Success [Count: ${appointments.length}, Total: ${total}]`);

            return {
                appointments,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: take,
                    totalPages: Math.ceil(total / take)
                }
            };
        } catch (error) {
            logger.error(`Trace: Failure in getAppointments`, error, { id, role });
            throw error;
        }
    }

    static async createAppointment(user, data) {
        const { patientId, doctorId, therapistId, date, status, notes, triageSessionId, contactDetails, consultationType, consultationMode } = data;

        let actualPatientId;
        if (user.role === 'PATIENT') {
            const patientRecord = await prisma.patient.findUnique({
                where: { userId: user.id },
                select: { id: true },
            });
            if (!patientRecord) throw new Error('Patient profile not found');
            actualPatientId = patientRecord.id;
        } else {
            if (!patientId) throw new Error('patientId is required');
            actualPatientId = patientId;
        }

        const appointmentDate = new Date(date);

        // Reject appointments in the past
        const now = new Date();
        if (appointmentDate < now) {
            const error = new Error('Appointment date must be in the future');
            error.status = 400;
            throw error;
        }

        const [startTimeStr] = (data.slot || appointmentDate.toTimeString().slice(0, 5)).split(' - ');

        // Mandatory Branch Selection
        const branchIdToUse = data.branchId || user.branchId;
        if (!branchIdToUse) throw new Error('Branch selection is required');

        // Dynamic Validation based on Consultation Type
        if (consultationType === 'DOCTOR' && !doctorId) throw new Error('Doctor selection is required for Doctor consultation');
        if (consultationType === 'THERAPIST' && !therapistId) throw new Error('Therapist selection is required for Therapist consultation');
        if (consultationType === 'COMBINED' && (!doctorId || !therapistId)) throw new Error('Both Doctor and Therapist are required for Combined consultation');

        // 1. Doctor Availability Check
        if (doctorId && (consultationType === 'DOCTOR' || consultationType === 'COMBINED')) {
            const appointmentEndTime = new Date(appointmentDate.getTime() + 60 * 60 * 1000); // 1 hr duration
            const endTimeStr = appointmentEndTime.toTimeString().slice(0, 5);

            const docAvailability = await AvailabilityService.checkAvailability(
                doctorId, appointmentDate.toISOString(), startTimeStr, endTimeStr
            );
            if (!docAvailability.available) throw new Error(`Doctor unavailable: ${docAvailability.reason}`);

            // Double booking check for doctor
            const docBusy = await prisma.appointment.findFirst({
                where: { doctorId, date: appointmentDate, status: { notIn: ['CANCELLED', 'REJECTED'] } }
            });
            if (docBusy) {
                const suggestion = await AvailabilityService.findNextAvailableSlot(doctorId, appointmentDate);
                const error = new Error('The selected doctor is already booked at this time.');
                error.status = 409;
                error.suggestedSlot = suggestion;
                throw error;
            }
        }

        const actualTherapistDate = data.therapistDate ? new Date(data.therapistDate) : appointmentDate;

        // 2. Therapist Availability Check
        if (therapistId && (consultationType === 'THERAPIST' || consultationType === 'COMBINED')) {
            const tStartTimeStr = actualTherapistDate.toTimeString().slice(0, 5);
            const tEndTime = new Date(actualTherapistDate.getTime() + 60 * 60 * 1000); // 1 hr duration
            const tEndTimeStr = tEndTime.toTimeString().slice(0, 5);

            const therapistAvailability = await AvailabilityService.checkAvailability(
                therapistId, actualTherapistDate.toISOString(), tStartTimeStr, tEndTimeStr
            );
            if (!therapistAvailability.available) throw new Error(`Therapist unavailable: ${therapistAvailability.reason}`);

            // Double booking check for therapist
            const therapistBusy = await prisma.appointment.findFirst({
                where: {
                    therapistId,
                    OR: [
                        { date: actualTherapistDate },
                        { therapistDate: actualTherapistDate }
                    ],
                    status: { notIn: ['CANCELLED', 'REJECTED'] }
                }
            });
            if (therapistBusy) {
                const suggestion = await AvailabilityService.findNextAvailableSlot(therapistId, actualTherapistDate);
                const error = new Error('The selected therapist is already booked at this time.');
                error.status = 409;
                error.suggestedSlot = suggestion;
                throw error;
            }
        }

        // Triage Validation for Admin Doctor
        if (doctorId) {
            const targetDoctor = await prisma.doctor.findUnique({
                where: { id: doctorId },
                include: { user: true }
            });

            if (targetDoctor?.user?.role === 'ADMIN_DOCTOR') {
                if (!triageSessionId) throw new Error('Triage assessment is required for Admin Doctor');
                const triage = await prisma.triageSession.findUnique({ where: { id: triageSessionId } });
                if (!triage || (triage.severity !== 'HIGH' && triage.severity !== 'EMERGENCY' && !triage.isEscalated)) {
                    throw new Error('Case does not qualify for Admin Doctor');
                }
            }
        }

        if (contactDetails) {
            const rawPhone = contactDetails.phoneNumber?.replace(/[\s\-]/g, '') || '';
            if (rawPhone && !/^\+?[0-9]{7,15}$/.test(rawPhone)) {
                const error = new Error('Invalid phone number format');
                error.status = 400;
                throw error;
            }
            await prisma.patient.update({
                where: { id: actualPatientId },
                data: {
                    fullName: contactDetails.fullName,
                    ...(rawPhone && { phoneNumber: rawPhone }),
                },
            });

            const patient = await prisma.patient.findUnique({ where: { id: actualPatientId }, include: { user: true } });
            if (patient?.user && patient.user.email !== contactDetails.email) {
                await prisma.user.update({ where: { id: patient.userId }, data: { email: contactDetails.email } });
            }
        }

        // Online meeting generation
        let meetingLink = null;
        if (consultationMode === 'ONLINE') {
            meetingLink = `https://meet.jit.si/al-shifa-${crypto.randomBytes(12).toString('hex')}`;  // cryptographically random, not Math.random()
        }

        // 3. Clinical Recommendation Enforcement
        if (triageSessionId) {
            const triage = await prisma.triageSession.findUnique({ where: { id: triageSessionId } });
            if (triage) {
                const responses = triage.responses || {};
                const isEscalation = triage.isEscalated || responses.classification === 'Escalation Required';

                if (isEscalation) {
                    const selectedDoctor = await prisma.doctor.findUnique({
                        where: { id: doctorId },
                        include: { user: true }
                    });
                    if (selectedDoctor?.user?.role !== 'ADMIN_DOCTOR') {
                        throw new Error('Your assessment recommends a Senior Specialist (Admin Doctor) review. Please select an appropriate clinician.');
                    }
                }
            }
        }

        // H-2: Wrap create inside a serializable transaction so the double-booking check
        //       and the insert are atomic — eliminates the TOCTOU race condition.
        const appointment = await prisma.$transaction(async (tx) => {
            if (doctorId && consultationType !== 'THERAPIST') {
                const conflict = await tx.appointment.findFirst({
                    where: { doctorId, date: appointmentDate, status: { notIn: ['CANCELLED', 'REJECTED'] } },
                    select: { id: true }
                });
                if (conflict) {
                    const err = new Error('The selected doctor is already booked at this time.');
                    err.status = 409;
                    throw err;
                }
            }
            if (therapistId && consultationType !== 'DOCTOR') {
                const conflictDate = (consultationType === 'COMBINED' || consultationType === 'THERAPIST')
                    ? actualTherapistDate
                    : appointmentDate;
                const conflict = await tx.appointment.findFirst({
                    where: {
                        therapistId,
                        OR: [{ date: conflictDate }, { therapistDate: conflictDate }],
                        status: { notIn: ['CANCELLED', 'REJECTED'] }
                    },
                    select: { id: true }
                });
                if (conflict) {
                    const err = new Error('The selected therapist is already booked at this time.');
                    err.status = 409;
                    throw err;
                }
            }
            return tx.appointment.create({
                data: {
                    patientId: actualPatientId,
                    doctorId: (consultationType === 'THERAPIST' || !doctorId) ? null : doctorId,
                    therapistId: (consultationType === 'DOCTOR' || !therapistId) ? null : therapistId,
                    date: appointmentDate,
                    therapistDate: (consultationType === 'COMBINED' || consultationType === 'THERAPIST') ? actualTherapistDate : null,
                    status: user.role === 'PATIENT' ? 'PENDING' : (status || 'CONFIRMED'),
                    notes,
                    triageSessionId: triageSessionId || null,
                    consultationType: consultationType || 'DOCTOR',
                    consultationMode: consultationMode || 'OFFLINE',
                    meetingLink,
                    branchId: branchIdToUse
                },
                include: { ...includeDetails, triageSession: true }
            });
        });

        // Notify Clinicians of New Appointment (INFO priority)
        if (appointment.doctorId && appointment.doctor?.userId) {
            await notificationService.createNotification({
                userId: appointment.doctor.userId,
                type: 'NEW_APPOINTMENT',
                title: 'New Appointment Request',
                message: `You have a new appointment request from ${appointment.patient?.fullName ?? 'a patient'} for ${appointmentDate.toLocaleDateString()}.`,
                priority: 'INFO',
                data: { appointmentId: appointment.id }
            });
        }
        if (appointment.therapistId && appointment.therapist?.userId) {
            await notificationService.createNotification({
                userId: appointment.therapist.userId,
                type: 'NEW_APPOINTMENT',
                title: 'New Appointment Request',
                message: `You have a new appointment request from ${appointment.patient?.fullName ?? 'a patient'} for ${appointmentDate.toLocaleDateString()}.`,
                priority: 'INFO',
                data: { appointmentId: appointment.id }
            });
        }

        return appointment;
    }

    static async updateAppointment(id, user, data) {
        const existing = await prisma.appointment.findUnique({
            where: { id },
            include: { patient: true }
        });
        if (!existing) throw new Error('Appointment not found');

        // RBAC & Ownership Verification
        const isAdmin = ['ADMIN', 'ADMIN_DOCTOR'].includes(user.role);
        const isClinician = ['DOCTOR', 'THERAPIST'].includes(user.role);
        const isPatient = user.role === 'PATIENT';

        if (isPatient) {
            if (existing.patient.userId !== user.id) {
                const error = new Error('Forbidden: You do not own this appointment');
                error.status = 403;
                throw error;
            }
            if (existing.status !== 'PENDING') {
                const error = new Error('Forbidden: Only pending appointments can be modified');
                error.status = 403;
                throw error;
            }
            // Patients can only update notes
            data = { notes: data.notes };
        } else if (isClinician && !isAdmin) {
            // Check if they are the assigned clinician
            const isAssigned = existing.doctorId === user.id || existing.therapistId === user.id; // Usually userId !== clinicianId, need to check
            // Actually clinicians update by their profile ID, but req.user.id is userId.
            const clinicianRecord = user.role === 'DOCTOR'
                ? await prisma.doctor.findUnique({ where: { userId: user.id } })
                : await prisma.therapist.findUnique({ where: { userId: user.id } });

            if (existing.doctorId !== clinicianRecord?.id && existing.therapistId !== clinicianRecord?.id) {
                const error = new Error('Forbidden: You are not assigned to this appointment');
                error.status = 403;
                throw error;
            }
        }

        const updateData = {
            ...(data.date && { date: new Date(data.date) }),
            ...(data.therapistDate && { therapistDate: new Date(data.therapistDate) }),
            ...(data.status && { status: data.status }),
            ...(data.notes !== undefined && { notes: data.notes }),
        };

        const appointment = await prisma.appointment.update({
            where: { id },
            data: updateData,
            include: includeDetails
        });

        if (data.status === 'COMPLETED' && existing.status !== 'COMPLETED') {
            await prisma.patient.update({
                where: { id: appointment.patientId },
                data: { zenPoints: { increment: 100 } }
            });
        }

        // H-6: Duplicate trigger removed — approveAppointment() already handles the
        //       ACCEPTED notification via the proper approval flow. Firing it here
        //       caused double webhook delivery on manual status edits.

        return appointment;
    }

    static async approveAppointment(id, user) {
        const existing = await prisma.appointment.findUnique({ where: { id } });
        if (!existing) throw new Error('Appointment not found');

        const isDoctor = ['DOCTOR', 'ADMIN_DOCTOR'].includes(user.role);
        const isTherapist = user.role === 'THERAPIST';

        if (!isDoctor && !isTherapist) {
            throw new Error('Unauthorized: Only Doctors or Therapists can approve appointments');
        }

        // Determine flags to update
        const updateData = {};
        if (isDoctor) updateData.doctorApproved = true;
        if (isTherapist) updateData.therapistApproved = true;

        // Fetch updated flags (merging with existing)
        const docApp = updateData.doctorApproved || existing.doctorApproved;
        const therApp = updateData.therapistApproved || existing.therapistApproved;

        // Calculate final status based on consultation type
        let newStatus = existing.status;
        const type = existing.consultationType;

        if (type === 'DOCTOR') {
            if (docApp) newStatus = 'ACCEPTED';
        } else if (type === 'THERAPIST') {
            if (therApp) newStatus = 'ACCEPTED';
        } else if (type === 'COMBINED') {
            if (docApp && therApp) {
                newStatus = 'ACCEPTED';
            } else if (docApp) {
                newStatus = 'PENDING_THERAPIST_APPROVAL';
            } else if (therApp) {
                newStatus = 'PENDING_DOCTOR_APPROVAL';
            }
        }

        updateData.status = newStatus;

        const updated = await prisma.appointment.update({
            where: { id },
            data: updateData,
            include: includeDetails
        });

        // Trigger notification when the REQUIRED approvals are met
        const justDoctorApproved = isDoctor && !existing.doctorApproved && updated.doctorApproved;
        const justTherapistApproved = isTherapist && !existing.therapistApproved && updated.therapistApproved;

        let shouldTrigger = false;
        if (type === 'DOCTOR' && justDoctorApproved) shouldTrigger = true;
        if (type === 'THERAPIST' && justTherapistApproved) shouldTrigger = true;
        if (type === 'COMBINED' && (justDoctorApproved || justTherapistApproved)) {
            // Only trigger Combined if BOTH have now approved
            if (updated.doctorApproved && updated.therapistApproved) shouldTrigger = true;
        }

        if (shouldTrigger && !updated.notificationSent) {
            logger.info(`[AppointmentService] Final approval reached for ${id} (Type: ${type}). Triggering webhook.`);
            try {
                await notificationService.sendAppointmentConfirmation(updated, `${user.role}_ACCEPT`);
            } catch (notifyError) {
                logger.error('[AppointmentService] Failed to send confirmation notification', { message: notifyError.message, appointmentId: id });
            }
        } else {
            logger.info(`[AppointmentService] Status updated for ${id}`, { notificationSent: updated.notificationSent, shouldTrigger });
        }

        return updated;
    }

    static async cancelAppointment(id, user) {
        const existing = await prisma.appointment.findUnique({
            where: { id },
            include: { patient: true }
        });
        if (!existing) throw new Error('Appointment not found');

        // RBAC & Ownership Verification
        const isAdmin = ['ADMIN', 'ADMIN_DOCTOR'].includes(user.role);
        const isPatient = user.role === 'PATIENT';

        if (isPatient) {
            if (existing.patient.userId !== user.id) {
                const error = new Error('Forbidden: You do not own this appointment');
                error.status = 403;
                throw error;
            }
            if (existing.status !== 'PENDING') {
                const error = new Error('Forbidden: Only pending appointments can be cancelled by patients');
                error.status = 403;
                throw error;
            }
        }

        const appointment = await prisma.appointment.update({
            where: { id },
            data: { status: 'CANCELLED' },
            include: { doctor: true, therapist: true, patient: true }
        });

        // Notify involved parties (HIGH priority for cancellation)
        const parties = [
            appointment.patient?.userId,
            appointment.doctor?.userId,
            appointment.therapist?.userId
        ].filter(Boolean);

        // M-8: Fire all cancellation notifications in parallel (was sequential await-in-loop)
        await Promise.all(parties.map(userId => notificationService.createNotification({
            userId,
            type: 'APPOINTMENT_CANCELLED',
            title: 'Appointment Cancelled',
            message: `The appointment for ${appointment.patient.fullName} on ${new Date(appointment.date).toLocaleDateString()} has been cancelled.`,
            priority: 'HIGH',
            data: { appointmentId: appointment.id }
        })));

        return appointment;
    }

    static async getAvailableStaff(user, query = {}) {
        const { branchId, date, slot } = query;
        const where = {};

        // 1. Branch Filter
        const targetBranchId = branchId || (user.branchId && user.role !== 'ADMIN_DOCTOR' ? user.branchId : null);
        if (targetBranchId) {
            where.user = { branchId: targetBranchId };
        }

        const [doctors, therapists] = await Promise.all([
            prisma.doctor.findMany({
                where,
                include: { user: { select: { email: true, role: true, branchId: true } } },
                orderBy: { fullName: 'asc' }
            }),
            prisma.therapist.findMany({
                where,
                include: { user: { select: { email: true, role: true, branchId: true } } },
                orderBy: { fullName: 'asc' }
            })
        ]);

        // 2. Real-time Availability Filter (if date and slot provided)
        // Run all clinician availability checks in parallel to avoid N+1 serial queries.
        if (date && slot) {
            const [startTime, endTime] = slot.split(' - ');

            const [docResults, therapistResults] = await Promise.all([
                Promise.all(doctors.map((doc) =>
                    AvailabilityService.checkAvailability(doc.id, date, startTime, endTime)
                        .then((check) => check.available ? doc : null)
                        .catch(() => null)
                )),
                Promise.all(therapists.map((t) =>
                    AvailabilityService.checkAvailability(t.id, date, startTime, endTime)
                        .then((check) => check.available ? t : null)
                        .catch(() => null)
                )),
            ]);

            return {
                doctors: docResults.filter(Boolean),
                therapists: therapistResults.filter(Boolean),
            };
        }

        return { doctors, therapists };
    }

    static async getAppointmentById(id) {
        return prisma.appointment.findUnique({ where: { id }, select: { id: true, status: true } });
    }

    static async getAvailableSlots(clinicianId, date, branchId) {
        const slots = await AvailabilityService.getAvailableSlots(clinicianId, date);

        // Enhance slots with spotsLeft and isNearlyFull
        // Check Redis for held slots
        const { cacheService } = await import('./cache.service.js');

        return Promise.all(slots.map(async (slot) => {
            const holdKey = `slot:hold:${clinicianId}:${date}:${slot.startTime}`;
            const held = await cacheService.get(holdKey);
            const isHeld = !!held;
            const spotsLeft = slot.status === 'AVAILABLE' && !isHeld ? 1 : 0;
            return {
                ...slot,
                time: slot.startTime,
                spotsLeft,
                isNearlyFull: spotsLeft <= 1 && spotsLeft > 0,
                isHeld,
            };
        }));
    }

    /**
     * Hold a slot for 10 minutes to prevent double-booking during checkout.
     */
    static async holdSlot(clinicianId, date, time, userId) {
        const { cacheService } = await import('./cache.service.js');
        const holdKey = `slot:hold:${clinicianId}:${date}:${time}`;
        const existing = await cacheService.get(holdKey);

        if (existing && existing.userId !== userId) {
            const error = new Error('This slot is currently being booked by another patient');
            error.status = 409;
            throw error;
        }

        // Hold for 10 minutes (600 seconds)
        await cacheService.set(holdKey, { userId, heldAt: Date.now() }, 600);

        return { held: true, expiresIn: 600 };
    }

    /**
     * Verify a hold exists before confirming booking.
     */
    static async verifyHold(clinicianId, date, time, userId) {
        const { cacheService } = await import('./cache.service.js');
        const holdKey = `slot:hold:${clinicianId}:${date}:${time}`;
        const hold = await cacheService.get(holdKey);

        // Allow booking even if hold expired (graceful)
        if (hold && hold.userId !== userId) {
            const error = new Error('Slot is held by another patient');
            error.status = 409;
            throw error;
        }

        // Clear the hold after verification
        if (hold) {
            await cacheService.del(holdKey);
        }

        return true;
    }
}
