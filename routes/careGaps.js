// Care Gap Dashboard route — exposes the read-only listing the frontend
// CareGapDashboard page consumes. The cron-driven detection / notification
// flow lives in services/careGap.service.js (CareGapService.detectAndNotify);
// this endpoint is a parallel read path for an at-a-glance ops view.

import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { CareGapService } from '../services/careGap.service.js';

const router = express.Router();

const listSchema = z.object({
  branchId: z.string().optional(),
  gapType: z.enum([
    'NO_RECENT_VISIT',
    'INCOMPLETE_TRIAGE',
    'LOW_ADHERENCE',
    'WELLNESS_DECLINE',
    'OVERDUE_PHASE',
  ]).optional(),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// GET /api/care-gaps
router.get(
  '/',
  authMiddleware,
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
  validate({ query: listSchema }),
  async (req, res, next) => {
    try {
      // ADMIN may pass any branchId; ADMIN_DOCTOR is hospital-scoped (no
      // branch pin in the JWT). If the caller didn't pass branchId, we run
      // unscoped across all branches the role can see.
      const branchId = req.query.branchId || null;
      const data = await CareGapService.listGaps({
        branchId,
        gapType: req.query.gapType || null,
        severity: req.query.severity || null,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.json({ data });
    } catch (err) { next(err); }
  },
);

export default router;
