import prisma from '../lib/prisma.js';

export class ChatService {
    /**
     * Verify that a patient has been assigned to a clinician via appointments or journeys.
     * Only CONFIRMED/COMPLETED appointments or active journeys count as a valid assignment.
     * ADMIN_DOCTOR bypasses this check — they can chat with any patient.
     */
    static async verifyAssignment(patientId, clinicianId, clinicianType) {
        // ADMIN_DOCTORs can always chat with any patient
        if (clinicianType === 'DOCTOR') {
            const doctor = await prisma.doctor.findUnique({
                where: { id: clinicianId },
                include: { user: { select: { role: true } } }
            });
            if (doctor?.user?.role === 'ADMIN_DOCTOR') return true;
        }

        // Check appointments
        const appointmentWhere = {
            patientId,
            status: { in: ['CONFIRMED', 'COMPLETED', 'ASSIGNED'] }
        };
        if (clinicianType === 'DOCTOR') appointmentWhere.doctorId = clinicianId;
        else if (clinicianType === 'THERAPIST') appointmentWhere.therapistId = clinicianId;
        // Pharmacists connect to patients via dispensing records
        else if (clinicianType === 'PHARMACIST') {
            const pharmacist = await prisma.pharmacist.findUnique({
                where: { id: clinicianId },
                select: { userId: true }
            });
            if (!pharmacist) return false;

            const dispense = await prisma.pharmacyDispense.findFirst({
                where: {
                    patientId,
                    dispensedBy: pharmacist.userId
                }
            });
            return !!dispense;
        }

        const appointment = await prisma.appointment.findFirst({ where: appointmentWhere });
        if (appointment) return true;

        // Check journeys (ongoing treatment relationships)
        if (clinicianType === 'DOCTOR' || clinicianType === 'THERAPIST') {
            const journeyWhere = { patientId };
            if (clinicianType === 'DOCTOR') journeyWhere.doctorId = clinicianId;
            else journeyWhere.therapistId = clinicianId;

            const journey = await prisma.journey.findFirst({ where: journeyWhere });
            if (journey) return true;
        }

        return false;
    }

    static async getOrCreateConversation(patientId, targetId, clinicianType = 'DOCTOR') {
        const whereMap = {
            'DOCTOR': { patientId_doctorId: { patientId, doctorId: targetId } },
            'THERAPIST': { patientId_therapistId: { patientId, therapistId: targetId } },
            'PHARMACIST': { patientId_pharmacistId: { patientId, pharmacistId: targetId } }
        };

        const where = whereMap[clinicianType] || whereMap['DOCTOR'];

        let conversation = await prisma.conversation.findUnique({ where });

        if (!conversation) {
            // Verify the patient is actually assigned to this clinician before creating
            const isAssigned = await this.verifyAssignment(patientId, targetId, clinicianType);
            if (!isAssigned) {
                throw new Error('Patient is not assigned to this clinician');
            }

            const dataField = clinicianType === 'DOCTOR' ? 'doctorId' : (clinicianType === 'THERAPIST' ? 'therapistId' : 'pharmacistId');
            conversation = await prisma.conversation.create({
                data: {
                    patientId,
                    [dataField]: targetId
                }
            });
        }
        return conversation;
    }

    /**
     * Verify the requesting user is a participant of the given conversation.
     * Returns the conversation if authorized, throws otherwise.
     */
    static async verifyParticipant(conversationId, userId) {
        const conversation = await prisma.conversation.findFirst({
            where: {
                id: conversationId,
                OR: [
                    { patient:    { userId } },
                    { doctor:     { userId } },
                    { therapist:  { userId } },
                    { pharmacist: { userId } },
                ]
            }
        });

        if (!conversation) {
            throw new Error('Unauthorized: You are not a participant of this conversation');
        }

        return conversation;
    }

    /**
     * Ensure the admin doctor has a conversation row with every patient in the
     * given hospital. Idempotent — getOrCreateConversation skips existing rows.
     * Best-effort: per-patient failures are swallowed so a single bad row does
     * not block the rest of the chat list from loading.
     */
    static async _ensureAdminDoctorConversations(adminDoctorId, hospitalId) {
        const patientWhere = hospitalId ? { user: { hospitalId } } : {};
        const patients = await prisma.patient.findMany({
            where: patientWhere,
            select: { id: true }
        });
        for (const p of patients) {
            try {
                await this.getOrCreateConversation(p.id, adminDoctorId, 'DOCTOR');
            } catch { /* skip — assignment may fail for edge cases, do not block */ }
        }
    }

    /**
     * Ensure a doctor/therapist has a conversation row with every patient they
     * have an active or completed appointment with.
     */
    static async _ensureClinicianPatientConversations(clinicianId, clinicianType) {
        const apptWhere = { status: { in: ['CONFIRMED', 'COMPLETED', 'ASSIGNED'] } };
        if (clinicianType === 'DOCTOR') apptWhere.doctorId = clinicianId;
        else if (clinicianType === 'THERAPIST') apptWhere.therapistId = clinicianId;
        else return;

        const appointments = await prisma.appointment.findMany({
            where: apptWhere,
            select: { patientId: true },
            distinct: ['patientId']
        });
        for (const a of appointments) {
            if (!a.patientId) continue;
            try {
                await this.getOrCreateConversation(a.patientId, clinicianId, clinicianType);
            } catch { /* skip — assignment check may fail for stale rows */ }
        }
    }

    /**
     * Pharmacists are linked to patients via dispensing records, not appointments.
     */
    static async _ensurePharmacistPatientConversations(pharmacistId) {
        const pharmacist = await prisma.pharmacist.findUnique({
            where: { id: pharmacistId },
            select: { userId: true }
        });
        if (!pharmacist) return;

        const dispenses = await prisma.pharmacyDispense.findMany({
            where: { dispensedBy: pharmacist.userId },
            select: { patientId: true },
            distinct: ['patientId']
        });
        for (const d of dispenses) {
            if (!d.patientId) continue;
            try {
                await this.getOrCreateConversation(d.patientId, pharmacistId, 'PHARMACIST');
            } catch { /* skip */ }
        }
    }

    static async listUserConversations(userId) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { doctor: true, patient: true, therapist: true, pharmacist: true }
        });

        if (!user) throw new Error('User not found');

        let where = {};

        if (user.role === 'ADMIN_DOCTOR' && user.doctor) {
            // ADMIN_DOCTOR is visible to all patients — auto-create a conversation
            // with every patient in the same hospital so the admin always shows up
            // in the patient's chat list AND the admin's own list, regardless of
            // who opens chat first.
            await this._ensureAdminDoctorConversations(user.doctor.id, user.hospitalId);
            where = {};
        } else if (user.role === 'ADMIN') {
            // ADMIN sees all conversations
            where = {};
        } else if (user.doctor) {
            // A doctor must see every patient they're consulting with, even if
            // the patient has not opened chat yet. Auto-create conversations for
            // every patient with an active/completed appointment under this doctor.
            await this._ensureClinicianPatientConversations(user.doctor.id, 'DOCTOR');
            where = { doctorId: user.doctor.id };
        } else if (user.therapist) {
            await this._ensureClinicianPatientConversations(user.therapist.id, 'THERAPIST');
            where = { therapistId: user.therapist.id };
        } else if (user.pharmacist) {
            await this._ensurePharmacistPatientConversations(user.pharmacist.id);
            where = { pharmacistId: user.pharmacist.id };
        } else if (user.patient) {
            const patientId = user.patient.id;

            // Auto-initialize conversations only with assigned clinicians
            const adminDoctor = await prisma.doctor.findFirst({
                where: { user: { role: 'ADMIN_DOCTOR' } }
            });

            const assignedAppointments = await prisma.appointment.findMany({
                where: {
                    patientId,
                    status: { in: ['CONFIRMED', 'COMPLETED', 'ASSIGNED'] }
                },
                select: { doctorId: true, therapistId: true },
                distinct: ['doctorId', 'therapistId']
            });

            const targetDoctorIds = new Set();
            if (adminDoctor) targetDoctorIds.add(adminDoctor.id);

            const targetTherapistIds = new Set();

            assignedAppointments.forEach(a => {
                if (a.doctorId) targetDoctorIds.add(a.doctorId);
                if (a.therapistId) targetTherapistIds.add(a.therapistId);
            });

            for (const dId of targetDoctorIds) {
                try {
                    await this.getOrCreateConversation(patientId, dId, 'DOCTOR');
                } catch { /* assignment check may fail for removed assignments */ }
            }
            for (const tId of targetTherapistIds) {
                try {
                    await this.getOrCreateConversation(patientId, tId, 'THERAPIST');
                } catch { /* assignment check may fail for removed assignments */ }
            }

            where = { patientId };
        } else {
            throw new Error('Only doctors, therapists, pharmacists and patients can chat');
        }

        return prisma.conversation.findMany({
            where,
            include: {
                patient: { select: { fullName: true, userId: true } },
                doctor: { select: { fullName: true, userId: true, profilePhoto: true } },
                therapist: { select: { fullName: true, userId: true, profilePhoto: true } },
                pharmacist: { select: { fullName: true, userId: true, profilePhoto: true } },
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1
                }
            },
            orderBy: { updatedAt: 'desc' }
        });
    }

    static async getMessages(conversationId, userId, { cursor, limit = 50 } = {}) {
        // Verify the requesting user is a participant before returning messages
        await this.verifyParticipant(conversationId, userId);

        const where = { conversationId };
        if (cursor) {
            where.createdAt = { lt: new Date(cursor) };
        }

        const messages = await prisma.message.findMany({
            where,
            include: {
                sender: {
                    select: {
                        id: true,
                        role: true,
                        doctor: { select: { fullName: true } },
                        patient: { select: { fullName: true } },
                        therapist: { select: { fullName: true } },
                        pharmacist: { select: { fullName: true } }
                    }
                }
            },
            orderBy: { createdAt: 'desc' },
            take: limit + 1, // fetch one extra to determine hasMore
        });

        const hasMore = messages.length > limit;
        if (hasMore) messages.pop();
        messages.reverse(); // Return in chronological order

        return {
            messages,
            hasMore,
            nextCursor: hasMore ? messages[0]?.createdAt?.toISOString() : null,
        };
    }

    static async initiateConversation(currentUserId, partnerUserId) {
        const [currentUser, partnerUser] = await Promise.all([
            prisma.user.findUnique({
                where: { id: currentUserId },
                include: { doctor: true, patient: true, therapist: true, pharmacist: true }
            }),
            prisma.user.findUnique({
                where: { id: partnerUserId },
                include: { doctor: true, patient: true, therapist: true, pharmacist: true }
            })
        ]);

        if (!currentUser || !partnerUser) throw new Error('User not found');

        let patientId, targetId, clinicianType = 'DOCTOR';

        if (currentUser.patient && (partnerUser.doctor || partnerUser.therapist || partnerUser.pharmacist)) {
            patientId = currentUser.patient.id;
            targetId = partnerUser.doctor?.id || partnerUser.therapist?.id || partnerUser.pharmacist?.id;
            clinicianType = partnerUser.doctor ? 'DOCTOR' : (partnerUser.therapist ? 'THERAPIST' : 'PHARMACIST');
        } else if (partnerUser.patient && (currentUser.doctor || currentUser.therapist || currentUser.pharmacist)) {
            patientId = partnerUser.patient.id;
            targetId = currentUser.doctor?.id || currentUser.therapist?.id || currentUser.pharmacist?.id;
            clinicianType = currentUser.doctor ? 'DOCTOR' : (currentUser.therapist ? 'THERAPIST' : 'PHARMACIST');
        } else {
            throw new Error('Only patients can chat with doctors/therapists/pharmacists and vice versa');
        }

        // getOrCreateConversation will verify assignment before creating
        return this.getOrCreateConversation(patientId, targetId, clinicianType);
    }
}
