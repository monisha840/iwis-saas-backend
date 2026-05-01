/**
 * Home Therapy routes — Task 4 of the Home Therapy feature spec.
 *
 *   GET    /requests?branchId=&status=         (admin / admin-doctor / branch-admin)
 *   GET    /requests/:id                       (above + DOCTOR for own)
 *   POST   /requests/:id/approve               (admin-like)
 *   POST   /requests/:id/reject                (admin-like)
 *   POST   /requests/:id/assign-therapist      (admin-like — alias for approve flow)
 *
 *   GET    /sessions?therapistId=&date=&branchId= (therapist / admin-like)
 *   GET    /sessions/:id                       (therapist / patient own / admin)
 *   POST   /sessions/:id/depart                (therapist)
 *   POST   /sessions/:id/arrive                (therapist)
 *   POST   /sessions/:id/start                 (therapist)
 *   POST   /sessions/:id/complete              (therapist)
 *   GET    /sessions/:id/location              (admin-like / patient own)
 *   POST   /sessions/:id/location-ping         (therapist — rate limited)
 *   GET    /sessions/:id/next                  (therapist — next today)
 */

import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditAction } from '../middleware/auditLog.js';
import HomeTherapyService from '../services/homeTherapy.service.js';

const router = express.Router();
router.use(authMiddleware);

// ─────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────

const HOME_THERAPY_STATUSES = [
  'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED',
];

const listRequestsQuery = z.object({
  branchId: z.string().min(1).optional(),
  status:   z.enum(HOME_THERAPY_STATUSES).optional(),
});

const scheduledSessionRow = z.object({
  sessionNumber: z.coerce.number().int().min(1).max(50),
  date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  time:          z.string().regex(/^\d{2}:\d{2}$/, 'time must be HH:MM'),
});

const approveBody = z.object({
  therapistId:        z.string().min(1),
  scheduledSessions:  z.array(scheduledSessionRow).min(1).max(50),
});

// Edit-flow rows carry a `mode` so the request's sessionMode array can be
// recomposed in lock-step with the count change.
const editScheduledSessionRow = scheduledSessionRow.extend({
  mode: z.enum(['HOME', 'HOSPITAL']),
});

const editBody = z.object({
  therapistId:       z.string().min(1).optional(),
  intervalDays:      z.number().int().min(0).max(60).nullable().optional(),
  notes:             z.string().trim().max(2000).nullable().optional(),
  scheduledSessions: z.array(editScheduledSessionRow).min(1).max(50),
});

const rejectBody = z.object({
  reason: z.string().trim().min(1).max(500),
});

const listSessionsQuery = z.object({
  therapistId: z.string().min(1).optional(),
  date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Date-range form — used by the therapist panel to show today + upcoming.
  // Mutually exclusive with `date` (service ignores `from`/`to` when `date`
  // is set). Either bound is independently optional.
  from:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  branchId:    z.string().min(1).optional(),
});

const locationPingBody = z.object({
  latitude:  z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy:  z.number().nonnegative().optional(),
});

// ─────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────

router.get('/requests',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']),
  validate({ query: listRequestsQuery }),
  async (req, res, next) => {
    try {
      const rows = await HomeTherapyService.listRequests({
        branchId: req.query.branchId || null,
        status:   req.query.status   || null,
        user:     req.user,
      });
      res.json(rows);
    } catch (err) { handle(err, res, next); }
  },
);

router.get('/requests/:id',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR']),
  async (req, res, next) => {
    try {
      const row = await HomeTherapyService.getRequest(req.params.id, req.user);
      res.json(row);
    } catch (err) { handle(err, res, next); }
  },
);

router.post('/requests/:id/approve',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']),
  validate({ body: approveBody }),
  auditAction('APPROVE_HOME_THERAPY_REQUEST', 'HomeTherapyRequest', (req) => req.params.id),
  async (req, res, next) => {
    try {
      const result = await HomeTherapyService.approveRequest(req.params.id, req.user, req.body);
      res.json(result);
    } catch (err) { handle(err, res, next); }
  },
);

// "assign-therapist" is an alias for approve — same payload shape, same flow.
// The spec lists both endpoints; we route them to the same handler.
router.post('/requests/:id/assign-therapist',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']),
  validate({ body: approveBody }),
  auditAction('ASSIGN_HOME_THERAPIST', 'HomeTherapyRequest', (req) => req.params.id),
  async (req, res, next) => {
    try {
      const result = await HomeTherapyService.approveRequest(req.params.id, req.user, req.body);
      res.json(result);
    } catch (err) { handle(err, res, next); }
  },
);

// Admin edit of an APPROVED or IN_PROGRESS request — change therapist,
// reschedule sessions, add or drop sessions. PENDING_APPROVAL requests
// should be edited via the approve flow (which sets up scheduling).
router.patch('/requests/:id',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']),
  validate({ body: editBody }),
  auditAction('EDIT_HOME_THERAPY_REQUEST', 'HomeTherapyRequest', (req) => req.params.id),
  async (req, res, next) => {
    try {
      const result = await HomeTherapyService.editRequest(req.params.id, req.user, req.body);
      res.json(result);
    } catch (err) { handle(err, res, next); }
  },
);

router.post('/requests/:id/reject',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']),
  validate({ body: rejectBody }),
  auditAction('REJECT_HOME_THERAPY_REQUEST', 'HomeTherapyRequest', (req) => req.params.id),
  async (req, res, next) => {
    try {
      const row = await HomeTherapyService.rejectRequest(req.params.id, req.user, req.body);
      res.json(row);
    } catch (err) { handle(err, res, next); }
  },
);

// ─────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────

router.get('/sessions',
  roleMiddleware(['THERAPIST', 'ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']),
  validate({ query: listSessionsQuery }),
  async (req, res, next) => {
    try {
      const rows = await HomeTherapyService.listSessions({
        therapistId: req.query.therapistId || null,
        date:        req.query.date        || null,
        from:        req.query.from        || null,
        to:          req.query.to          || null,
        branchId:    req.query.branchId    || null,
        user:        req.user,
      });
      res.json(rows);
    } catch (err) { handle(err, res, next); }
  },
);

// `next` is more specific than `:id` — register it first so Express doesn't
// shadow it with the param route.
router.get('/sessions/:id/next',
  roleMiddleware(['THERAPIST']),
  async (req, res, next) => {
    try {
      const row = await HomeTherapyService.getNextSession(req.params.id, req.user);
      res.json(row); // can be null when no next session
    } catch (err) { handle(err, res, next); }
  },
);

router.get('/sessions/:id/location',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'PATIENT', 'THERAPIST']),
  async (req, res, next) => {
    try {
      const ping = await HomeTherapyService.getSessionLastLocation(req.params.id, req.user);
      res.json(ping); // null when no pings yet
    } catch (err) { handle(err, res, next); }
  },
);

router.get('/sessions/:id',
  roleMiddleware(['THERAPIST', 'PATIENT', 'ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']),
  async (req, res, next) => {
    try {
      const row = await HomeTherapyService.getSession(req.params.id, req.user);
      res.json(row);
    } catch (err) { handle(err, res, next); }
  },
);

router.post('/sessions/:id/depart',
  roleMiddleware(['THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']),
  auditAction('HOME_THERAPY_DEPART', 'HomeTherapySession', (req) => req.params.id),
  async (req, res, next) => {
    try {
      const row = await HomeTherapyService.transitionSession('depart', req.params.id, req.user);
      res.json(row);
    } catch (err) { handle(err, res, next); }
  },
);

router.post('/sessions/:id/arrive',
  roleMiddleware(['THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']),
  auditAction('HOME_THERAPY_ARRIVE', 'HomeTherapySession', (req) => req.params.id),
  async (req, res, next) => {
    try {
      const row = await HomeTherapyService.transitionSession('arrive', req.params.id, req.user);
      res.json(row);
    } catch (err) { handle(err, res, next); }
  },
);

router.post('/sessions/:id/start',
  roleMiddleware(['THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']),
  auditAction('HOME_THERAPY_START', 'HomeTherapySession', (req) => req.params.id),
  async (req, res, next) => {
    try {
      const row = await HomeTherapyService.transitionSession('start', req.params.id, req.user);
      res.json(row);
    } catch (err) { handle(err, res, next); }
  },
);

router.post('/sessions/:id/complete',
  roleMiddleware(['THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']),
  auditAction('HOME_THERAPY_COMPLETE', 'HomeTherapySession', (req) => req.params.id),
  async (req, res, next) => {
    try {
      const row = await HomeTherapyService.transitionSession('complete', req.params.id, req.user);
      res.json(row);
    } catch (err) { handle(err, res, next); }
  },
);

router.post('/sessions/:id/location-ping',
  roleMiddleware(['THERAPIST']),
  validate({ body: locationPingBody }),
  async (req, res, next) => {
    try {
      const ping = await HomeTherapyService.recordLocationPing(req.params.id, req.user, req.body);
      res.status(201).json(ping);
    } catch (err) { handle(err, res, next); }
  },
);

// ─────────────────────────────────────────────────────────────────────
// Scorecard stats — per-therapist completion + on-time + patient rating
// for the Performance Scorecards page (Task 12).
// ─────────────────────────────────────────────────────────────────────

const scorecardQuery = z.object({
  branchId: z.string().min(1),
  period:   z.enum(['month', 'quarter']).optional(),
});

router.get('/scorecards/branch',
  roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']),
  validate({ query: scorecardQuery }),
  async (req, res, next) => {
    try {
      const out = await HomeTherapyService.getBranchScorecardStats({
        branchId: req.query.branchId,
        period:   req.query.period || 'month',
        user:     req.user,
      });
      res.json(out);
    } catch (err) { handle(err, res, next); }
  },
);

// Unified error → response shaping. Service-thrown errors carry `status`;
// everything else falls through to the global error handler.
function handle(err, res, next) {
  if (err && typeof err.status === 'number') {
    return res.status(err.status).json({ error: err.message });
  }
  next(err);
}

export default router;
