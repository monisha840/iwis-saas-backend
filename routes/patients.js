/**
 * Patients route — currently scoped to walk-in guest patient creation.
 *
 * Mounted at /api/patients (alongside the existing timeline routes mount on
 * the same prefix; Express dispatches by path so /api/patients/guest is
 * uniquely handled here and never collides with /api/patients/:id/timeline).
 *
 * Only one endpoint today:
 *   POST /guest  — ADMIN / ADMIN_DOCTOR creates a temporary guest patient
 *                  profile for a walk-in booking. Returns the existing
 *                  Patient row if a User with the same phone already exists.
 *
 * Why not extend AppointmentService.createAppointment to handle this?
 * Because guest creation must happen BEFORE the appointment is booked
 * (the appointment FK requires Patient.id), and the front-desk flow needs
 * the "already exists" path to surface to the UI for confirmation.
 */

import express from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const guestSchema = z.object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(5).max(20),
    age: z.union([z.number().int().min(0).max(150), z.string().regex(/^\d+$/)]),
    gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'male', 'female', 'other']),
    prakriti: z.string().trim().max(40).optional().nullable(),
});

router.post(
    '/guest',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    validate({ body: guestSchema }),
    async (req, res, next) => {
        try {
            const { name, phone, age, gender, prakriti } = req.body;
            const ageNum = typeof age === 'number' ? age : parseInt(age, 10);

            // Phone-based duplicate check. User has no `phone` field, so the
            // canonical phone storage for patients is Patient.phoneNumber.
            const existingPatient = await prisma.patient.findFirst({
                where: { phoneNumber: phone },
                include: { user: { select: { id: true, email: true, branchId: true } } },
            });
            if (existingPatient) {
                return res.json({
                    patient: existingPatient,
                    alreadyExists: true,
                    message: 'Patient already exists in system',
                });
            }

            // Generate a unique synthetic email — phone alone isn't guaranteed
            // unique on User.email and the column has a unique index.
            const syntheticEmail = `guest-${phone}-${Date.now()}@walkin.alshifa.com`;
            const randomPwd = await bcrypt.hash(Math.random().toString(36) + Date.now(), 10);

            // Compute a DOB from age so age-based queries / reports keep working.
            // Jan 1 of (currentYear - age) is the long-standing convention used
            // elsewhere in the codebase for age-only patient records.
            const dob = new Date(new Date().getFullYear() - ageNum, 0, 1);

            const patient = await prisma.$transaction(async (tx) => {
                const guestUser = await tx.user.create({
                    data: {
                        email: syntheticEmail,
                        password: randomPwd,
                        role: 'PATIENT',
                        emailVerifiedAt: new Date(),
                        branchId: req.user.branchId,
                    },
                });

                return tx.patient.create({
                    data: {
                        userId: guestUser.id,
                        branchId: req.user.branchId,
                        fullName: name,
                        phoneNumber: phone,
                        age: ageNum,
                        dob,
                        gender: gender.toUpperCase(),
                        isGuest: true,
                        onboardingCompleted: false,
                        onboardingData: {
                            name,
                            age: ageNum,
                            prakriti: prakriti || null,
                            registeredBy: req.user.id,
                            registeredAt: new Date().toISOString(),
                            source: 'WALK_IN',
                        },
                    },
                });
            });

            // Audit log — best-effort, must not block the response if the
            // schema doesn't have a column the row tries to write.
            try {
                await prisma.auditLog.create({
                    data: {
                        userId: req.user.id,
                        action: 'GUEST_PATIENT_CREATED',
                        entityType: 'Patient',
                        entityId: patient.id,
                        newData: { name, phone, age: ageNum, gender, isWalkIn: true },
                    },
                });
            } catch (auditErr) {
                console.warn('[patients/guest] audit log skipped:', auditErr.message);
            }

            return res.status(201).json({ patient, alreadyExists: false });
        } catch (err) { next(err); }
    },
);

export default router;
