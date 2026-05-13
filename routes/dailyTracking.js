// Sheizen-inspired Daily Tracking routes.
//
// Mounted at /api/daily-tracking. Patient-only logging endpoints + a
// summary endpoint for the doctor's PatientTimeline view.
//
// Each tracking surface (water / measurements / activity / meal photos)
// has its own minimal log table so per-feature retention and aggregation
// stay decoupled. Zen Points are awarded via the canonical
// ZenPointsService.awardPoints, which itself rate-limits via the new
// PATIENT_RATE_LIMITS entries (WATER_LOGGED, ACTIVITY_LOGGED,
// MEASUREMENTS_LOGGED, MEAL_PHOTO_LOGGED).
//
// Auth shape used:
//   • req.user.id   — User.id
//   • req.user.role — UserRole
// We resolve Patient.id from User.id inside each handler so a malicious
// caller can't forge it via query/body.

import express from 'express';
import path from 'path';
import fs from 'fs';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { getUploadMiddleware, uploadToSupabase, BUCKETS } from '../middleware/upload.js';
import { ZenPointsService } from '../services/zenPoints.service.js';

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────
function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysAgo(n) {
  const x = startOfDay();
  x.setDate(x.getDate() - n);
  return x;
}

async function resolvePatientId(req, res) {
  const patient = await prisma.patient.findUnique({
    where: { userId: req.user.id },
    select: { id: true },
  });
  if (!patient) {
    res.status(404).json({ error: 'Patient profile not found' });
    return null;
  }
  return patient.id;
}

// Best-effort Zen Points award. Failure to award (DB hiccup, rate limit)
// must NOT roll back the underlying log — the ledger is a side-channel.
async function safeAwardPoints(patientId, action, sourceId) {
  try {
    return await ZenPointsService.awardPoints(patientId, action, sourceId);
  } catch (err) {
    logger.warn(`[daily-tracking] award ${action} failed`, { err: err.message, patientId });
    return null;
  }
}

const WATER_GOAL_ML = 2500;

// ─────────────────────────────────────────────────────────────────────────
// Water Intake
// ─────────────────────────────────────────────────────────────────────────

// POST /api/daily-tracking/water
// Body: { amount: number (ml) }
router.post('/water', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 5000) {
      return res.status(400).json({ error: 'amount must be a positive number of millilitres (≤5000 per entry)' });
    }

    const today = startOfDay();
    const log = await prisma.waterIntakeLog.create({
      data: {
        patientId,
        amount: Math.round(amount),
        loggedAt: new Date(),
        date: today,
      },
    });

    // Today's total after this entry
    const logs = await prisma.waterIntakeLog.findMany({
      where: { patientId, date: today },
      orderBy: { loggedAt: 'asc' },
    });
    const todayTotal = logs.reduce((sum, l) => sum + l.amount, 0);

    // Award once per day on the first entry. The ZenPointsService is itself
    // rate-limited via PATIENT_RATE_LIMITS.WATER_LOGGED so duplicate awards
    // are impossible even if this branch were wrong.
    let zenPointsAwarded = 0;
    if (logs.length === 1) {
      const result = await safeAwardPoints(patientId, 'WATER_LOGGED', log.id);
      if (result?.points) zenPointsAwarded = result.points;
    }

    res.json({
      log,
      todayTotal,
      goalMl: WATER_GOAL_ML,
      percentage: Math.min(100, Math.round((todayTotal / WATER_GOAL_ML) * 100)),
      zenPointsAwarded,
    });
  } catch (err) { next(err); }
});

// GET /api/daily-tracking/water/today
router.get('/water/today', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const today = startOfDay();
    const logs = await prisma.waterIntakeLog.findMany({
      where: { patientId, date: today },
      orderBy: { loggedAt: 'asc' },
    });
    const todayTotal = logs.reduce((sum, l) => sum + l.amount, 0);

    res.json({
      logs,
      todayTotal,
      goalMl: WATER_GOAL_ML,
      percentage: Math.min(100, Math.round((todayTotal / WATER_GOAL_ML) * 100)),
    });
  } catch (err) { next(err); }
});

// GET /api/daily-tracking/water/history — last 7 days
router.get('/water/history', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const since = daysAgo(7);
    const logs = await prisma.waterIntakeLog.findMany({
      where: { patientId, date: { gte: since } },
      orderBy: { loggedAt: 'desc' },
    });
    res.json({ logs });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// Body Measurements
// ─────────────────────────────────────────────────────────────────────────

const MEASUREMENT_FIELDS = ['arm', 'chest', 'waist', 'hip', 'thigh', 'weight'];

router.post('/measurements', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const data = {};
    let any = false;
    for (const f of MEASUREMENT_FIELDS) {
      const v = req.body?.[f];
      if (v === undefined || v === null || v === '') {
        data[f] = null;
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 500) {
        return res.status(400).json({ error: `${f} must be a positive number under 500` });
      }
      data[f] = n;
      any = true;
    }
    if (!any) {
      return res.status(400).json({ error: 'At least one measurement is required' });
    }

    const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 500) : null;

    const log = await prisma.bodyMeasurementLog.create({
      data: { patientId, ...data, notes, loggedAt: new Date() },
    });

    let zenPointsAwarded = 0;
    const result = await safeAwardPoints(patientId, 'MEASUREMENTS_LOGGED', log.id);
    if (result?.points) zenPointsAwarded = result.points;

    res.json({ log, zenPointsAwarded });
  } catch (err) { next(err); }
});

// GET /api/daily-tracking/measurements/history — last 10 entries
router.get('/measurements/history', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const logs = await prisma.bodyMeasurementLog.findMany({
      where: { patientId },
      orderBy: { loggedAt: 'desc' },
      take: 10,
    });
    res.json({ logs });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// Activity Log
// ─────────────────────────────────────────────────────────────────────────

const ACTIVITY_TYPES = new Set([
  'YOGA', 'AEROBIC', 'STRENGTH', 'FLEXIBILITY', 'MEDITATION', 'WALKING', 'PRANAYAMA', 'OTHER',
]);

router.post('/activity', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const { activityType, durationMins, notes } = req.body || {};
    if (!ACTIVITY_TYPES.has(activityType)) {
      return res.status(400).json({ error: 'activityType is required and must be a valid type' });
    }
    const duration = Number(durationMins);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600) {
      return res.status(400).json({ error: 'durationMins must be a positive number under 600' });
    }

    const today = startOfDay();
    const log = await prisma.activityLog.create({
      data: {
        patientId,
        activityType,
        durationMins: Math.round(duration),
        notes: typeof notes === 'string' ? notes.slice(0, 500) : null,
        loggedAt: new Date(),
        date: today,
        zenPointsAwarded: 0, // stamped after the award call
      },
    });

    let zenPointsAwarded = 0;
    const result = await safeAwardPoints(patientId, 'ACTIVITY_LOGGED', log.id);
    if (result?.points) {
      zenPointsAwarded = result.points;
      await prisma.activityLog.update({
        where: { id: log.id },
        data: { zenPointsAwarded },
      });
    }

    res.json({ log: { ...log, zenPointsAwarded }, zenPointsAwarded });
  } catch (err) { next(err); }
});

// GET /api/daily-tracking/activity/today
router.get('/activity/today', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const today = startOfDay();
    const logs = await prisma.activityLog.findMany({
      where: { patientId, date: today },
      orderBy: { loggedAt: 'desc' },
    });
    const totalMinutes = logs.reduce((sum, l) => sum + l.durationMins, 0);
    res.json({ logs, totalMinutes });
  } catch (err) { next(err); }
});

// GET /api/daily-tracking/activity/history — last 7 days
router.get('/activity/history', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const since = daysAgo(7);
    const logs = await prisma.activityLog.findMany({
      where: { patientId, date: { gte: since } },
      orderBy: { loggedAt: 'desc' },
    });
    res.json({ logs });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// Meal Photos
// ─────────────────────────────────────────────────────────────────────────

const MEAL_TYPES = new Set(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK', 'MORNING_EMPTY']);

const photoUpload = getUploadMiddleware({ maxSizeMb: 10, fieldName: 'photo' });

router.post(
  '/meal-photo',
  authMiddleware,
  roleMiddleware(['PATIENT']),
  photoUpload,
  async (req, res, next) => {
    try {
      const patientId = await resolvePatientId(req, res);
      if (!patientId) return;

      if (!req.file) return res.status(400).json({ error: 'photo is required' });
      if (!MEAL_TYPES.has(req.body?.mealType)) {
        return res.status(400).json({ error: 'mealType is required and must be a valid type' });
      }

      // Either Supabase-hosted URL or local /uploads/* path; matches the
      // pattern used by clinicalPhoto.js + self-exam.js.
      const photoUrl = await uploadToSupabase(req.file, BUCKETS.JOURNEY_MEDIA);
      const photoPath = req.file.path || photoUrl;

      const today = startOfDay();
      const log = await prisma.mealPhotoLog.create({
        data: {
          patientId,
          mealType: req.body.mealType,
          photoPath,
          photoUrl,
          notes: typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 500) : null,
          loggedAt: new Date(),
          date: today,
        },
      });

      let zenPointsAwarded = 0;
      const result = await safeAwardPoints(patientId, 'MEAL_PHOTO_LOGGED', log.id);
      if (result?.points) zenPointsAwarded = result.points;

      res.json({ log, zenPointsAwarded });
    } catch (err) { next(err); }
  },
);

// GET /api/daily-tracking/meal-photos/today
router.get('/meal-photos/today', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const today = startOfDay();
    const logs = await prisma.mealPhotoLog.findMany({
      where: { patientId, date: today },
      orderBy: { loggedAt: 'asc' },
    });
    res.json({ logs });
  } catch (err) { next(err); }
});

// GET /api/daily-tracking/meal-photos/history — last 7 days
router.get('/meal-photos/history', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const since = daysAgo(7);
    const logs = await prisma.mealPhotoLog.findMany({
      where: { patientId, date: { gte: since } },
      orderBy: { loggedAt: 'desc' },
    });
    res.json({ logs });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// Full-day bonus
// Awards +15 Zen Points once per day when the patient submits a check-in
// AND logs water + activity + a meal photo on the same calendar day. The
// underlying records are re-verified server-side before the award call so
// a stale client can't claim the bonus without doing the work.
// Rate limit (1/day) is enforced through ZenPointsService → AntiGamingService
// PATIENT_RATE_LIMITS.FULL_DAY_COMPLETE.
// ─────────────────────────────────────────────────────────────────────────

router.post('/full-day-bonus', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: 'Patient profile not found' });

    const today = startOfDay();
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

    // DailyCheckIn has no `date` column — use createdAt within today's window.
    // The other three logs use the date-only column so we filter on `date: today`.
    const [checkin, water, activity, mealPhoto] = await Promise.all([
      prisma.dailyCheckIn.findFirst({
        where: { patientId: patient.id, createdAt: { gte: today, lt: tomorrow } },
        select: { id: true },
      }),
      prisma.waterIntakeLog.findFirst({
        where: { patientId: patient.id, date: today },
        select: { id: true },
      }),
      prisma.activityLog.findFirst({
        where: { patientId: patient.id, date: today },
        select: { id: true },
      }),
      prisma.mealPhotoLog.findFirst({
        where: { patientId: patient.id, date: today },
        select: { id: true },
      }),
    ]);

    if (!checkin || !water || !activity || !mealPhoto) {
      return res.status(400).json({
        error: 'Not all 4 activities completed today',
        progress: {
          checkin: !!checkin,
          water:   !!water,
          activity: !!activity,
          mealPhoto: !!mealPhoto,
        },
      });
    }

    const sourceId = `full-day-${today.toISOString().split('T')[0]}`;
    const result = await safeAwardPoints(patient.id, 'FULL_DAY_COMPLETE', sourceId);
    res.json({
      success: true,
      pointsAwarded: result?.points ?? 0,
      total: result?.total ?? null,
      // result is null when the rate limiter rejects (already claimed today).
      alreadyClaimed: result === null,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// Doctor view: 7-day summary for a specific patient
// ─────────────────────────────────────────────────────────────────────────

router.get(
  '/patient/:patientId/summary',
  authMiddleware,
  roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'ADMIN', 'THERAPIST']),
  async (req, res, next) => {
    try {
      const { patientId } = req.params;
      // Confirm the patient exists so the response is empty-arrays vs 404.
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) return res.status(404).json({ error: 'Patient not found' });

      const since = daysAgo(7);
      const [waterLogs, activityLogs, measurementLogs, mealPhotos] = await Promise.all([
        prisma.waterIntakeLog.findMany({
          where: { patientId, date: { gte: since } },
          orderBy: { loggedAt: 'desc' },
        }),
        prisma.activityLog.findMany({
          where: { patientId, date: { gte: since } },
          orderBy: { loggedAt: 'desc' },
        }),
        prisma.bodyMeasurementLog.findMany({
          where: { patientId },
          orderBy: { loggedAt: 'desc' },
          take: 5,
        }),
        prisma.mealPhotoLog.findMany({
          where: { patientId, date: { gte: since } },
          orderBy: { loggedAt: 'desc' },
        }),
      ]);

      res.json({ waterLogs, activityLogs, measurementLogs, mealPhotos, goalMl: WATER_GOAL_ML });
    } catch (err) { next(err); }
  },
);

// Ensure local fallback directory exists. When Supabase is configured the
// upload middleware uses memory storage and doesn't touch disk, but the
// disk fallback path would otherwise 500 on a fresh deployment.
try {
  fs.mkdirSync(path.resolve(process.cwd(), 'uploads', 'meal-photos'), { recursive: true });
} catch (err) {
  logger.warn('[daily-tracking] could not ensure uploads/meal-photos dir', { err: err.message });
}

export default router;
