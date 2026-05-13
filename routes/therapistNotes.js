// SOAP-format therapist session notes.
//
// Mounted at /api/therapist-notes. Distinct from Appointment.sessionNotes
// (which is the doctor's free-text consult notes) — these are the
// therapist's structured Subjective / Objective / Assessment / Plan
// notes per sitting, optionally tied to an appointment, optionally
// visible to the patient's doctor.
//
// Endpoints:
//   POST   /                  — author a new note (THERAPIST only)
//   GET    /                  — list notes (caller-scoped, see below)
//   GET    /:id               — single note (author + clinician roles)
//   PATCH  /:id               — update own note (THERAPIST only)
//
// Access shape on the list endpoint:
//   THERAPIST           → own notes only; optional patientId filter
//   DOCTOR / ADMIN_DOCTOR / ADMIN
//                       → patientId required; only notes with
//                         isVisibleToDoctor = true are returned. Used by
//                         the patient timeline view.
//
// All write paths are scoped to the caller's therapistId, which we
// resolve from req.user.id (User → Therapist via the unique @userId).

import express from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const SESSION_TYPES = ['INDIVIDUAL', 'GROUP', 'HOME_THERAPY'];

const createSchema = z.object({
    patientId:       z.string().min(1),
    appointmentId:   z.string().min(1).optional(),
    subjective:      z.string().max(5000).optional(),
    objective:       z.string().max(5000).optional(),
    assessment:      z.string().max(5000).optional(),
    plan:            z.string().max(5000).optional(),
    sessionType:     z.enum(SESSION_TYPES).optional(),
    duration:        z.coerce.number().int().min(0).max(480).optional(),
    nextSessionPlan: z.string().max(5000).optional(),
    isVisibleToDoctor: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

const listQuerySchema = z.object({
    patientId: z.string().optional(),
});

const NOTE_SELECT = {
    id: true,
    therapistId: true,
    patientId: true,
    appointmentId: true,
    subjective: true,
    objective: true,
    assessment: true,
    plan: true,
    sessionType: true,
    duration: true,
    nextSessionPlan: true,
    isVisibleToDoctor: true,
    createdAt: true,
    updatedAt: true,
    therapist: { select: { id: true, fullName: true, profilePhoto: true } },
    patient:   { select: { id: true, fullName: true, patientId: true } },
    appointment: { select: { id: true, date: true, status: true } },
};

/** Resolve the caller's Therapist row from req.user.id. Returns null when
 *  the caller is a clinician role but has no Therapist record (orphan
 *  user); the calling handler short-circuits with an appropriate response. */
async function callerTherapist(req) {
    return prisma.therapist.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
    });
}

// ── POST / — create note ──────────────────────────────────────────────────
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

            // Patient + appointment ownership sniff. Patient must exist;
            // appointment (when supplied) must reference the same patient.
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

            const note = await prisma.therapistSessionNote.create({
                data: { ...req.body, therapistId: therapist.id },
                select: NOTE_SELECT,
            });
            res.status(201).json({ data: { note } });
        } catch (err) { next(err); }
    },
);

// ── GET / — list notes (scoped) ────────────────────────────────────────────
router.get(
    '/',
    authMiddleware,
    roleMiddleware(['THERAPIST', 'DOCTOR', 'ADMIN_DOCTOR', 'ADMIN']),
    validate({ query: listQuerySchema }),
    async (req, res, next) => {
        try {
            const { patientId } = req.query;
            const where = {};

            if (req.user.role === 'THERAPIST') {
                const therapist = await callerTherapist(req);
                if (!therapist) {
                    return res.json({ data: { notes: [] } });
                }
                where.therapistId = therapist.id;
                if (patientId) where.patientId = patientId;
            } else {
                // DOCTOR / ADMIN_DOCTOR / ADMIN: require patientId and only
                // surface notes the author flagged visible to the doctor.
                if (!patientId) {
                    return res.status(400).json({ error: 'patientId is required for this role' });
                }
                where.patientId = patientId;
                where.isVisibleToDoctor = true;
            }

            const notes = await prisma.therapistSessionNote.findMany({
                where,
                select: NOTE_SELECT,
                orderBy: { createdAt: 'desc' },
            });
            res.json({ data: { notes } });
        } catch (err) { next(err); }
    },
);

// ── GET /:id — single note ────────────────────────────────────────────────
router.get(
    '/:id',
    authMiddleware,
    roleMiddleware(['THERAPIST', 'DOCTOR', 'ADMIN_DOCTOR', 'ADMIN']),
    async (req, res, next) => {
        try {
            const note = await prisma.therapistSessionNote.findUnique({
                where: { id: req.params.id },
                select: NOTE_SELECT,
            });
            if (!note) return res.status(404).json({ error: 'Note not found' });

            // Authors always see their own notes regardless of visibility.
            // Other clinicians only see notes the author opted-in to share.
            if (req.user.role === 'THERAPIST') {
                const therapist = await callerTherapist(req);
                if (!therapist || therapist.id !== note.therapistId) {
                    return res.status(403).json({ error: 'Forbidden' });
                }
            } else if (!note.isVisibleToDoctor) {
                return res.status(403).json({ error: 'Note is private to the authoring therapist' });
            }

            res.json({ data: { note } });
        } catch (err) { next(err); }
    },
);

// ── PATCH /:id — update own note ──────────────────────────────────────────
router.patch(
    '/:id',
    authMiddleware,
    roleMiddleware(['THERAPIST']),
    validate({ body: updateSchema }),
    async (req, res, next) => {
        try {
            const therapist = await callerTherapist(req);
            if (!therapist) {
                return res.status(403).json({ error: 'No therapist profile for this account' });
            }
            const existing = await prisma.therapistSessionNote.findUnique({
                where: { id: req.params.id },
                select: { id: true, therapistId: true, patientId: true },
            });
            if (!existing) return res.status(404).json({ error: 'Note not found' });
            if (existing.therapistId !== therapist.id) {
                return res.status(403).json({ error: 'Cannot edit another therapist’s note' });
            }
            // Block re-assigning the note to a different patient on update —
            // patient + appointment ownership were validated on POST.
            if (req.body.patientId && req.body.patientId !== existing.patientId) {
                return res.status(400).json({ error: 'patientId cannot be changed after creation' });
            }

            const updated = await prisma.therapistSessionNote.update({
                where: { id: req.params.id },
                data: req.body,
                select: NOTE_SELECT,
            });
            res.json({ data: { note: updated } });
        } catch (err) { next(err); }
    },
);

export default router;
