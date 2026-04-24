import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { CommunicationController } from '../controllers/communication.controller.js';

const router = express.Router();

// All routes require authentication + feature flag
router.use(authMiddleware);
router.use(requireFeature('ANNOUNCEMENTS'));

// POST / — create announcement (ADMIN, ADMIN_DOCTOR)
router.post(
  '/',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
  CommunicationController.createAnnouncement,
);

// GET / — list announcements for current user (all authenticated)
router.get(
  '/',
  CommunicationController.getAnnouncements,
);

// PATCH /:id/read — mark announcement as read (all authenticated)
router.patch(
  '/:id/read',
  CommunicationController.markAnnouncementRead,
);

// PUT /:id — update announcement (ADMIN, ADMIN_DOCTOR)
router.put(
  '/:id',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
  CommunicationController.updateAnnouncement,
);

// DELETE /:id — delete announcement (ADMIN, ADMIN_DOCTOR)
router.delete(
  '/:id',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
  CommunicationController.deleteAnnouncement,
);

export default router;
