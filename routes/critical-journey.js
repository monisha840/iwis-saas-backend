/**
 * /api/critical-journey — admin view of patients auto-flagged as critical
 * (missed meds, missed vital uploads, missed follow-ups, skipped check-ins).
 *
 * Feature-gated on CRITICAL_JOURNEY_DASHBOARD (seeded isCore=true so every
 * non-decommissioned hospital has it on by default).
 */

import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { auditAction } from '../middleware/auditLog.js';
import { validate } from '../middleware/validate.js';
import { CriticalJourneyController } from '../controllers/criticalJourney.controller.js';

const router = express.Router();

router.use(authMiddleware);
router.use(requireFeature('CRITICAL_JOURNEY_DASHBOARD'));

// Admin/admin-doctor only — this is an admin oversight surface, not a
// patient- or clinician-facing feature.
const adminGate = roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']);

// Both roles span every branch in their hospital, so the branchId filter
// is a narrowing tool rather than a tenancy gate. The Zod schema below
// just keeps malformed/array-injected values out of Prisma where clauses.
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];
const listQuerySchema = z.object({
    branchId: z.string().min(1).max(64).optional(),
    severity: z.enum(SEVERITIES).optional(),
    limit:    z.coerce.number().int().min(1).max(500).optional(),
});
const statsQuerySchema = listQuerySchema.pick({ branchId: true });
const scanQuerySchema  = statsQuerySchema;
const resolveBodySchema = z.object({
    note: z.string().trim().max(2000).optional(),
});

// Aggregate counters for the dashboard KPI card.
router.get('/stats', adminGate, validate({ query: statsQuerySchema }), CriticalJourneyController.stats);

// Full list of currently-flagged patients (optionally filtered by branch
// or severity). Powers the dedicated Critical Journey page.
router.get('/', adminGate, validate({ query: listQuerySchema }), CriticalJourneyController.list);

// Manual rescan trigger (the cron runs every few hours, but admins may
// want to force a fresh sweep after a bulk intervention).
router.post('/scan', adminGate,
    validate({ query: scanQuerySchema }),
    auditAction('CRITICAL_JOURNEY_SCAN', 'PatientCriticalFlag', () => null),
    CriticalJourneyController.scan,
);

// Resolve a patient's flag after manual intervention. `patientId` is
// Patient.id (not User.id).
router.post('/:patientId/resolve', adminGate,
    validate({ body: resolveBodySchema }),
    auditAction('CRITICAL_JOURNEY_RESOLVE', 'PatientCriticalFlag', (req) => req.params.patientId),
    CriticalJourneyController.resolve,
);

export default router;
