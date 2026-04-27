import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { AuditService } from '../services/audit.service.js';

const router = express.Router();

/**
 * GET /api/audit-logs/recent — recent system-wide events for the admin
 * dashboard activity feed. Hospital-scoped to the caller's hospital so admins
 * never see cross-tenant rows. SUPER_ADMIN is platform-wide.
 *
 * Query: limit (default 20, max 100), entityTypes (CSV)
 */
router.get('/recent', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const entityTypesParam = typeof req.query.entityTypes === 'string' && req.query.entityTypes.trim()
      ? req.query.entityTypes.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const hospitalId = req.user.role === 'SUPER_ADMIN' ? null : (req.user.hospitalId ?? null);
    const data = await AuditService.getRecentActivity({ hospitalId, limit, entityTypes: entityTypesParam });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
