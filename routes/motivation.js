// Monday Motivation Card routes.
//
// Mounted at /api/motivation. Patient-only endpoints for fetching this
// week's tip, marking it read (+5 Zen Points), and saving / un-saving for
// the "My Tips" tab. Card generation is owned exclusively by the Monday
// 10:00 cron — there is no manual trigger endpoint.
//
// Auth shape used:
//   • req.user.id   — User.id (we resolve Patient.id internally so the
//                     caller can never forge it via body/query).
//   • req.user.role — UserRole

import express from 'express';
import prisma from '../lib/prisma.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { MotivationService } from '../services/motivation.service.js';

const router = express.Router();

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

// GET /api/motivation/today
// Returns today's motivation card, lazily creating it if the cron hasn't
// run yet (e.g. patient onboarded mid-day, or dev environment without
// scheduled jobs running).
router.get('/today', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const card = await MotivationService.getTodayCard(patientId);
    res.json({ card });
  } catch (err) { next(err); }
});

// POST /api/motivation/:id/read
// Marks the card as read and awards +5 Zen Points the first time only.
// Subsequent reads of the same card return awarded: null.
router.post('/:id/read', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const { card, awarded } = await MotivationService.markRead(patientId, req.params.id);
    res.json({
      card,
      zenPointsAwarded: awarded?.points ?? 0,
      newTotal: awarded?.total ?? null,
    });
  } catch (err) {
    if (err.message === 'Motivation card not found') {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

// POST /api/motivation/:id/save
// Toggle the saved flag. No Zen Points — saving is a low-friction action.
router.post('/:id/save', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const card = await MotivationService.toggleSave(patientId, req.params.id);
    res.json({ card });
  } catch (err) {
    if (err.message === 'Motivation card not found') {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

// GET /api/motivation/saved
// Saved tips for the My Tips tab — newest savedAt first.
router.get('/saved', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
  try {
    const patientId = await resolvePatientId(req, res);
    if (!patientId) return;

    const cards = await MotivationService.getSavedTips(patientId);
    res.json({ cards });
  } catch (err) { next(err); }
});

export default router;
