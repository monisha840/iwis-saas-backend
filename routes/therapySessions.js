/**
 * Therapist Session Workspace HTTP routes (Phase A — minimal).
 *
 * Mounted at /api/therapy-sessions. Five endpoints, all behind authMiddleware
 * + roleMiddleware(['THERAPIST', 'ADMIN_DOCTOR', 'ADMIN']):
 *   POST /start                Create an in-progress session for an appointment
 *   GET  /active                Caller's currently in-progress session, if any
 *   GET  /:id                   Single session detail (notes ordered asc)
 *   PATCH /:id/notes            Append-or-replace note body (60-second upsert window)
 *   POST /:id/complete          Mark session COMPLETED + flip Appointment.status
 *
 * Auth notes:
 *   • Appointment.therapistId references Therapist.id (legacy). We resolve
 *     therapy ownership via `appointment.therapist.userId === req.user.id`.
 *   • TherapySession.therapistId references User.id (intentional, set on
 *     start to whoever the appointment is assigned to). Subsequent
 *     endpoints compare `session.therapistId === req.user.id` directly.
 *   • ADMIN and ADMIN_DOCTOR can act on any session in their hospital.
 *
 * Phase B (NOT implemented here): WebSocket fan-out, structured pain/photo
 * fields, sessionsUsed increment on PackageEnrolment (no clean
 * Appointment → enrolment linkage today; would need either a schema
 * change or a PackageSessionLog lookup branch).
 */

import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import prisma from '../lib/prisma.js';

const router = express.Router();

const SESSION_ROLES = ['THERAPIST', 'ADMIN_DOCTOR', 'ADMIN'];

// ── Schemas ────────────────────────────────────────────────────────────────

const startSchema = z.object({
    appointmentId: z.string().min(1),
});

const notesSchema = z.object({
    body: z.string().trim().max(10000),
});

// ── Phase B1 schemas ───────────────────────────────────────────────────────

const painReadingSchema = z.object({
    scale: z.number().int().min(0).max(10),
    bodyRegion: z.string().trim().max(100).optional(),
});

const regionNoteSchema = z.object({
    bodyRegion: z.string().trim().min(1).max(100),
    body: z.string().trim().min(1).max(2000),
});

const outcomeSchema = z.object({
    overallOutcome: z.enum(['IMPROVED', 'UNCHANGED', 'REGRESSED']),
    patientTolerance: z.enum(['GOOD', 'MODERATE', 'POOR']),
    nextSessionFocus: z.string().trim().max(1000).optional(),
    homeCareInstructions: z.string().trim().max(2000).optional(),
});

/** /complete now accepts an optional outcome alongside the original
 *  empty-body Phase A contract. Body without outcome behaves identically
 *  to Phase A. */
const completeSchema = z.object({
    outcome: outcomeSchema.optional(),
}).optional().default({});

// ── Helpers ────────────────────────────────────────────────────────────────

function isAdminRole(role) {
    return role === 'ADMIN' || role === 'ADMIN_DOCTOR';
}

/** Default include shape for session reads — covers everything the
 *  workspace renders without forcing each handler to repeat itself.
 *
 *  Phase B1: appended painReadings, regionNotes, outcome, photos. The
 *  Phase A keys (notes, patient, appointment) are unchanged in shape;
 *  Phase A's frontend continues to read them as before. */
const sessionInclude = {
    notes: { orderBy: { createdAt: 'asc' } },
    patient: {
        select: {
            id: true,
            fullName: true,
            patientId: true,
            phoneNumber: true,
        },
    },
    appointment: {
        select: {
            id: true,
            date: true,
            status: true,
            consultationType: true,
            consultationMode: true,
            therapistId: true,
            therapist: { select: { id: true, fullName: true, userId: true } },
        },
    },
    painReadings: { orderBy: { recordedAt: 'asc' } },
    regionNotes: { orderBy: { createdAt: 'asc' } },
    outcome: true,
    photos: { orderBy: { takenAt: 'asc' } },
};

/** Shared auth + status guard for the Phase B1 mutation endpoints. Returns
 *  either an Express response (caller must short-circuit) or the loaded
 *  session row. Behaviour mirrors the inline checks Phase A's PATCH /notes
 *  uses, so role + ownership semantics stay identical. */
async function loadInProgressSessionForCaller(req, res, sessionId) {
    const session = await prisma.therapySession.findUnique({
        where: { id: sessionId },
        select: { id: true, therapistId: true, status: true },
    });
    if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return null;
    }
    const isOwn = session.therapistId === req.user.id;
    if (!isAdminRole(req.user.role) && !isOwn) {
        res.status(403).json({ error: 'Forbidden' });
        return null;
    }
    if (session.status !== 'IN_PROGRESS') {
        res.status(409).json({
            error: 'This action is not allowed on a completed or abandoned session',
            code: 'SESSION_LOCKED',
        });
        return null;
    }
    return session;
}

// ── Routes ─────────────────────────────────────────────────────────────────

router.post(
    '/start',
    authMiddleware,
    roleMiddleware(SESSION_ROLES),
    validate({ body: startSchema }),
    async (req, res, next) => {
        try {
            const { appointmentId } = req.body;

            const appointment = await prisma.appointment.findUnique({
                where: { id: appointmentId },
                include: {
                    therapist: { select: { id: true, userId: true } },
                    patient: { select: { id: true, branchId: true } },
                },
            });
            if (!appointment) {
                return res.status(404).json({ error: 'Appointment not found' });
            }

            // Auth: caller must either be ADMIN/ADMIN_DOCTOR, or be the
            // assigned therapist (Therapist.userId === req.user.id).
            const isOwnTherapist =
                req.user.role === 'THERAPIST' &&
                appointment.therapist?.userId === req.user.id;
            if (!isAdminRole(req.user.role) && !isOwnTherapist) {
                return res.status(403).json({ error: 'You are not assigned to this appointment' });
            }

            if (!appointment.therapist?.userId) {
                return res.status(400).json({ error: 'Appointment has no assigned therapist' });
            }
            if (!appointment.patient?.branchId) {
                return res.status(400).json({ error: 'Appointment patient has no branch — cannot start session' });
            }

            // Both writes share a transaction so the appointment status flip
            // rolls back if the session create fails (and vice versa).
            try {
                const session = await prisma.$transaction(async (tx) => {
                    const created = await tx.therapySession.create({
                        data: {
                            appointmentId: appointment.id,
                            // Session ownership is the appointment's assigned
                            // therapist (the User behind the Therapist record),
                            // even when an admin clicked "Start" on their behalf.
                            therapistId: appointment.therapist.userId,
                            patientId: appointment.patient.id,
                            branchId: appointment.patient.branchId,
                            status: 'IN_PROGRESS',
                        },
                        include: sessionInclude,
                    });
                    await tx.appointment.update({
                        where: { id: appointment.id },
                        data: { status: 'IN_PROGRESS' },
                    });
                    return created;
                });
                return res.status(201).json(session);
            } catch (err) {
                // Prisma's @unique violation on appointmentId → 409 with a
                // human-friendly message. The unique index makes this race-safe.
                if (err?.code === 'P2002') {
                    return res.status(409).json({
                        error: 'Session already started for this appointment',
                        code: 'SESSION_ALREADY_EXISTS',
                    });
                }
                throw err;
            }
        } catch (err) { next(err); }
    },
);

router.get(
    '/active',
    authMiddleware,
    roleMiddleware(SESSION_ROLES),
    async (req, res, next) => {
        try {
            const session = await prisma.therapySession.findFirst({
                where: {
                    therapistId: req.user.id,
                    status: 'IN_PROGRESS',
                },
                orderBy: { startedAt: 'desc' },
                include: sessionInclude,
            });
            if (!session) {
                return res.status(404).json({ active: false });
            }
            res.json(session);
        } catch (err) { next(err); }
    },
);

router.get(
    '/:id',
    authMiddleware,
    roleMiddleware(SESSION_ROLES),
    async (req, res, next) => {
        try {
            const session = await prisma.therapySession.findUnique({
                where: { id: req.params.id },
                include: sessionInclude,
            });
            if (!session) return res.status(404).json({ error: 'Session not found' });

            // Only the assigned therapist or admins can read.
            const isOwn = session.therapistId === req.user.id;
            if (!isAdminRole(req.user.role) && !isOwn) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            res.json(session);
        } catch (err) { next(err); }
    },
);

router.patch(
    '/:id/notes',
    authMiddleware,
    roleMiddleware(SESSION_ROLES),
    validate({ body: notesSchema }),
    async (req, res, next) => {
        try {
            const session = await prisma.therapySession.findUnique({
                where: { id: req.params.id },
                select: { id: true, therapistId: true, status: true },
            });
            if (!session) return res.status(404).json({ error: 'Session not found' });

            const isOwn = session.therapistId === req.user.id;
            if (!isAdminRole(req.user.role) && !isOwn) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (session.status !== 'IN_PROGRESS') {
                return res.status(409).json({
                    error: 'Notes are read-only for completed or abandoned sessions',
                    code: 'SESSION_LOCKED',
                });
            }

            // Upsert window: if the most recent note for this session was
            // updated within the last 60 seconds, replace its body in place
            // rather than creating a new row. Keeps 5-second autosave bursts
            // from producing 12 rows per minute.
            const SIXTY_SECONDS_MS = 60 * 1000;
            const cutoff = new Date(Date.now() - SIXTY_SECONDS_MS);
            const latest = await prisma.sessionNote.findFirst({
                where: { sessionId: session.id, updatedAt: { gte: cutoff } },
                orderBy: { updatedAt: 'desc' },
                select: { id: true },
            });

            const note = latest
                ? await prisma.sessionNote.update({
                    where: { id: latest.id },
                    data: { body: req.body.body },
                })
                : await prisma.sessionNote.create({
                    data: { sessionId: session.id, body: req.body.body },
                });

            res.json(note);
        } catch (err) { next(err); }
    },
);

router.post(
    '/:id/complete',
    authMiddleware,
    roleMiddleware(SESSION_ROLES),
    validate({ body: completeSchema }),
    async (req, res, next) => {
        try {
            const session = await prisma.therapySession.findUnique({
                where: { id: req.params.id },
                select: {
                    id: true,
                    therapistId: true,
                    status: true,
                    appointmentId: true,
                },
            });
            if (!session) return res.status(404).json({ error: 'Session not found' });

            const isOwn = session.therapistId === req.user.id;
            if (!isAdminRole(req.user.role) && !isOwn) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (session.status !== 'IN_PROGRESS') {
                return res.status(409).json({
                    error: 'Session is not in progress',
                    code: 'SESSION_NOT_IN_PROGRESS',
                });
            }

            // Phase B1: optional structured outcome captured on Complete.
            // Body without `outcome` preserves Phase A's exact behaviour
            // (transactional status flip on session + appointment, no
            // outcome row created).
            const outcome = req.body?.outcome;

            // PackageEnrolment.sessionsUsed increment is intentionally NOT
            // performed here — Appointment has no direct enrolment FK, only
            // an indirect link through PackageSessionLog. Wiring the
            // increment cleanly is a Phase B concern (or needs a schema
            // change). Documented in the task's Out-of-scope section.
            try {
                const completed = await prisma.$transaction(async (tx) => {
                    const updated = await tx.therapySession.update({
                        where: { id: session.id },
                        data: { status: 'COMPLETED', completedAt: new Date() },
                    });
                    await tx.appointment.update({
                        where: { id: session.appointmentId },
                        data: { status: 'COMPLETED' },
                    });
                    if (outcome) {
                        await tx.sessionOutcome.create({
                            data: {
                                sessionId: session.id,
                                overallOutcome: outcome.overallOutcome,
                                patientTolerance: outcome.patientTolerance,
                                nextSessionFocus: outcome.nextSessionFocus ?? null,
                                homeCareInstructions: outcome.homeCareInstructions ?? null,
                                recordedById: req.user.id,
                            },
                        });
                    }
                    // Re-read with the full include so the response carries
                    // both the new status and (if just inserted) the
                    // outcome row in a single round trip.
                    return tx.therapySession.findUnique({
                        where: { id: updated.id },
                        include: sessionInclude,
                    });
                });
                return res.json(completed);
            } catch (err) {
                // P2002 on SessionOutcome.sessionId — caller submitted an
                // outcome for a session that already has one. Surface a
                // friendly 409. The session itself is already COMPLETED at
                // this point if the prior /complete call succeeded, so the
                // status guard above would normally short-circuit; this
                // branch only fires on a true race.
                if (err?.code === 'P2002') {
                    return res.status(409).json({
                        error: 'An outcome has already been recorded for this session',
                        code: 'OUTCOME_ALREADY_EXISTS',
                    });
                }
                throw err;
            }
        } catch (err) { next(err); }
    },
);

// ── Phase B1: pain readings, region notes ──────────────────────────────────

router.post(
    '/:id/pain-readings',
    authMiddleware,
    roleMiddleware(SESSION_ROLES),
    validate({ body: painReadingSchema }),
    async (req, res, next) => {
        try {
            const session = await loadInProgressSessionForCaller(req, res, req.params.id);
            if (!session) return; // response already sent

            const reading = await prisma.sessionPainReading.create({
                data: {
                    sessionId: session.id,
                    scale: req.body.scale,
                    bodyRegion: req.body.bodyRegion ?? null,
                },
            });
            res.status(201).json(reading);
        } catch (err) { next(err); }
    },
);

router.post(
    '/:id/region-notes',
    authMiddleware,
    roleMiddleware(SESSION_ROLES),
    validate({ body: regionNoteSchema }),
    async (req, res, next) => {
        try {
            const session = await loadInProgressSessionForCaller(req, res, req.params.id);
            if (!session) return;

            const note = await prisma.sessionRegionNote.create({
                data: {
                    sessionId: session.id,
                    bodyRegion: req.body.bodyRegion,
                    body: req.body.body,
                },
            });
            res.status(201).json(note);
        } catch (err) { next(err); }
    },
);

router.patch(
    '/:id/region-notes/:noteId',
    authMiddleware,
    roleMiddleware(SESSION_ROLES),
    validate({ body: regionNoteSchema }),
    async (req, res, next) => {
        try {
            const session = await loadInProgressSessionForCaller(req, res, req.params.id);
            if (!session) return;

            // Verify the note belongs to *this* session before allowing the
            // update — protects against a malicious caller passing a noteId
            // they own from a different session.
            const existing = await prisma.sessionRegionNote.findUnique({
                where: { id: req.params.noteId },
                select: { id: true, sessionId: true },
            });
            if (!existing || existing.sessionId !== session.id) {
                return res.status(404).json({ error: 'Region note not found' });
            }

            const updated = await prisma.sessionRegionNote.update({
                where: { id: existing.id },
                data: {
                    bodyRegion: req.body.bodyRegion,
                    body: req.body.body,
                },
            });
            res.json(updated);
        } catch (err) { next(err); }
    },
);

export default router;
