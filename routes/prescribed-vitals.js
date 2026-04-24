/**
 * Prescribed Vitals routes.
 *
 * Mounted at /api/patients/:patientId/prescribed-vitals
 * - GET (DOCTOR / ADMIN_DOCTOR / ADMIN / PATIENT-self) — list active prescriptions
 * - POST (DOCTOR / ADMIN_DOCTOR / ADMIN) — prescribe / re-activate a vital
 * - DELETE :id (DOCTOR / ADMIN_DOCTOR / ADMIN) — soft-deactivate
 */

import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import { PrescribedVitalService } from '../services/prescribedVital.service.js';

const router = express.Router({ mergeParams: true });

router.use(authMiddleware);

// PATIENT can only read their own list; clinicians can read any.
async function authorizeRead(req, res, next) {
  try {
    const role = req.user.role;
    if (['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST'].includes(role)) return next();
    if (role === 'PATIENT') {
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.patientId },
        select: { userId: true },
      });
      if (patient?.userId === req.user.id) return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  } catch (err) { next(err); }
}

router.get('/', authorizeRead, async (req, res, next) => {
  try {
    const data = await PrescribedVitalService.list(req.params.patientId);
    res.json({ data });
  } catch (err) { next(err); }
});

router.post('/', roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']), async (req, res, next) => {
  try {
    const created = await PrescribedVitalService.create(req.params.patientId, req.user.id, req.body || {});
    res.status(201).json(created);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/:id', roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']), async (req, res, next) => {
  try {
    const result = await PrescribedVitalService.remove(req.params.patientId, req.params.id);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

export default router;
