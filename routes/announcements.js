import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { validate } from '../middleware/validate.js';
import { CommunicationController } from '../controllers/communication.controller.js';

const router = express.Router();

// All routes require authentication + feature flag
router.use(authMiddleware);
router.use(requireFeature('ANNOUNCEMENTS'));

// Allowed values mirror those accepted by the service. Keep in sync with
// AnnouncementService.createAnnouncement when fields are added.
const ANNOUNCEMENT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const TARGETABLE_ROLES = [
  'ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN',
  'DOCTOR', 'THERAPIST', 'PHARMACIST', 'PATIENT',
];

// Accept the same DD/MM/YYYY shape the platform's DateInput emits, plus
// YYYY-MM-DD and full ISO. We normalise to ISO before the service writes it
// — Zod's strict `.datetime()` was the reason the form failed with
// "Invalid datetime" when an admin typed a plain date.
const expiresAtSchema = z.string().trim().optional().nullable().transform((val, ctx) => {
  if (val === undefined || val === null || val === '') return null;
  if (val.includes('T')) {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid expiry date' });
      return z.NEVER;
    }
    return d.toISOString();
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(val)) {
    const [dd, mm, yyyy] = val.split('/');
    const d = new Date(`${yyyy}-${mm}-${dd}T23:59:59.000Z`);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid expiry date' });
      return z.NEVER;
    }
    return d.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return new Date(`${val}T23:59:59.000Z`).toISOString();
  }
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use DD/MM/YYYY for expiry date' });
  return z.NEVER;
});

const createAnnouncementSchema = z.object({
  title:       z.string().trim().min(2).max(150),
  message:     z.string().trim().min(2).max(4000),
  priority:    z.enum(ANNOUNCEMENT_PRIORITIES).optional(),
  branchIds:   z.array(z.string().min(1)).max(100).optional(),
  targetRoles: z.array(z.enum(TARGETABLE_ROLES)).max(10).optional(),
  isPinned:    z.boolean().optional(),
  expiresAt:   expiresAtSchema,
});

const updateAnnouncementSchema = createAnnouncementSchema.partial();

// POST / — create announcement (ADMIN, ADMIN_DOCTOR)
router.post(
  '/',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
  validate({ body: createAnnouncementSchema }),
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

// PUT /:id — update announcement.
// Route is open to any authenticated user; the service enforces "author OR
// ADMIN / ADMIN_DOCTOR" so the original creator can edit their own post even
// if their role isn't on the create allowlist.
router.put(
  '/:id',
  validate({ body: updateAnnouncementSchema }),
  CommunicationController.updateAnnouncement,
);

// DELETE /:id — delete announcement.
// Allowed for: original author (any role), ADMIN, ADMIN_DOCTOR. Service
// enforces; route stays open to authenticated users so the 403 message is
// consistent across roles instead of a generic "Forbidden" from the role gate.
router.delete(
  '/:id',
  CommunicationController.deleteAnnouncement,
);

export default router;
