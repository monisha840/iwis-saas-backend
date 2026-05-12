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

router.get(
    '/',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    validate({ query: listSchema }),
    async (req, res, next) => {
        try {
            const page = parseInt(req.query.page || '1', 10) || 1;
            const limit = Math.min(100, parseInt(req.query.limit || '20', 10) || 20);
            const skip = (page - 1) * limit;

            const where = {};
            if (req.user.branchId) where.branchId = req.user.branchId;
            if (req.query.doctorId) where.doctorId = req.query.doctorId;
            if (req.query.riskLevel) where.returnRiskLevel = String(req.query.riskLevel).toUpperCase();
            if (req.query.search) {
                where.patient = {
                    fullName: { contains: String(req.query.search), mode: 'insensitive' },
                };
            }

            const [records, total] = await Promise.all([
                prisma.patientHistoryRecord.findMany({
                    where,
                    include: {
                        patient: {
                            select: {
                                id: true,
                                fullName: true,
                                profilePhoto: true,
                                patientId: true,
                            },
                        },
                        doctor: {
                            select: {
                                id: true,
                                fullName: true,
                            },
                        },
                    },
                    orderBy: { completedDate: 'desc' },
                    skip,
                    take: limit,
                }),
                prisma.patientHistoryRecord.count({ where }),
            ]);

            // Branch-scoped aggregates — separate from the filtered list so
            // the strip stays stable as the user toggles filters.
            const aggregateWhere = req.user.branchId ? { branchId: req.user.branchId } : {};
            const allBranchRecords = await prisma.patientHistoryRecord.findMany({
                where: aggregateWhere,
                select: { painReduction: true, durationDays: true },
            });
            const branchTotal = allBranchRecords.length;
            const painSamples = allBranchRecords
                .map((r) => r.painReduction)
                .filter((v) => v !== null && v !== undefined);
            const avgPainReduction = painSamples.length > 0
                ? Math.round(painSamples.reduce((s, v) => s + v, 0) / painSamples.length)
                : 0;
            const avgDuration = branchTotal > 0
                ? Math.round(allBranchRecords.reduce((s, r) => s + r.durationDays, 0) / branchTotal)
                : 0;
            const returnedPatients = await prisma.patientHistoryRecord.count({
                where: { ...aggregateWhere, reEnteredTreatment: true },
            });

            res.json({
                records,
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
                stats: {
                    totalCompleted: branchTotal,
                    avgPainReduction,
                    avgDuration,
                    returnedPatients,
                },
            });
        } catch (err) { next(err); }
    },
);

// ── GET /:id — full passport ─────────────────────────────────────────────────

router.get(
    '/:id',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']),
    async (req, res, next) => {
        try {
            const record = await prisma.patientHistoryRecord.findUnique({
                where: { id: req.params.id },
                include: {
                    patient: {
                        select: {
                            id: true,
                            fullName: true,
                            profilePhoto: true,
                            patientId: true,
                            phoneNumber: true,
                            user: { select: { email: true } },
                        },
                    },
                    doctor: {
                        select: {
                            id: true,
                            userId: true,
                            fullName: true,
                            specialization: true,
                        },
                    },
                    journey: {
                        include: {
                            phases: {
                                include: { tasks: true },
                                orderBy: { order: 'asc' },
                            },
                            milestones: true,
                        },
                    },
                    branch: { select: { name: true } },
                },
            });
            if (!record) return res.status(404).json({ error: 'Record not found' });

            // DOCTOR role — only their own patients. We compare Doctor.userId
            // (from the joined relation) to req.user.id since the JWT only
            // carries User.id, not Doctor.id.
            if (req.user.role === 'DOCTOR' && record.doctor?.userId !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const [appointments, prescriptions, photos] = await Promise.all([
                prisma.appointment.findMany({
                    where: {
                        patientId: record.patientId,
                        date: { gte: record.startDate, lte: record.completedDate },
                    },
                    include: {
                        doctor: { select: { id: true, fullName: true } },
                    },
                    orderBy: { date: 'desc' },
                }),
                prisma.prescription.findMany({
                    where: {
                        patientId: record.patientId,
                        createdAt: { gte: record.startDate, lte: record.completedDate },
                    },
                    orderBy: { createdAt: 'desc' },
                }),
                prisma.clinicalPhoto.findMany({
                    where: {
                        patientId: record.patientId,
                        journeyId: record.journeyId,
                    },
                    orderBy: { takenAt: 'asc' },
                }),
            ]);

            res.json({ record, appointments, prescriptions, photos });
        } catch (err) { next(err); }
    },
);

// ── GET /patient/:patientId — all records for one patient ─────────────────

router.get(
    '/patient/:patientId',
    authMiddleware,
    async (req, res, next) => {
        try {
            // PATIENT role — can only fetch own. Compare Patient.userId to
            // req.user.id, since the JWT carries User.id.
            if (req.user.role === 'PATIENT') {
                const me = await prisma.patient.findUnique({
                    where: { id: req.params.patientId },
                    select: { userId: true },
                });
                if (!me || me.userId !== req.user.id) {
                    return res.status(403).json({ error: 'Access denied' });
                }
            }

            const records = await prisma.patientHistoryRecord.findMany({
                where: { patientId: req.params.patientId },
                include: {
                    doctor: { select: { id: true, fullName: true } },
                    branch: { select: { name: true } },
                },
                orderBy: { completedDate: 'desc' },
            });
            res.json({ records });
        } catch (err) { next(err); }
    },
);

// ── GET /:id/certificate/download ──────────────────────────────────────────

router.get(
    '/:id/certificate/download',
    authMiddleware,
    async (req, res, next) => {
        try {
            const record = await prisma.patientHistoryRecord.findUnique({
                where: { id: req.params.id },
                include: {
                    patient: { select: { id: true, userId: true } },
                    doctor: { select: { userId: true } },
                },
            });
            if (!record) return res.status(404).json({ error: 'Record not found' });
            if (!record.certificatePdfPath) {
                return res.status(404).json({ error: 'Certificate not yet generated' });
            }

            // Access control — PATIENT can download own, DOCTOR can download
            // for their own patients, ADMIN/ADMIN_DOCTOR unrestricted.
            const role = req.user.role;
            if (role === 'PATIENT' && record.patient?.userId !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }
            if (role === 'DOCTOR' && record.doctor?.userId !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Resolve absolute path from the stored `uploads/certificates/...`
            // relative path. `__dirname` here is /routes; the uploads dir
            // lives one level up.
            const absolutePath = path.join(__dirname, '..', record.certificatePdfPath);
            if (!fs.existsSync(absolutePath)) {
                return res.status(404).json({ error: 'Certificate file not found on disk' });
            }
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename="AlShifa-Wellness-Certificate.pdf"');
            fs.createReadStream(absolutePath).pipe(res);
        } catch (err) { next(err); }
    },
);

// ── POST /:id/generate-certificate ──────────────────────────────────────────
//
// Admin-initiated certificate generation for records that don't yet have a
// PDF — typically the retroactively-backfilled rows whose live-hook firing
// pre-dated this feature. Regenerates the PDF, persists the path on the
// record, and (by default) skips WhatsApp delivery so a "Congratulations on
// finishing your journey!" message doesn't go out weeks after the fact.
//
// Pass `{ sendWhatsApp: true }` in the body to force the WhatsApp send (e.g.
// admin explicitly wants the patient to receive the cert via WhatsApp now).
// The patient's NotificationPreference.whatsappEnabled still applies as a
// final gate inside the service — admins can't bypass an opted-out patient.

const generateCertSchema = z.object({
    sendWhatsApp: z.boolean().optional().default(false),
});

router.post(
    '/:id/generate-certificate',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']),
    validate({ body: generateCertSchema }),
    async (req, res, next) => {
        try {
            const record = await prisma.patientHistoryRecord.findUnique({
                where: { id: req.params.id },
                include: {
                    doctor: { select: { userId: true } },
                },
            });
            if (!record) return res.status(404).json({ error: 'Record not found' });

            // DOCTOR scope check — same gate as GET /:id.
            if (req.user.role === 'DOCTOR' && record.doctor?.userId !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Re-aggregate from the journey because the certificate template
            // needs the patient + doctor + branch joined data, not just the
            // PatientHistoryRecord snapshot.
            const data = await aggregateJourneyData(record.journeyId);

            await generateAndSendCertificate(record, data, {
                sendWhatsApp: req.body.sendWhatsApp === true,
            });

            // Reload to surface the updated certificatePdfPath /
            // certificateSent / certificateSentAt fields the service wrote.
            const refreshed = await prisma.patientHistoryRecord.findUnique({
                where: { id: record.id },
            });
            return res.json({ record: refreshed });
        } catch (err) { next(err); }
    },
);

// ── POST /:id/schedule-followup ────────────────────────────────────────────

const scheduleFollowupSchema = z.object({
    appointmentId: z.string().optional().nullable(),
});

router.post(
    '/:id/schedule-followup',
    authMiddleware,
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']),
    validate({ body: scheduleFollowupSchema }),
    async (req, res, next) => {
        try {
            const updated = await prisma.patientHistoryRecord.update({
                where: { id: req.params.id },
                data: {
                    followUpScheduled: true,
                    followUpAppointmentId: req.body.appointmentId || null,
                },
            });
            res.json({ record: updated });
        } catch (err) { next(err); }
    },
);

export default router;
