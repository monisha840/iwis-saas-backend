import express from 'express';
import { z } from 'zod';
import { GroupSessionService } from '../services/groupSession.service.js';
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

router.post('/', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'THERAPIST'), async (req, res, next) => {
    try {
        const data = createSchema.parse(req.body);
        res.status(201).json(await GroupSessionService.create(data));
    } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
    try {
        // hospitalId pinned from the JWT — without it a stale token could
        // list group sessions across hospitals. branchId remains optional
        // so admin "All Branches" view returns the hospital-wide list.
        res.json(await GroupSessionService.list({
            branchId: req.query.branchId || undefined,
            hospitalId: req.user?.hospitalId ?? null,
            date: req.query.date,
            therapistId: req.query.therapistId,
        }));
    } catch (err) { next(err); }
});

router.post('/:id/join', async (req, res, next) => {
    try {
        const patientId = req.body.patientId || req.user?.patient?.id;
        if (!patientId) return res.status(400).json({ error: 'patientId is required' });
        res.status(201).json(await GroupSessionService.join({ groupSessionId: req.params.id, patientId }));
    } catch (err) { next(err); }
});

router.post('/:id/complete', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'THERAPIST'), async (req, res, next) => {
    try {
        res.json(await GroupSessionService.complete(req.params.id));
    } catch (err) { next(err); }
});

router.post('/:id/cancel', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'THERAPIST'), async (req, res, next) => {
    try {
        res.json(await GroupSessionService.cancel(req.params.id));
    } catch (err) { next(err); }
});

router.get('/:id/roster', async (req, res, next) => {
    try {
        const r = await GroupSessionService.getRoster(req.params.id);
        if (!r) return res.status(404).json({ error: 'Not found' });
        res.json(r);
    } catch (err) { next(err); }
});

export default router;
