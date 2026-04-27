import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { PortalController } from '../controllers/portal.controller.js';

const router = express.Router();

const clinicianRoles = ['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR'];

// All routes require authentication + feature flag
router.use(authMiddleware);
router.use(requireFeature('VISIT_SUMMARY'));

// POST / — create visit summary (appointmentId in body)
router.post(
  '/',
  roleMiddleware(clinicianRoles),
  PortalController.createVisitSummary,
);

// GET /appointment/:appointmentId — get visit summary by appointment
router.get(
  '/appointment/:appointmentId',
  roleMiddleware([...clinicianRoles, 'PATIENT']),
  PortalController.getVisitSummary,
);

// GET /mine — visit summaries authored by the calling clinician.
// Used by the doctor-side Visit Summary page; previously the page
// (mis)used the patient endpoint with the doctor's userId, returning empty.
router.get(
  '/mine',
  roleMiddleware(clinicianRoles),
  PortalController.getMyVisitSummaries,
);

// GET /me — visit summaries belonging to the calling patient. Resolves
// User.id → Patient.id internally so the patient view doesn't need to
// know its own Patient record id.
router.get(
  '/me',
  roleMiddleware(['PATIENT']),
  async (req, res, next) => {
    try {
      const { default: prisma } = await import('../lib/prisma.js');
      const me = await prisma.patient.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
      });
      if (!me) {
        return res.json({
          summaries: [], data: [],
          pagination: { page: 1, limit: 0, total: 0, totalPages: 0 },
        });
      }
      const { VisitSummaryService } = await import('../services/visitSummary.service.js');
      const result = await VisitSummaryService.getPatientVisitSummaries(me.id, req.query);
      res.json(result);
    } catch (err) { next(err); }
  },
);

// GET /patient/:patientId — patient visit summary history
router.get(
  '/patient/:patientId',
  roleMiddleware([...clinicianRoles, 'ADMIN']),
  PortalController.getPatientVisitSummaries,
);

// POST /:id/send — send visit summary to patient
router.post(
  '/:id/send',
  roleMiddleware(clinicianRoles),
  PortalController.sendToPatient,
);

// GET /auto-generate/:appointmentId — auto-generate draft from appointment data
router.get(
  '/auto-generate/:appointmentId',
  roleMiddleware(clinicianRoles),
  PortalController.autoGenerate,
);

// ── Spec-shape aliases (registered LAST so they don't shadow named
// routes above). Both forward to the existing handlers. ──────────────────
const RESERVED_PATHS = new Set(['mine', 'me', 'auto-generate', 'appointment', 'patient']);

// GET /:appointmentId — alias of /appointment/:appointmentId.
router.get(
  '/:appointmentId',
  roleMiddleware([...clinicianRoles, 'PATIENT']),
  (req, res, next) => {
    if (RESERVED_PATHS.has(req.params.appointmentId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    return PortalController.getVisitSummary(req, res, next);
  },
);

// POST /:appointmentId — accepts appointmentId in the URL instead of the body.
router.post(
  '/:appointmentId',
  roleMiddleware(clinicianRoles),
  (req, res, next) => {
    if (RESERVED_PATHS.has(req.params.appointmentId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    req.body = { ...req.body, appointmentId: req.params.appointmentId };
    return PortalController.createVisitSummary(req, res, next);
  },
);

export default router;
