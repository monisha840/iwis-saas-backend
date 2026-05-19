import express from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { GroupSessionService, assertCanMutateSession } from '../services/groupSession.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature('GROUP_SESSIONS'));

const createSchema = z.object({
    branchId:    z.string(),
    therapistId: z.string(),
    roomId:      z.string().optional(),
    title:       z.string().min(2),
    sessionType: z.string().min(2),
    date:        z.coerce.date(),
    startTime:   z.string().regex(/^\d{2}:\d{2}$/),
    endTime:     z.string().regex(/^\d{2}:\d{2}$/),
    maxCapacity: z.coerce.number().int().positive(),
    // Pre-enrol N patients at session-create time. Each id is bulk-joined
    // by the service. Optional so the legacy "create empty session, patients
    // join later" flow still works.
    patientIds:  z.array(z.string().min(1)).optional(),
});

router.post('/', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'THERAPIST', 'DOCTOR'), async (req, res, next) => {
    try {
        const data = createSchema.parse(req.body);
        // createdById is set server-side from the JWT, never from the request
        // body — it's the ownership key used by the cancel/complete authz
        // helper, so we can't let the caller forge it.
        res.status(201).json(await GroupSessionService.create({ ...data, createdById: req.user.id }));
    } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
    try {
        // hospitalId pinned from the JWT — without it a stale token could
        // list group sessions across hospitals. branchId remains optional
        // so admin "All Branches" view returns the hospital-wide list.
        //
        // Patient callers see only the sessions they are enrolled in (i.e.
        // have an Appointment row pointing at). The JWT doesn't carry the
        // Patient.id so we resolve it from User.id; missing profile → empty
        // list rather than leaking the branch-wide roster.
        let patientId;
        if (req.user?.role === 'PATIENT') {
            const patient = await prisma.patient.findUnique({
                where: { userId: req.user.id },
                select: { id: true },
            });
            if (!patient) return res.json([]);
            patientId = patient.id;
        }
        res.json(await GroupSessionService.list({
            branchId: req.query.branchId || undefined,
            hospitalId: req.user?.hospitalId ?? null,
            date: req.query.date,
            therapistId: req.query.therapistId,
            patientId,
        }));
    } catch (err) { next(err); }
});

router.post('/:id/join', async (req, res, next) => {
    try {
        // Patients can only enrol themselves. Force the patientId from the
        // JWT-resolved user, not the request body — otherwise a forged
        // body.patientId would let a patient enrol a different patient.
        // Clinicians (ADMIN / ADMIN_DOCTOR / THERAPIST) keep their existing
        // ability to enrol any patient by id (used by the New Session form).
        let patientId;
        if (req.user.role === 'PATIENT') {
            const patient = await prisma.patient.findUnique({
                where: { userId: req.user.id },
                select: { id: true },
            });
            if (!patient) return res.status(400).json({ error: 'No patient profile for this account' });
            patientId = patient.id;
        } else {
            patientId = req.body.patientId;
            if (!patientId) return res.status(400).json({ error: 'patientId is required' });
        }
        res.status(201).json(await GroupSessionService.join({ groupSessionId: req.params.id, patientId }));
    } catch (err) { next(err); }
});

router.post('/:id/complete', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'THERAPIST', 'DOCTOR'), async (req, res, next) => {
    try {
        // Role gate above lets DOCTOR / THERAPIST in. assertCanMutateSession
        // narrows further: only the author, the lead therapist, or an admin
        // can mark a specific session complete.
        await assertCanMutateSession(req.params.id, req.user);
        res.json(await GroupSessionService.complete(req.params.id));
    } catch (err) { next(err); }
});

router.post('/:id/cancel', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'THERAPIST', 'DOCTOR'), async (req, res, next) => {
    try {
        await assertCanMutateSession(req.params.id, req.user);
        res.json(await GroupSessionService.cancel(req.params.id));
    } catch (err) { next(err); }
});

// Roster exposes every enrolled participant's name + phone. Clinicians
// (THERAPIST / DOCTOR / ADMIN / ADMIN_DOCTOR) need it to run the session
// and complete attendance; patients have no use case for seeing the rest
// of the roster and shouldn't be able to enumerate other patients via
// session ids. Gated accordingly.
router.get('/:id/roster', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'THERAPIST', 'DOCTOR'), async (req, res, next) => {
    try {
        const r = await GroupSessionService.getRoster(req.params.id);
        if (!r) return res.status(404).json({ error: 'Not found' });
        res.json(r);
    } catch (err) { next(err); }
});

// Live attendance toggle — therapist marks an enrolled participant
// present/absent during the session. participantId is the Appointment.id
// (the join row); isPresent flips it into / out of the session's
// attendedParticipantIds array. The complete() flow then uses that array
// to set COMPLETED vs NO_SHOW per appointment.
const attendanceSchema = z.object({
    participantId: z.string().min(1),
    isPresent:     z.boolean(),
});
router.patch('/:id/attendance', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'THERAPIST', 'DOCTOR'), async (req, res, next) => {
    try {
        const data = attendanceSchema.parse(req.body);
        res.json(await GroupSessionService.setAttendance(req.params.id, data));
    } catch (err) { next(err); }
});

export default router;
