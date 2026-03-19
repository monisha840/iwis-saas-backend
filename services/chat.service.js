import prisma from '../lib/prisma.js';

export class ChatService {
    static async getOrCreateConversation(patientId, targetId, clinicianType = 'DOCTOR') {
        const whereMap = {
            'DOCTOR': { patientId_doctorId: { patientId, doctorId: targetId } },
            'THERAPIST': { patientId_therapistId: { patientId, therapistId: targetId } },
            'PHARMACIST': { patientId_pharmacistId: { patientId, pharmacistId: targetId } }
        };

        const where = whereMap[clinicianType] || whereMap['DOCTOR'];

        let conversation = await prisma.conversation.findUnique({ where });

        if (!conversation) {
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

    static async listUserConversations(userId) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { doctor: true, patient: true, therapist: true }
        });

        let where = {};
        if (user.doctor) {
            where = { doctorId: user.doctor.id };
        } else if (user.therapist) {
            where = { therapistId: user.therapist.id };
        } else if (user.pharmacist) {
            where = { pharmacistId: user.pharmacist.id };
        } else if (user.patient) {
            const patientId = user.patient.id;

            // Auto-initialize conversations for patients
            const adminDoctor = await prisma.doctor.findFirst({
                where: { user: { role: 'ADMIN_DOCTOR' } }
            });

            const recentAppointments = await prisma.appointment.findMany({
                where: {
                    patientId,
                    status: { in: ['CONFIRMED', 'COMPLETED'] }
                },
                select: { doctorId: true, therapistId: true },
                distinct: ['doctorId', 'therapistId']
            });

            const targetDoctorIds = new Set();
            if (adminDoctor) targetDoctorIds.add(adminDoctor.id);

            const targetTherapistIds = new Set();

            recentAppointments.forEach(a => {
                if (a.doctorId) targetDoctorIds.add(a.doctorId);
                if (a.therapistId) targetTherapistIds.add(a.therapistId);
            });

            for (const dId of targetDoctorIds) {
                await this.getOrCreateConversation(patientId, dId, 'DOCTOR');
            }
            for (const tId of targetTherapistIds) {
                await this.getOrCreateConversation(patientId, tId, 'THERAPIST');
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

    static async getMessages(conversationId) {
        return prisma.message.findMany({
            where: { conversationId },
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
            orderBy: { createdAt: 'asc' }
        });
    }

    static async initiateConversation(currentUserId, partnerUserId) {
        const [currentUser, partnerUser] = await Promise.all([
            prisma.user.findUnique({
                where: { id: currentUserId },
                include: { doctor: true, patient: true, therapist: true }
            }),
            prisma.user.findUnique({
                where: { id: partnerUserId },
                include: { doctor: true, patient: true, therapist: true }
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

        return this.getOrCreateConversation(patientId, targetId, clinicianType);
    }
}
