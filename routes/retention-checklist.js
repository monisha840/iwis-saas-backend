import express from 'express';
import { z } from 'zod';
import { RetentionChecklistService, CHECKLIST_CATEGORIES } from '../services/retention-checklist.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

// ── Validation schemas ────────────────────────────────────────────────────────

const checklistItemSchema = z.object({
    category: z.enum(CHECKLIST_CATEGORIES),
    status:   z.enum(['COMPLETED', 'PARTIAL', 'NOT_FOLLOWED']),
    notes:    z.string().max(1000).optional().or(z.null()),
});

const upsertSchema = z.object({
    // Accept a full array or a partial update (at least one item required)
    items: z.array(checklistItemSchema).min(1).max(CHECKLIST_CATEGORIES.length),
});

// ── Clinician write/upsert ─────────────────────────────────────────────────

/**
 * POST /api/retention-checklist/:appointmentId
 * Create or replace the checklist for an appointment.
 * Roles: DOCTOR, THERAPIST, ADMIN_DOCTOR, ADMIN
 */
router.post(
    '/:appointmentId',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR', 'ADMIN']),
    validate({ body: upsertSchema }),
    async (req, res, next) => {
        try {
            const checklist = await RetentionChecklistService.upsert(
                req.user,
                req.params.appointmentId,
                req.body.items,
            );
            res.status(200).json(checklist);
        } catch (err) {
            next(err);
        }
    },
);

// ── Read: by appointment ───────────────────────────────────────────────────

/**
 * GET /api/retention-checklist/appointment/:appointmentId
 * Fetch the checklist for a specific appointment.
 * Roles: DOCTOR, THERAPIST, ADMIN_DOCTOR, ADMIN, PATIENT (own only)
 */
router.get(
    '/appointment/:appointmentId',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR', 'ADMIN', 'PATIENT']),
    async (req, res, next) => {
        try {
            const checklist = await RetentionChecklistService.getByAppointment(
                req.user,
                req.params.appointmentId,
            );
            // Return 200 with null body when not yet submitted (prevents 404 confusion)
            res.json(checklist ?? null);
        } catch (err) {
            next(err);
        }
    },
);

// ── Read: by patient (history) ────────────────────────────────────────────

/**
 * GET /api/retention-checklist/patient/:patientId
 * Fetch all checklists for a patient with pagination.
 * Roles: DOCTOR, THERAPIST, ADMIN_DOCTOR, ADMIN, PATIENT (own only)
 */
router.get(
    '/patient/:patientId',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR', 'ADMIN', 'PATIENT']),
    async (req, res, next) => {
        try {
            const result = await RetentionChecklistService.getByPatient(
                req.user,
                req.params.patientId,
                { page: req.query.page, limit: req.query.limit },
            );
            res.json(result);
        } catch (err) {
            next(err);
        }
    },
);

// ── Clinician stats (engagement analytics) ───────────────────────────────

/**
 * GET /api/retention-checklist/stats/me
 * Returns retention submission stats for the authenticated clinician (last 30 days).
 * Roles: DOCTOR, THERAPIST, ADMIN_DOCTOR
 */
router.get(
    '/stats/me',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            const days = parseInt(req.query.days, 10) || 30;
            const stats = await RetentionChecklistService.getClinicianStats(req.user.id, days);
            res.json(stats);
        } catch (err) {
            next(err);
        }
    },
);

export default router;
