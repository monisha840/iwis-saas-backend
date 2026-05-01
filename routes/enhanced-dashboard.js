/**
 * Enhanced Patient Dashboard routes.
 *
 * Mounted at /api/patient/dashboard (PATIENT-only).
 */

import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware, resolvePatientId } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { EnhancedDashboardController } from '../controllers/enhancedDashboard.controller.js';

const router = express.Router();

router.use(authMiddleware);
router.use(roleMiddleware(['PATIENT']));
router.use(resolvePatientId);

// ── Zod schemas ───────────────────────────────────────────────────────────
// painRegions is a JSON field on DailyCheckIn / TriageSession. Service-level
// normalisation (`normalizePainRegions`) drops malformed entries silently;
// the schema below is the explicit *allow-list* of accepted fields so
// untrusted clients can't smuggle extra keys into the JSON column.
const PAIN_CHARACTERS = ['Aching', 'Burning', 'Stabbing', 'Throbbing', 'Cramping', 'Numbness', 'Tingling'];
const painRegionSchema = z.object({
  regionId:    z.string().trim().min(1).max(64),
  regionLabel: z.string().trim().max(80).optional(),
  intensity:   z.number().min(0).max(10),
  characters:  z.array(z.enum(PAIN_CHARACTERS)).max(7).optional(),
  radiates:    z.boolean().optional(),
  radiatesTo:  z.string().trim().max(120).optional(),
}).strict();

const checkInSchema = z.object({
  mood:        z.enum(['TERRIBLE', 'LOW', 'OKAY', 'GOOD', 'GREAT']).optional(),
  sleep:       z.enum(['POOR', 'FAIR', 'GOOD', 'GREAT']).optional(),
  painLevel:   z.number().min(0).max(10).optional(),
  painRegions: z.array(painRegionSchema).max(26).optional(),
  notes:       z.string().trim().max(2000).optional(),
}).strip();

const markMedicationSchema = z.object({
  prescriptionId: z.string().min(1),
  slot:           z.enum(['morning', 'afternoon', 'evening']),
});

const VITAL_TYPES = [
  'BP_SYSTOLIC', 'BP_DIASTOLIC', 'WEIGHT', 'GLUCOSE',
  'SLEEP_HOURS', 'PAIN_SCORE', 'MOOD', 'TEMPERATURE', 'HR',
];
const quickLogVitalSchema = z.object({
  type:  z.enum(VITAL_TYPES),
  value: z.number().finite(),
  unit:  z.string().trim().max(20).optional(),
});

const painPointSchema = z.object({
  region:   z.string().trim().min(1).max(64),
  severity: z.number().min(0).max(10),
});

// Single-call dashboard summary (banner + tasks + meds + vitals + journey + zen + pain + smart messages)
router.get('/summary', EnhancedDashboardController.getSummary);

// Smart messages panel (paginated; future: ?cursor=)
router.get('/smart-messages', EnhancedDashboardController.getSmartMessages);

// Smart insight (recomputed pattern from last 14 check-ins)
router.get('/insight', EnhancedDashboardController.getInsight);

// Last persisted pain regions (used to pre-populate the body-map step of
// the daily check-in so returning patients see their previous selection)
router.get('/last-pain-regions', EnhancedDashboardController.getLastPainRegions);

// Inline actions
router.post('/check-in',                 validate({ body: checkInSchema }),         EnhancedDashboardController.submitCheckIn);
router.post('/medications/mark-taken',   validate({ body: markMedicationSchema }),  EnhancedDashboardController.markMedicationTaken);
router.post('/vitals/quick-log',         validate({ body: quickLogVitalSchema }),   EnhancedDashboardController.quickLogVital);
router.post('/pain/log',                 validate({ body: painPointSchema }),       EnhancedDashboardController.logPainPoint);
router.post('/tasks/:taskId/complete',   EnhancedDashboardController.completePhaseTask);

// Medication lifecycle — supply forecast + one-tap refill request
router.get('/medications/forecast', EnhancedDashboardController.getMedicationForecast);
router.post('/medications/:prescriptionId/request-refill', EnhancedDashboardController.requestMedicationRefill);

export default router;
