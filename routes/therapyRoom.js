import express from 'express';
import { z } from 'zod';
import { TherapyRoomService } from '../services/therapyRoom.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature('THERAPY_ROOM_MANAGEMENT'));

const roomTypes = ['SHIRODHARA','ABHYANGA','PANCHAKARMA_GENERAL','STEAM','CONSULTATION','GROUP'];

const createRoomSchema = z.object({
    branchId: z.string().min(1),
    name:     z.string().min(1),
    type:     z.enum(roomTypes),
    capacity: z.coerce.number().int().positive().default(1),
    notes:    z.string().optional(),
    isActive: z.boolean().optional(),
});

const bookSchema = z.object({
    appointmentId: z.string().min(1),
    date:          z.coerce.date(),
    startTime:     z.string().regex(/^\d{2}:\d{2}$/),
    endTime:       z.string().regex(/^\d{2}:\d{2}$/),
    notes:         z.string().optional(),
});

router.get('/', async (req, res, next) => {
    try {
        const branchId = req.query.branchId;
        if (!branchId) return res.status(400).json({ error: 'branchId is required' });
        const rooms = await TherapyRoomService.listRooms(branchId);
        res.json(rooms);
    } catch (err) { next(err); }
});

router.post('/', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = createRoomSchema.parse(req.body);
        const room = await TherapyRoomService.createRoom(data);
        res.status(201).json(room);
    } catch (err) { next(err); }
});

router.put('/:id', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = createRoomSchema.partial().parse(req.body);
        const room = await TherapyRoomService.updateRoom(req.params.id, data);
        res.json(room);
    } catch (err) { next(err); }
});

router.delete('/:id', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        await TherapyRoomService.deactivateRoom(req.params.id);
        res.json({ success: true });
    } catch (err) { next(err); }
});

router.get('/:id/availability', async (req, res, next) => {
    try {
        const date = req.query.date ? new Date(req.query.date) : new Date();
        const summary = await TherapyRoomService.getRoomAvailability(req.params.id, date);
        if (!summary) return res.status(404).json({ error: 'Room not found' });
        res.json(summary);
    } catch (err) { next(err); }
});

router.post('/:id/book', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST'), async (req, res, next) => {
    try {
        const data = bookSchema.parse(req.body);
        const booking = await TherapyRoomService.bookRoom({ roomId: req.params.id, ...data });
        res.status(201).json(booking);
    } catch (err) { next(err); }
});

router.delete('/bookings/:id', authorizeRoles('ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST'), async (req, res, next) => {
    try {
        const out = await TherapyRoomService.cancelBooking(req.params.id);
        res.json(out);
    } catch (err) { next(err); }
});

router.get('/therapist/:therapistId/schedule', async (req, res, next) => {
    try {
        const date = req.query.date ? new Date(req.query.date) : new Date();
        const schedule = await TherapyRoomService.getTherapistSchedule(req.params.therapistId, date);
        res.json(schedule);
    } catch (err) { next(err); }
});

export default router;
