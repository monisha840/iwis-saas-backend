import express from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authMiddleware, roleMiddleware, resolvePatientId } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditAction } from '../middleware/auditLog.js';
import { requireFeature } from '../utils/featureGate.js';
import { FeedbackService } from '../services/feedback.service.js';
import { ConsultationFeedbackService } from '../services/consultationFeedback.service.js';
import { JourneyFeedbackService } from '../services/journeyFeedback.service.js';
import { awardConsultationXp, awardJourneyXp } from '../services/feedbackXp.service.js';
import HomeTherapyService from '../services/homeTherapy.service.js';

const router = express.Router();

// Convert a 1-5 star rating into a sentiment bucket. Mirrors the spec:
//   ≥ 4 → POSITIVE, == 3 → NEUTRAL, ≤ 2 → NEGATIVE.
function ratingToSentiment(rating) {
    if (rating >= 4) return 'POSITIVE';
    if (rating === 3) return 'NEUTRAL';
    return 'NEGATIVE';
}

const submitSchema = z.object({
    rating:  z.number().int().min(1).max(5),
    comment: z.string().max(1000).optional(),
});

// 4-question post-consultation flow. Each field is individually nullable —
// the client submits whatever the patient didn't skip. XP is computed
// server-side from the response values; the client does not send it.
const consultationFeedbackSchema = z.object({
    appointment_id:          z.string().min(1),
    face_scale_emotional:    z.number().int().min(1).max(5).nullable().optional(),
    face_scale_confidence:   z.number().int().min(1).max(5).nullable().optional(),
    mcq_listening:           z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    mcq_return:              z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
});

// POST /api/feedback/:appointmentId — patient submits a star rating
router.post(
    '/:appointmentId',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    validate({ body: submitSchema }),
    async (req, res, next) => {
        try {
            const feedback = await FeedbackService.submitFeedback(
                req.user.id,
                req.params.appointmentId,
                req.body,
            );
            res.status(201).json({ success: true, data: feedback });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/:appointmentId — clinician or patient retrieves feedback
router.get(
    '/:appointmentId',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT']),
    async (req, res, next) => {
        try {
            const data = await FeedbackService.getFeedbackForAppointment(req.params.appointmentId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/stats/doctor/:doctorId — admin views doctor's aggregate rating
router.get(
    '/stats/doctor/:doctorId',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            const data = await FeedbackService.getDoctorFeedbackStats(req.params.doctorId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/stats/therapist/:therapistId — admin views therapist's aggregate rating
router.get(
    '/stats/therapist/:therapistId',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            const data = await FeedbackService.getTherapistFeedbackStats(req.params.therapistId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// ── Post-consultation 4-question flow ───────────────────────────────────────

// GET /api/feedback/consultation/pending — patient dashboard checks on app open
router.get(
    '/consultation/pending',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    async (req, res, next) => {
        try {
            const pending = await ConsultationFeedbackService.getPending(req.user.id);
            res.json({ success: true, data: pending });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/consultation/stats/doctor/:doctorId — admin aggregation
router.get(
    '/consultation/stats/doctor/:doctorId',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            const data = await ConsultationFeedbackService.getDoctorAggregate(
                req.params.doctorId,
                { since: req.query.since },
            );
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// POST /api/feedback/consultation — submit the 4 answers (any subset)
router.post(
    '/consultation',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    validate({ body: consultationFeedbackSchema }),
    async (req, res, next) => {
        try {
            const { appointment_id, ...responses } = req.body;
            const result = await ConsultationFeedbackService.submit(
                req.user.id,
                appointment_id,
                responses,
            );
            res.status(201).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    },
);

// ── Journey-completion 7-stage feedback flow ───────────────────────────────
//
// Triggered when a TreatmentJourney status flips to COMPLETED. The patient
// sees a full-screen takeover the next time they open the app. Single
// submission only — XP up to 7 is computed server-side and credited to the
// lead doctor (with proportional split to qualifying co-treaters).

const journeyFeedbackSchema = z.object({
    journey_id:                  z.string().min(1),
    mcq_appointments:            z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    mcq_reminders:               z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    mcq_medications:             z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    mcq_family_recommendation:   z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    garden_score:                z.number().int().refine((v) => [1, 3, 5, 7, 10].includes(v), {
        message: 'garden_score must be one of 1, 3, 5, 7, 10',
    }).nullable().optional(),
    face_scale_experience:       z.number().int().min(1).max(5).nullable().optional(),
    thank_you_card_text:         z.string().max(2000).nullable().optional(),
    thank_you_card_public:       z.boolean().optional(),
    photos_viewed:               z.boolean().optional(),
});

// GET /api/feedback/journey/available — patient dashboard checks on app open
router.get(
    '/journey/available',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    requireFeature('JOURNEY_FEEDBACK'),
    async (req, res, next) => {
        try {
            const data = await JourneyFeedbackService.getAvailableForUser(req.user.id);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/journey/:journeyId/photos — before/after pair (Stage 2)
router.get(
    '/journey/:journeyId/photos',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    requireFeature('JOURNEY_FEEDBACK'),
    async (req, res, next) => {
        try {
            const data = await JourneyFeedbackService.getPhotosForJourney(req.params.journeyId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// POST /api/feedback/journey — submit the 7-stage flow
router.post(
    '/journey',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    requireFeature('JOURNEY_FEEDBACK'),
    validate({ body: journeyFeedbackSchema }),
    auditAction('JOURNEY_FEEDBACK_SUBMITTED', 'JourneyFeedback', (req) => req.body.journey_id),
    async (req, res, next) => {
        try {
            const { journey_id, ...responses } = req.body;
            const result = await JourneyFeedbackService.submit(
                req.user.id,
                journey_id,
                responses,
            );
            res.status(201).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/journey/recognition — doctor's "This Week's Recognition"
// public-card panel. Last 7 days of PUBLIC thank-you cards by default.
router.get(
    '/journey/recognition',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    requireFeature('JOURNEY_FEEDBACK'),
    async (req, res, next) => {
        try {
            const sinceDays = Math.min(parseInt(req.query.sinceDays, 10) || 7, 90);
            const data = await JourneyFeedbackService.getRecognitionForDoctor(req.user.id, { sinceDays });
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/journey/letters — doctor's full letter inbox (public + private)
router.get(
    '/journey/letters',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST']),
    requireFeature('JOURNEY_FEEDBACK'),
    async (req, res, next) => {
        try {
            const take = Math.min(parseInt(req.query.take, 10) || 20, 100);
            const data = await JourneyFeedbackService.getPrivateCardsForDoctor(req.user.id, { take });
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    },
);

// ─── New rating-based feedback flow (2026-04-28) ──────────────────────────────
// Lives at /rating sub-paths to avoid collision with the legacy MCQ flow at
// the bare /consultation and /journey paths above. Both flows write to the
// same ConsultationFeedback / JourneyFeedback tables (one row per appointment
// or journey, enforced by UNIQUE on appointmentId / journeyId).

const ratingFeedbackSchema = z.object({
    appointmentId: z.string().min(1),
    rating:        z.number().int().min(1).max(5),
    categories:    z.array(z.string().min(1).max(64)).max(20).default([]),
    feedbackText:  z.string().max(1000).nullable().optional(),
});

// POST /api/feedback/consultation/rating — patient submits the rating-flow
// feedback. Awards 75 XP to the clinician on POSITIVE sentiment via
// feedbackXp.service.js.
router.post(
    '/consultation/rating',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    resolvePatientId,
    validate({ body: ratingFeedbackSchema }),
    async (req, res, next) => {
        try {
            const { appointmentId, rating, categories, feedbackText } = req.body;
            const appointment = await prisma.appointment.findUnique({
                where: { id: appointmentId },
                select: {
                    id: true, patientId: true, branchId: true,
                    doctorId: true,
                    doctor:    { select: { userId: true } },
                    therapistId: true,
                    therapist: { select: { userId: true } },
                    consultationFeedback: { select: { id: true } },
                },
            });
            if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
            if (appointment.patientId !== req.user.patientId) {
                return res.status(403).json({ error: 'Forbidden: not your appointment' });
            }
            if (appointment.consultationFeedback) {
                return res.status(409).json({ error: 'Feedback already submitted for this appointment' });
            }

            // Resolve clinician for the new role-agnostic columns.
            const clinicianUserId = appointment.doctor?.userId || appointment.therapist?.userId || null;
            const clinicianRole   = appointment.doctor ? 'DOCTOR' : appointment.therapist ? 'THERAPIST' : null;
            if (!clinicianUserId) {
                return res.status(400).json({ error: 'Appointment has no associated clinician' });
            }

            const sentiment = ratingToSentiment(rating);
            const feedback = await prisma.consultationFeedback.create({
                data: {
                    appointmentId,
                    patientId:     req.user.patientId,
                    doctorId:      appointment.doctorId,
                    clinicianId:   clinicianUserId,
                    clinicianRole,
                    branchId:      appointment.branchId,
                    rating,
                    sentiment,
                    categories,
                    feedbackText:  feedbackText || null,
                    completedAt:   new Date(),
                },
            });

            // Award XP outside the request response — non-blocking. Service
            // is a silent no-op for non-POSITIVE sentiment.
            try {
                await awardConsultationXp(feedback);
            } catch (err) {
                // XP failure must not invalidate the patient's submission.
                req.log?.warn?.('[feedback] awardConsultationXp failed', { err: err.message });
            }

            res.status(201).json({ success: true, data: feedback });
        } catch (err) {
            next(err);
        }
    },
);

const journeyRatingSchema = z.object({
    journeyId:       z.string().min(1),
    overallRating:   z.number().int().min(1).max(5),
    outcomeRating:   z.number().int().min(1).max(5),
    adherenceRating: z.number().int().min(1).max(5),
    highlights:      z.array(z.string().min(1).max(64)).max(20).default([]),
    feedbackText:    z.string().max(2000).nullable().optional(),
    wouldRecommend:  z.boolean().nullable().optional(),
});

// POST /api/feedback/journey/rating — patient submits journey rating feedback.
// Awards 150 XP to primary clinician on POSITIVE sentiment.
router.post(
    '/journey/rating',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    resolvePatientId,
    validate({ body: journeyRatingSchema }),
    async (req, res, next) => {
        try {
            const { journeyId, overallRating, outcomeRating, adherenceRating,
                    highlights, feedbackText, wouldRecommend } = req.body;

            const journey = await prisma.treatmentJourney.findUnique({
                where: { id: journeyId },
                select: {
                    id: true, patientId: true, doctorId: true, branchId: true,
                    feedback: { select: { id: true, completedAt: true } },
                },
            });
            if (!journey) return res.status(404).json({ error: 'Journey not found' });
            // TreatmentJourney.patientId points at User.id, not Patient.id.
            if (journey.patientId !== req.user.id) {
                return res.status(403).json({ error: 'Forbidden: not your journey' });
            }

            // The legacy JourneyFeedback row is created at journey-completion time
            // with completedAt = null. Treat completedAt as the "submitted" marker.
            if (journey.feedback?.completedAt) {
                return res.status(409).json({ error: 'Feedback already submitted for this journey' });
            }

            const sentiment = ratingToSentiment(overallRating);
            const completedAt = new Date();
            // 30-day visibility window mirrors the legacy MCQ flow's expiresAt.
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

            const feedback = await prisma.journeyFeedback.upsert({
                where: { journeyId },
                update: {
                    overallRating, outcomeRating, adherenceRating,
                    sentiment, highlights,
                    feedbackText: feedbackText || null,
                    wouldRecommend: wouldRecommend ?? null,
                    completedAt,
                },
                create: {
                    journeyId,
                    patientId:           journey.patientId,
                    leadDoctorId:        journey.doctorId,
                    primaryClinicianId:  journey.doctorId,
                    branchId:            journey.branchId,
                    overallRating, outcomeRating, adherenceRating,
                    sentiment, highlights,
                    feedbackText: feedbackText || null,
                    wouldRecommend: wouldRecommend ?? null,
                    expiresAt,
                    completedAt,
                },
            });

            try {
                await awardJourneyXp(feedback);
            } catch (err) {
                req.log?.warn?.('[feedback] awardJourneyXp failed', { err: err.message });
            }

            res.status(201).json({ success: true, data: feedback });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/clinician — paginated list of consultation + journey
// feedback addressed to the calling clinician. NEGATIVE / NEUTRAL rows are
// anonymised: patientId is replaced with null before responding.
const clinicianListQuerySchema = z.object({
    type:   z.enum(['consultation', 'journey']).optional(),
    rating: z.string().optional().transform((v) => v ? parseInt(v, 10) : undefined),
    from:   z.string().optional(),
    to:     z.string().optional(),
    page:   z.string().optional().transform((v) => v ? parseInt(v, 10) : 1),
    limit:  z.string().optional().transform((v) => v ? parseInt(v, 10) : 10),
});

router.get(
    '/clinician',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR']),
    validate({ query: clinicianListQuerySchema }),
    async (req, res, next) => {
        try {
            const { type, rating, from, to } = req.query;
            const page  = Math.max(1, req.query.page  || 1);
            const limit = Math.min(100, Math.max(1, req.query.limit || 10));

            const dateFilter = {};
            if (from) dateFilter.gte = new Date(from);
            if (to)   dateFilter.lte = new Date(to);

            const consultationWhere = {
                clinicianId: req.user.id,
                rating:      { not: null },
                ...(rating ? { rating } : {}),
                ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
            };
            const journeyWhere = {
                primaryClinicianId: req.user.id,
                overallRating:      { not: null },
                ...(rating ? { overallRating: rating } : {}),
                ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
            };

            const wantConsultation = !type || type === 'consultation';
            const wantJourney      = !type || type === 'journey';

            const [consultations, journeys] = await Promise.all([
                wantConsultation
                    ? prisma.consultationFeedback.findMany({
                        where: consultationWhere,
                        include: { patient: { select: { id: true, fullName: true } } },
                        orderBy: { createdAt: 'desc' },
                    })
                    : [],
                wantJourney
                    ? prisma.journeyFeedback.findMany({
                        where: journeyWhere,
                        include: { patient: { select: { id: true } } },
                        orderBy: { createdAt: 'desc' },
                    })
                    : [],
            ]);

            // Merge and anonymise non-positive entries before paginating.
            const merged = [
                ...consultations.map((c) => ({
                    kind:        'consultation',
                    id:          c.id,
                    rating:      c.rating,
                    sentiment:   c.sentiment,
                    categories:  c.categories || [],
                    feedbackText: c.feedbackText,
                    createdAt:   c.createdAt,
                    patientId:   c.sentiment === 'POSITIVE' ? c.patientId : null,
                    patientName: c.sentiment === 'POSITIVE'
                        ? (c.patient?.fullName?.split(' ')[0] || 'Anonymous')
                        : 'Anonymous',
                })),
                ...journeys.map((j) => ({
                    kind:        'journey',
                    id:          j.id,
                    rating:      j.overallRating,
                    outcomeRating:   j.outcomeRating,
                    adherenceRating: j.adherenceRating,
                    sentiment:   j.sentiment,
                    highlights:  j.highlights || [],
                    feedbackText: j.feedbackText,
                    wouldRecommend: j.wouldRecommend,
                    createdAt:   j.createdAt,
                    patientId:   j.sentiment === 'POSITIVE' ? j.patientId : null,
                    patientName: j.sentiment === 'POSITIVE' ? 'Patient' : 'Anonymous',
                })),
            ].sort((a, b) => b.createdAt - a.createdAt);

            const start = (page - 1) * limit;
            const items = merged.slice(start, start + limit);
            res.json({
                success: true,
                data:    items,
                pagination: {
                    page, limit, total: merged.length,
                    totalPages: Math.max(1, Math.ceil(merged.length / limit)),
                },
            });
        } catch (err) {
            next(err);
        }
    },
);

// GET /api/feedback/analytics?branchId= — admin/branch-admin overview.
router.get(
    '/analytics',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN']),
    async (req, res, next) => {
        try {
            // BRANCH_ADMIN is pinned to their own branch; admins can pass branchId.
            let branchId = req.query.branchId || null;
            if (req.user.role === 'BRANCH_ADMIN') branchId = req.user.branchId;

            const where = branchId ? { branchId } : {};

            const [consultations, journeys] = await Promise.all([
                prisma.consultationFeedback.findMany({
                    where: { ...where, rating: { not: null } },
                    select: { rating: true, sentiment: true, categories: true,
                              feedbackText: true, createdAt: true, id: true,
                              clinicianId: true },
                }),
                prisma.journeyFeedback.findMany({
                    where: { ...where, overallRating: { not: null } },
                    select: { overallRating: true, sentiment: true, highlights: true,
                              feedbackText: true, createdAt: true, id: true,
                              primaryClinicianId: true },
                }),
            ]);

            const ratings = [
                ...consultations.map((c) => c.rating),
                ...journeys.map((j) => j.overallRating),
            ].filter((r) => Number.isFinite(r));
            const avgRating = ratings.length
                ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 100) / 100
                : null;

            const sentimentBreakdown = { POSITIVE: 0, NEUTRAL: 0, NEGATIVE: 0 };
            for (const row of [...consultations, ...journeys]) {
                if (row.sentiment) sentimentBreakdown[row.sentiment] = (sentimentBreakdown[row.sentiment] || 0) + 1;
            }

            const tagCounts = new Map();
            for (const c of consultations) for (const t of c.categories || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
            for (const j of journeys)      for (const t of j.highlights || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
            const topCategories = Array.from(tagCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([tag, count]) => ({ tag, count }));

            // Flagged: rating ≤ 2 (NEGATIVE).
            const flagged = [
                ...consultations.filter((c) => c.rating <= 2).map((c) => ({
                    kind: 'consultation', id: c.id, rating: c.rating,
                    feedbackText: c.feedbackText, createdAt: c.createdAt,
                    clinicianId: c.clinicianId,
                })),
                ...journeys.filter((j) => j.overallRating <= 2).map((j) => ({
                    kind: 'journey', id: j.id, rating: j.overallRating,
                    feedbackText: j.feedbackText, createdAt: j.createdAt,
                    clinicianId: j.primaryClinicianId,
                })),
            ].sort((a, b) => b.createdAt - a.createdAt);

            res.json({
                success: true,
                data: {
                    averageRating:   avgRating,
                    totalResponses:  ratings.length,
                    sentimentBreakdown,
                    topCategories,
                    flagged,
                },
            });
        } catch (err) {
            next(err);
        }
    },
);

// POST /api/feedback/home-therapy-session — both therapist and patient
// submit feedback on a completed home-therapy session via this endpoint.
// authorRole on the body decides which side of the row is filled in.
const homeTherapyFeedbackSchema = z.object({
    sessionId:  z.string().min(1),
    authorRole: z.enum(['THERAPIST', 'PATIENT']),
    rating:     z.number().int().min(1).max(5),
    tags:       z.array(z.string().min(1).max(64)).max(20).optional(),
    notes:      z.string().max(1000).optional(),
});

router.post(
    '/home-therapy-session',
    authMiddleware,
    roleMiddleware(['THERAPIST', 'PATIENT']),
    validate({ body: homeTherapyFeedbackSchema }),
    auditAction('SUBMIT_HOME_THERAPY_FEEDBACK', 'HomeTherapyFeedback', () => null),
    async (req, res, next) => {
        try {
            const row = await HomeTherapyService.submitFeedback({
                sessionId:  req.body.sessionId,
                user:       req.user,
                authorRole: req.body.authorRole,
                rating:     req.body.rating,
                tags:       req.body.tags ?? [],
                notes:      req.body.notes ?? null,
            });
            res.status(201).json(row);
        } catch (err) {
            if (err && typeof err.status === 'number') {
                return res.status(err.status).json({ error: err.message });
            }
            // Prisma errors leak as generic 500s through the default handler,
            // which surfaces as an unhelpful "Submission failed" on the
            // client. Log the full error here and bubble a structured
            // payload so the frontend can show the actual code + message.
            // Prisma errors carry `.code` (e.g. P2002 unique-violation,
            // P2025 not-found) which is the most useful diagnostic.
            const prismaCode = err && typeof err.code === 'string' && /^P\d+/.test(err.code) ? err.code : null;
            if (prismaCode) {
                console.error('[home-therapy feedback] prisma error', { code: prismaCode, message: err.message });
                return res.status(500).json({
                    error: `Database error (${prismaCode}): ${err.message}`,
                    code: prismaCode,
                });
            }
            console.error('[home-therapy feedback] unexpected error', err);
            next(err);
        }
    },
);

// POST /api/feedback/:id/acknowledge — admin marks a feedback row as triaged.
// Two-segment path so it doesn't collide with the legacy POST /:appointmentId.
router.post(
    '/:id/acknowledge',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    async (req, res, next) => {
        try {
            const id = req.params.id;
            // Try consultation first; fall back to journey.
            const updated = await prisma.consultationFeedback.updateMany({
                where: { id },
                data:  { acknowledgedById: req.user.id, acknowledgedAt: new Date() },
            });
            if (updated.count > 0) return res.json({ success: true, kind: 'consultation' });

            const j = await prisma.journeyFeedback.updateMany({
                where: { id },
                data:  { acknowledgedById: req.user.id, acknowledgedAt: new Date() },
            });
            if (j.count > 0) return res.json({ success: true, kind: 'journey' });

            res.status(404).json({ error: 'Feedback not found' });
        } catch (err) {
            next(err);
        }
    },
);

export default router;
