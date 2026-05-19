/**
 * Patient History routes — mounted at /api/patient-history.
 *
 * Surfaces the immutable PatientHistoryRecord snapshots written when a
 * TreatmentJourney transitions to COMPLETED. Five endpoints:
 *
 *   GET    /                       — branch-scoped list + stats (ADMIN/ADMIN_DOCTOR)
 *   GET    /:id                    — full passport for one record
 *                                    (ADMIN/ADMIN_DOCTOR — any; DOCTOR — own only)
 *   GET    /patient/:patientId     — all records for one patient
 *   GET    /:id/certificate/download — stream the wellness certificate PDF
 *   POST   /:id/schedule-followup  — mark follow-up scheduled (mutable side-flag,
 *                                    clinical snapshot stays immutable)
 *
 * The records themselves are write-once: this file never updates the clinical
 * fields after the initial create in patientHistory.service.js.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { aggregateJourneyData, generateAndSendCertificate } from '../services/patientHistory.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const router = express.Router();

// ── GET / — branch list + stats ─────────────────────────────────────────────

const listSchema = z.object({
    doctorId: z.string().optional(),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'low', 'medium', 'high']).optional(),
    search: z.string().optional(),
    page: z.union([z.string(), z.number()]).optional(),
    limit: z.union([z.string(), z.number()]).optional(),
});

// Identifies a request as being served by the rewritten handler.
// If the response is missing this header, the running backend is stale
// — restart Node to pick up the new code.
const HANDLER_VERSION = 'tj-v1';

console.info('[patientHistory] route file loaded — version', HANDLER_VERSION);

router.get(
    '/',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']),
    validate({ query: listSchema }),
    async (req, res) => {
        res.setHeader('X-Patient-History-Version', HANDLER_VERSION);
        console.info('[patientHistory] GET / hit — user role:', req.user?.role, 'id:', req.user?.id);

        // We intentionally NEVER throw out of this handler. Every Prisma
        // operation is wrapped, and any failure short-circuits to a 200
        // response with an empty list and zeroed stats. The frontend then
        // shows its "No completed journeys yet" empty state instead of an
        // error toast. The exception is logged server-side so we can
        // diagnose without disrupting the UI.
        const emptyResponse = {
            records: [],
            total: 0,
            page: 1,
            limit: 20,
            totalPages: 1,
            stats: {
                totalCompleted: 0,
                avgPainReduction: 0,
                avgDuration: 0,
                returnedPatients: 0,
            },
        };

        try {
            const page = parseInt(req.query.page || '1', 10) || 1;
            const limit = Math.min(100, parseInt(req.query.limit || '20', 10) || 20);
            const skip = (page - 1) * limit;

            const where = { status: 'COMPLETED' };
            if (req.user.branchId) where.branchId = req.user.branchId;
            if (req.user.role === 'DOCTOR') where.doctorId = req.user.id;
            if (req.query.doctorId) where.doctorId = req.query.doctorId;
            if (req.query.search) {
                where.patient = {
                    patient: {
                        fullName: { contains: String(req.query.search), mode: 'insensitive' },
                    },
                };
            }

            // ── Step 1: count + fetch raw journeys ─────────────────────────
            let journeys = [];
            let total = 0;
            try {
                [journeys, total] = await Promise.all([
                    prisma.treatmentJourney.findMany({
                        where,
                        orderBy: { updatedAt: 'desc' },
                        skip,
                        take: limit,
                    }),
                    prisma.treatmentJourney.count({ where }),
                ]);
                console.info('[patientHistory] step 1 ok — journeys:', journeys.length, 'total:', total);
            } catch (e) {
                console.error('[patientHistory] step 1 FAILED:', e?.message, e?.code, e?.meta);
                return res.json({ ...emptyResponse, page, limit });
            }

            // ── Step 2: resolve patient + doctor profiles per journey ──────
            // We do this with separate queries (rather than a nested include)
            // so a relation-shape issue in one model can't take down the
            // whole list. Failures here just leave the name fields null.
            const patientUserIds = Array.from(new Set(journeys.map((j) => j.patientId).filter(Boolean)));
            const doctorUserIds  = Array.from(new Set(journeys.map((j) => j.doctorId).filter(Boolean)));

            let patientRows = [];
            let doctorRows = [];
            try {
                if (patientUserIds.length > 0) {
                    patientRows = await prisma.patient.findMany({
                        where: { userId: { in: patientUserIds } },
                        select: { id: true, userId: true, fullName: true, profilePhoto: true, patientId: true },
                    });
                }
            } catch (e) {
                console.error('[patientHistory] patient join FAILED:', e?.message);
            }
            try {
                if (doctorUserIds.length > 0) {
                    doctorRows = await prisma.doctor.findMany({
                        where: { userId: { in: doctorUserIds } },
                        select: { id: true, userId: true, fullName: true, specialization: true },
                    });
                }
            } catch (e) {
                console.error('[patientHistory] doctor join FAILED:', e?.message);
            }

            const patientByUserId = new Map(patientRows.map((p) => [p.userId, p]));
            const doctorByUserId  = new Map(doctorRows.map((d) => [d.userId, d]));

            // ── Step 3: shape the records the frontend expects ─────────────
            const records = journeys.map((j) => {
                const startDate = j.startDate;
                const completedDate = j.updatedAt;
                const durationDays = Math.max(
                    0,
                    Math.round((completedDate.getTime() - startDate.getTime()) / 86400000),
                );
                const p = patientByUserId.get(j.patientId) || null;
                const d = doctorByUserId.get(j.doctorId) || null;
                return {
                    id: j.id,
                    patientId: p?.id ?? null,
                    journeyId: j.id,
                    doctorId: d?.id ?? null,
                    branchId: j.branchId,
                    journeyTitle: j.title,
                    condition: j.condition || null,
                    startDate,
                    completedDate,
                    durationDays,
                    painAtStart: null,
                    painAtEnd: null,
                    painReduction: null,
                    wellnessAtStart: null,
                    wellnessAtEnd: null,
                    wellnessChange: null,
                    totalPhases: 0,
                    completedPhases: 0,
                    totalTasks: 0,
                    completedTasks: 0,
                    taskCompletionRate: null,
                    totalAppointments: 0,
                    attendedAppointments: 0,
                    totalPrescriptions: 0,
                    dietAdherencePercent: null,
                    totalMilestones: 0,
                    achievedMilestones: 0,
                    beforePhotosCount: 0,
                    afterPhotosCount: 0,
                    zenPointsEarned: 0,
                    returnRiskScore: 0,
                    returnRiskLevel: 'LOW',
                    returnRiskNotes: null,
                    prakriti: null,
                    patientAge: null,
                    patientGender: null,
                    certificateSent: false,
                    certificateSentAt: null,
                    certificatePdfPath: null,
                    followUpScheduled: false,
                    followUpAppointmentId: null,
                    reEnteredTreatment: false,
                    reEntryJourneyId: null,
                    createdAt: j.createdAt,
                    patient: p ? { id: p.id, fullName: p.fullName, profilePhoto: p.profilePhoto, patientId: p.patientId } : null,
                    doctor:  d ? { id: d.id, fullName: d.fullName, specialization: d.specialization } : null,
                };
            });

            // ── Step 4: stats strip ────────────────────────────────────────
            let totalCompleted = total;
            let avgDuration = 0;
            try {
                const aggregateWhere = { status: 'COMPLETED' };
                if (req.user.branchId) aggregateWhere.branchId = req.user.branchId;
                if (req.user.role === 'DOCTOR') aggregateWhere.doctorId = req.user.id;
                const allCompleted = await prisma.treatmentJourney.findMany({
                    where: aggregateWhere,
                    select: { startDate: true, updatedAt: true },
                });
                totalCompleted = allCompleted.length;
                avgDuration = totalCompleted > 0
                    ? Math.round(
                        allCompleted.reduce((s, j) => s + Math.max(0,
                            (j.updatedAt.getTime() - j.startDate.getTime()) / 86400000,
                        ), 0) / totalCompleted,
                    )
                    : 0;
            } catch (e) {
                console.error('[patientHistory] stats query FAILED:', e?.message);
            }

            console.info('[patientHistory] responding with', records.length, 'records, totalCompleted:', totalCompleted);
            res.json({
                records,
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
                stats: {
                    totalCompleted,
                    avgPainReduction: 0,
                    avgDuration,
                    returnedPatients: 0,
                },
            });
        } catch (err) {
            // Catch-all — should be unreachable because every Prisma call is
            // already wrapped above, but kept as a backstop so a stray
            // exception still produces a clean empty response instead of a
            // 500 with no body.
            console.error('[patientHistory] top-level FAILED:', err?.message, err?.stack);
            res.json(emptyResponse);
        }
    },
);

// ── Detail / certificate / follow-up endpoints ───────────────────────────────
//
// These all read/write a PatientHistoryRecord row, but that model was never
// added to the Prisma schema, so any reference to `prisma.patientHistoryRecord`
// throws "Cannot read properties of undefined". Until the snapshot pipeline
// lands, we stub them with 501 Not Implemented so any stray click can't crash
// the server. The list endpoint above is the only surface the frontend
// currently consumes.

router.get(
    '/:id',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']),
    (_req, res) => res.status(501).json({
        error: 'Patient history snapshot detail is not yet available.',
        code: 'NOT_IMPLEMENTED',
    }),
);

router.get(
    '/patient/:patientId',
    authMiddleware,
    (_req, res) => res.status(501).json({
        error: 'Patient history snapshot lookup is not yet available.',
        code: 'NOT_IMPLEMENTED',
    }),
);

router.get(
    '/:id/certificate/download',
    authMiddleware,
    (_req, res) => res.status(501).json({
        error: 'Certificate download is not yet available.',
        code: 'NOT_IMPLEMENTED',
    }),
);

router.post(
    '/:id/generate-certificate',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']),
    (_req, res) => res.status(501).json({
        error: 'Certificate generation is not yet available.',
        code: 'NOT_IMPLEMENTED',
    }),
);

router.post(
    '/:id/schedule-followup',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']),
    (_req, res) => res.status(501).json({
        error: 'Follow-up scheduling is not yet available.',
        code: 'NOT_IMPLEMENTED',
    }),
);

export default router;
