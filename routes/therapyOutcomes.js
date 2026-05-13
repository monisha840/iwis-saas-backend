// Structured per-session therapy outcomes.
//
// Mounted at /api/therapy-outcomes. Complements the SOAP free-text
// notes at /api/therapist-notes — these rows carry the quantifiable
// score fields (pain / mobility / swelling) that the doctor trends
// across sessions on the patient timeline.
//
// Endpoints:
//   POST /                        — author an outcome (THERAPIST only)
//   GET  /:patientId              — list outcomes for a patient
//                                   THERAPIST → own outcomes
//                                   DOCTOR / ADMIN_DOCTOR / ADMIN → all
//
// All write paths resolve the caller's therapistId from req.user.id
// so the body can't forge ownership.

import express from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const createSchema = z.object({
    patientId:             z.string().min(1),
    appointmentId:         z.string().min(1).optional(),
    sessionDate:           z.string().min(1), // YYYY-MM-DD or full ISO
    mobilityScore:         z.coerce.number().int().min(0).max(100).optional(),
    painScore:             z.coerce.number().int().min(0).max(10).optional(),
    swellingReduced:       z.boolean().optional(),
    functionalImprovement: z.string().max(2000).optional(),
    therapistObservation:  z.string().max(2000).optional(),
    nextSessionGoal:       z.string().max(2000).optional(),
});

const OUTCOME_SELECT = {
    id: true,
    therapistId: true,
    patientId: true,
    appointmentId: true,
    sessionDate: true,
    mobilityScore: true,
    painScore: true,
    swellingReduced: true,
    functionalImprovement: true,
    therapistObservation: true,
    nextSessionGoal: true,
    createdAt: true,
    updatedAt: true,
    therapist: { select: { id: true, fullName: true, profilePhoto: true } },
};

async function callerTherapist(req) {
    return prisma.therapist.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
    });
}

// ── POST / ────────────────────────────────────────────────────────────────
router.post(
    '/',
    authMiddleware,
    roleMiddleware(['THERAPIST']),
    validate({ body: createSchema }),
    async (req, res, next) => {
        try {
            const therapist = await callerTherapist(req);
            if (!therapist) {
                return res.status(403).json({ error: 'No therapist profile for this account' });
            }

            // Patient + appointment ownership sniff — patient must exist,
            // and (when an appointment is supplied) it must reference the
            // same patient. Same pattern as therapistNotes for symmetry.
            const patient = await prisma.patient.findUnique({
                where: { id: req.body.patientId },
                select: { id: true },
            });
            if (!patient) return res.status(404).json({ error: 'Patient not found' });
            if (req.body.appointmentId) {
                const appt = await prisma.appointment.findUnique({
                    where: { id: req.body.appointmentId },
                    select: { id: true, patientId: true },
                });
                if (!appt || appt.patientId !== req.body.patientId) {
                    return res.status(400).json({ error: 'Appointment does not belong to this patient' });
                }
            }

            const outcome = await prisma.therapyOutcome.create({
                data: {
                    ...req.body,
                    sessionDate: new Date(req.body.sessionDate),
                    therapistId: therapist.id,
                },
                select: OUTCOME_SELECT,
            });
            res.status(201).json({ data: { outcome } });
        } catch (err) { next(err); }
    },
);

// ── GET /:patientId ───────────────────────────────────────────────────────
router.get(
    '/:patientId',
    authMiddleware,
    roleMiddleware(['THERAPIST', 'DOCTOR', 'ADMIN_DOCTOR', 'ADMIN']),
    async (req, res, next) => {
        try {
            const where = { patientId: req.params.patientId };
            if (req.user.role === 'THERAPIST') {
                const therapist = await callerTherapist(req);
                if (!therapist) {
                    return res.json({ data: { outcomes: [] } });
                }
                where.therapistId = therapist.id;
            }
            const outcomes = await prisma.therapyOutcome.findMany({
                where,
                select: OUTCOME_SELECT,
                orderBy: { sessionDate: 'desc' },
            });
            res.json({ data: { outcomes } });
        } catch (err) { next(err); }
    },
);

export default router;
