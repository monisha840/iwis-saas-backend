import express from 'express';
import { SlotOptimizationService } from '../services/slotOptimization.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = express.Router();

/**
 * @swagger
 * /slot-optimization/durations:
 *   get:
 *     tags: [Slot Optimization]
 *     summary: Get optimal slot duration suggestions based on historical data
 *     parameters:
 *       - in: query
 *         name: clinicianId
 *         schema: { type: string }
 *         description: Clinician ID (admin only, defaults to self)
 *     responses:
 *       200: { description: Slot duration suggestions by consultation type }
 */
router.get('/durations', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), async (req, res, next) => {
    try {
        const clinicianId = await resolveClinicianId(req);
        const durations = await SlotOptimizationService.getOptimalSlotDurations(clinicianId);
        res.json(durations);
    } catch (err) {
        next(err);
    }
});

/**
 * @swagger
 * /slot-optimization/overbooking:
 *   get:
 *     tags: [Slot Optimization]
 *     summary: Detect overbooking patterns
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Overbooking warnings }
 */
router.get('/overbooking', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), async (req, res, next) => {
    try {
        const clinicianId = await resolveClinicianId(req);
        const { from, to } = req.query;
        const result = await SlotOptimizationService.detectOverbooking(clinicianId, { from, to });
        res.json(result);
    } catch (err) {
        next(err);
    }
});

/**
 * @swagger
 * /slot-optimization/utilization:
 *   get:
 *     tags: [Slot Optimization]
 *     summary: Get utilization metrics for a clinician
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Utilization metrics including rates and patterns }
 */
router.get('/utilization', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), async (req, res, next) => {
    try {
        const clinicianId = await resolveClinicianId(req);
        const { from, to } = req.query;
        const metrics = await SlotOptimizationService.getUtilizationMetrics(clinicianId, { from, to });
        res.json(metrics);
    } catch (err) {
        next(err);
    }
});

/**
 * @swagger
 * /slot-optimization/suggestions:
 *   get:
 *     tags: [Slot Optimization]
 *     summary: Get smart scheduling suggestions
 *     responses:
 *       200: { description: Prioritized list of scheduling improvement suggestions }
 */
router.get('/suggestions', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']), async (req, res, next) => {
    try {
        const clinicianId = await resolveClinicianId(req);
        const suggestions = await SlotOptimizationService.getSchedulingSuggestions(clinicianId);
        res.json(suggestions);
    } catch (err) {
        next(err);
    }
});

/**
 * Resolve the clinician profile ID from the requesting user.
 * Admins can pass a clinicianId query param; clinicians use their own.
 */
async function resolveClinicianId(req) {
    const isAdmin = ['ADMIN', 'ADMIN_DOCTOR'].includes(req.user.role);

    if (isAdmin && req.query.clinicianId) {
        return req.query.clinicianId;
    }

    const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        include: { doctor: true, therapist: true },
    });

    if (user?.doctor) return user.doctor.id;
    if (user?.therapist) return user.therapist.id;
    throw new Error('Clinician profile not found');
}

export default router;
