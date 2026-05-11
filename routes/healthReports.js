/**
 * Health Reports HTTP routes (Feature 2).
 *
 * Mounted at /api/health-reports. authMiddleware is applied at the mount
 * point in index.js, so every handler here can assume req.user is populated.
 * Each handler then narrows access via roleMiddleware + scope checks.
 *
 * Auth shape used:
 *   • req.user.id              — User.id
 *   • req.user.role            — UserRole string
 *   • req.user.patientId       — populated by resolvePatientId middleware
 *                                 (only added on the GET-by-patient + download
 *                                 routes that PATIENT can hit)
 *   • req.user.doctorProfileId — populated by resolveDoctorId middleware
 *                                 (added on the generate route)
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import {
    authMiddleware,
    roleMiddleware,
    resolveDoctorId,
    resolvePatientId,
} from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';
import prisma from '../lib/prisma.js';
import { WhatsAppService } from '../services/whatsapp.service.js';
import {
    createAndDeliverReport,
    createAndDeliverProgressReport,
} from '../services/healthReport.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
// Project root (one level above /routes) — used to resolve report.pdfPath
// (which is stored relative to the backend root).
const BACKEND_ROOT = path.resolve(__dirname, '..');

const router = express.Router();

// resolvePatientId is unconditional — it 404s any caller without a Patient
// profile. For routes where DOCTOR/ADMIN_DOCTOR can also call, we need the
// resolver to fire only for PATIENT callers.
function resolvePatientIdIfPatient(req, res, next) {
    if (req.user?.role !== 'PATIENT') return next();
    return resolvePatientId(req, res, next);
}

// ── Role groups ─────────────────────────────────────────────────────────────
const GENERATE_ROLES = ['DOCTOR', 'ADMIN_DOCTOR'];
const RESEND_ROLES   = ['DOCTOR', 'ADMIN_DOCTOR'];
const READ_ROLES     = ['DOCTOR', 'ADMIN_DOCTOR', 'PATIENT'];

// ── Common helpers ──────────────────────────────────────────────────────────
function fmtDateForFilename(d) {
    const date = d instanceof Date ? d : new Date(d || Date.now());
    if (isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
    const yyyy = date.getFullYear();
    const mm   = String(date.getMonth() + 1).padStart(2, '0');
    const dd   = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function normalisePhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/\D/g, '');
    if (digits.startsWith('0')) digits = digits.substring(1);
    if (digits.length < 10) return null;
    return digits.startsWith('91') ? digits : `91${digits}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health-reports/preview
//
// Lightweight availability check used by the GenerateReportButton modal so
// the doctor can see what data is on file BEFORE clicking Generate. No PDF
// is produced — only existence flags and counts. Locked to clinician roles
// (we don't want a PATIENT sniffing arbitrary patient data via this route).
// ─────────────────────────────────────────────────────────────────────────────

router.get(
    '/preview',
    roleMiddleware(GENERATE_ROLES),
    async (req, res) => {
        const patientId = typeof req.query.patientId === 'string' ? req.query.patientId : null;
        const appointmentId = typeof req.query.appointmentId === 'string' ? req.query.appointmentId : null;
        if (!patientId) return res.status(400).json({ error: 'patientId is required' });

        try {
            // Resolve patient.userId once — TreatmentJourney + DailyCheckIn store
            // patientId as User.id, not Patient.id.
            const patient = await prisma.patient.findUnique({
                where: { id: patientId },
                select: { userId: true },
            });
            const journeyPatientId = patient?.userId || patientId;

            const [
                triage,
                journey,
                prescriptions,
                diet,
                nextAppt,
                appointment,
                existingReport,
            ] = await Promise.all([
                prisma.triageSession.findFirst({
                    where: { patientId },
                    orderBy: { createdAt: 'desc' },
                    select: { id: true, painRegions: true, urgencyLevel: true },
                }),
                prisma.treatmentJourney.findFirst({
                    where: { patientId: journeyPatientId, status: 'ACTIVE' },
                    select: { id: true, title: true },
                }),
                appointmentId
                    ? prisma.prescription.findMany({
                        where: { appointmentId },
                        select: { id: true },
                    })
                    : Promise.resolve([]),
                prisma.dietPrescription.findFirst({
                    where: { patientId, isActive: true },
                    select: { id: true, title: true },
                }),
                // Schema field is Appointment.date (NOT scheduledAt).
                prisma.appointment.findFirst({
                    where: { patientId, status: 'CONFIRMED', date: { gt: new Date() } },
                    select: { id: true, date: true },
                }),
                appointmentId
                    ? prisma.appointment.findUnique({
                        where: { id: appointmentId },
                        select: { notes: true, sessionNotes: true },
                    })
                    : Promise.resolve(null),
                appointmentId
                    ? prisma.healthReport.findFirst({
                        where: { appointmentId },
                        select: { id: true, createdAt: true, sentViaWhatsApp: true },
                    })
                    : Promise.resolve(null),
            ]);

            // hasConsultationNotes — true when the appointment has any notes/sessionNotes text.
            const hasConsultationNotes = !!(appointment?.notes?.trim() || appointment?.sessionNotes?.trim());
            const painRegionCount = Array.isArray(triage?.painRegions) ? triage.painRegions.length : 0;

            return res.json({
                hasTriage:             !!triage,
                painRegionCount,
                hasJourney:            !!journey,
                journeyTitle:          journey?.title || null,
                prescriptionCount:     prescriptions.length,
                hasDiet:               !!diet,
                dietTitle:             diet?.title || null,
                hasNextAppointment:    !!nextAppt,
                nextAppointmentDate:   nextAppt?.date || null,
                hasConsultationNotes,
                existingReport,
            });
        } catch (err) {
            logger.error('[healthReports.preview] failed', { err: err.message, patientId, appointmentId });
            return res.status(500).json({ error: err.message });
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/health-reports/generate
// ─────────────────────────────────────────────────────────────────────────────

const generateSchema = z.object({
    appointmentId: z.string().min(1).optional().nullable(),
    // patientId is optional in the schema. When the caller supplies an
    // appointmentId we derive patientId from the appointment row below; we
    // still 400 if both are missing because the report is per-patient.
    patientId:     z.string().min(1).optional(),
    sendWhatsApp:  z.boolean().optional(),
});

router.post(
    '/generate',
    roleMiddleware(GENERATE_ROLES),
    resolveDoctorId,
    validate({ body: generateSchema }),
    async (req, res) => {
        const { appointmentId, sendWhatsApp } = req.body;
        let { patientId } = req.body;

        try {
            // If an appointmentId was supplied, verify the appointment exists.
            // Per spec rule #7: missing appointment is OK only when appointmentId
            // wasn't supplied — a SUPPLIED-but-NOT-FOUND id is a bad request.
            // We also use this lookup to derive a missing patientId.
            if (appointmentId) {
                const appt = await prisma.appointment.findUnique({
                    where: { id: appointmentId },
                    select: { id: true, patientId: true },
                });
                if (!appt) {
                    return res.status(404).json({ error: 'Appointment not found' });
                }
                if (!patientId) patientId = appt.patientId;
            }
            if (!patientId) {
                return res.status(400).json({ error: 'patientId is required (or supply appointmentId to derive it)' });
            }

            // resolveDoctorId middleware sets req.user.doctorProfileId for
            // DOCTOR and ADMIN_DOCTOR. ADMIN_DOCTOR users sometimes lack a
            // Doctor profile — fall back to looking it up here.
            let doctorId = req.user.doctorProfileId || null;
            if (!doctorId) {
                const doc = await prisma.doctor.findUnique({
                    where: { userId: req.user.id },
                    select: { id: true },
                });
                doctorId = doc?.id || null;
            }
            if (!doctorId) {
                return res.status(400).json({ error: 'Calling user has no doctor profile' });
            }

            const result = await createAndDeliverReport(
                appointmentId || null,
                patientId,
                doctorId,
                Boolean(sendWhatsApp),
                req.user.id,
            );

            if (result.alreadyExisted) {
                return res.status(200).json({
                    success: true,
                    alreadyExisted: true,
                    report: result.report,
                });
            }

            return res.status(201).json({
                success: true,
                report: {
                    id:              result.report.id,
                    pdfPath:         result.report.pdfPath,
                    sentViaWhatsApp: result.report.sentViaWhatsApp,
                    whatsappDelivered: result.whatsappDelivered,
                    whatsappError:   result.whatsappError,
                    createdAt:       result.report.createdAt,
                },
            });
        } catch (err) {
            logger.error('[healthReports.generate] failed', { err: err.message, patientId, appointmentId });
            return res.status(err.status || 500).json({ error: err.message });
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/health-reports/generate-progress (Feature 4)
//
// Manual trigger / regenerate path. The auto-trigger fires from
// JourneyService.activateNextPhase, but doctors sometimes need to re-issue
// (e.g. patient's WhatsApp number was wrong on first send). Idempotency on
// (journeyPhaseId, PHASE_PROGRESS) lives in the service — re-invoking on
// the same phase returns the existing row instead of creating a duplicate.
// ─────────────────────────────────────────────────────────────────────────────

const generateProgressSchema = z.object({
    phaseId:   z.string().min(1, 'phaseId is required'),
    patientId: z.string().min(1, 'patientId is required'),
});

router.post(
    '/generate-progress',
    roleMiddleware(GENERATE_ROLES),
    resolveDoctorId,
    validate({ body: generateProgressSchema }),
    async (req, res) => {
        const { phaseId, patientId } = req.body;
        try {
            // Same doctor-resolution dance as /generate (resolveDoctorId may
            // not populate doctorProfileId for ADMIN_DOCTOR users without a
            // Doctor row).
            let doctorId = req.user.doctorProfileId || null;
            if (!doctorId) {
                const doc = await prisma.doctor.findUnique({
                    where: { userId: req.user.id },
                    select: { id: true },
                });
                doctorId = doc?.id || null;
            }
            if (!doctorId) {
                return res.status(400).json({ error: 'Calling user has no doctor profile' });
            }

            const result = await createAndDeliverProgressReport(phaseId, patientId, doctorId);

            if (result.alreadyExisted) {
                return res.status(200).json({
                    success: true,
                    alreadyExisted: true,
                    report: result.report,
                });
            }

            return res.status(201).json({
                success: true,
                report: {
                    id:              result.report.id,
                    pdfPath:         result.report.pdfPath,
                    sentViaWhatsApp: result.report.sentViaWhatsApp,
                    whatsappDelivered: result.whatsappDelivered,
                    whatsappError:   result.whatsappError,
                    createdAt:       result.report.createdAt,
                },
            });
        } catch (err) {
            logger.error('[healthReports.generateProgress] failed', { err: err.message, phaseId, patientId });
            return res.status(err.status || 500).json({ error: err.message });
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health-reports/phase/:phaseId (Feature 4)
//
// Returns the PHASE_PROGRESS report for a specific phase if one exists.
// PATIENT can only fetch their own (verified through journey.patientId →
// User.id matched against the patient's Patient record).
// ─────────────────────────────────────────────────────────────────────────────

router.get(
    '/phase/:phaseId',
    roleMiddleware(READ_ROLES),
    resolvePatientIdIfPatient,
    async (req, res) => {
        const { phaseId } = req.params;
        try {
            const report = await prisma.healthReport.findFirst({
                where: { journeyPhaseId: phaseId, reportType: 'PHASE_PROGRESS' },
                orderBy: { createdAt: 'desc' },
                include: {
                    doctor: { include: { user: { select: { id: true, email: true } } } },
                    branch: { select: { name: true } },
                },
            });
            if (!report) return res.status(404).json({ error: 'Progress report not found for this phase' });

            // PATIENT scope check — patient can only see reports tied to
            // their own Patient.id.
            if (req.user.role === 'PATIENT' && report.patientId !== req.user.patientId) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            return res.json({
                id:              report.id,
                reportType:      report.reportType,
                createdAt:       report.createdAt,
                sentViaWhatsApp: report.sentViaWhatsApp,
                whatsappSentAt:  report.whatsappSentAt,
                viewedByPatient: report.viewedByPatient,
                pdfSizeBytes:    report.pdfSizeBytes,
                doctorName:      report.doctor?.fullName || report.doctor?.user?.email || null,
                branchName:      report.branch?.name || null,
                reportData:      report.reportData,
            });
        } catch (err) {
            logger.error('[healthReports.getByPhase] failed', { err: err.message, phaseId });
            return res.status(500).json({ error: err.message });
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health-reports/patient/:patientId
// ─────────────────────────────────────────────────────────────────────────────

router.get(
    '/patient/:patientId',
    roleMiddleware(READ_ROLES),
    // resolvePatientId only fires for PATIENT callers (it's a no-op when
    // req.user.patientId is already set or role is non-patient — see middleware).
    resolvePatientIdIfPatient,
    async (req, res) => {
        const { patientId } = req.params;

        // PATIENT can only view their own reports.
        if (req.user.role === 'PATIENT' && req.user.patientId !== patientId) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        try {
            const reports = await prisma.healthReport.findMany({
                where: { patientId },
                orderBy: { createdAt: 'desc' },
                include: {
                    // User has no `name` column in this schema — Doctor.fullName
                    // is the canonical display name. We still pull the User row
                    // so callers can fall back on email when fullName is unset.
                    doctor:      { include: { user: { select: { id: true, email: true } } } },
                    branch:      { select: { name: true } },
                    appointment: { select: { date: true } },
                },
            });

            // Mark unread reports as viewed when the patient fetches the list.
            if (req.user.role === 'PATIENT') {
                const unreadIds = reports.filter((r) => !r.viewedByPatient).map((r) => r.id);
                if (unreadIds.length > 0) {
                    await prisma.healthReport.updateMany({
                        where: { id: { in: unreadIds } },
                        data:  { viewedByPatient: true, viewedAt: new Date() },
                    });
                }
            }

            const mapped = reports.map((r) => ({
                id:               r.id,
                createdAt:        r.createdAt,
                sentViaWhatsApp:  r.sentViaWhatsApp,
                whatsappSentAt:   r.whatsappSentAt,
                viewedByPatient:  r.viewedByPatient,
                doctorName:       r.doctor?.fullName || r.doctor?.user?.email || null,
                branchName:       r.branch?.name || null,
                appointmentDate:  r.appointment?.date || null,
                pdfSizeBytes:     r.pdfSizeBytes,
                // Feature 4 — discriminator + summary stats so the frontend
                // can render PHASE_PROGRESS cards differently without a
                // second round-trip.
                reportType:       r.reportType,
                journeyPhaseId:   r.journeyPhaseId,
                reportData:       r.reportData,
            }));

            return res.json(mapped);
        } catch (err) {
            logger.error('[healthReports.listForPatient] failed', { err: err.message, patientId });
            return res.status(500).json({ error: err.message });
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health-reports/:id/download
// ─────────────────────────────────────────────────────────────────────────────

router.get(
    '/:id/download',
    roleMiddleware(READ_ROLES),
    resolvePatientIdIfPatient,
    async (req, res) => {
        const { id } = req.params;

        try {
            const report = await prisma.healthReport.findUnique({ where: { id } });
            if (!report) return res.status(404).json({ error: 'Report not found' });

            if (req.user.role === 'PATIENT' && req.user.patientId !== report.patientId) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            if (!report.pdfPath) {
                return res.status(404).json({ error: 'PDF file not found' });
            }
            // pdfPath is stored relative to the backend root — resolve to absolute.
            const absolute = path.isAbsolute(report.pdfPath)
                ? report.pdfPath
                : path.join(BACKEND_ROOT, report.pdfPath);
            if (!fs.existsSync(absolute)) {
                logger.warn('[healthReports.download] file missing on disk', { reportId: id, pdfPath: report.pdfPath });
                return res.status(404).json({ error: 'PDF file not found' });
            }

            // Mark viewed when a PATIENT downloads (best-effort — never blocks
            // the file stream).
            if (req.user.role === 'PATIENT' && !report.viewedByPatient) {
                prisma.healthReport.update({
                    where: { id },
                    data:  { viewedByPatient: true, viewedAt: new Date() },
                }).catch((err) => logger.warn('[healthReports.download] mark-viewed failed', { err: err.message }));
            }

            const dateStamp = fmtDateForFilename(report.createdAt);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="AlShifa-Health-Report-${dateStamp}.pdf"`);

            const stream = fs.createReadStream(absolute);
            stream.on('error', (err) => {
                logger.error('[healthReports.download] stream error', { err: err.message, reportId: id });
                if (!res.headersSent) res.status(500).end();
                else res.destroy(err);
            });
            stream.pipe(res);
        } catch (err) {
            logger.error('[healthReports.download] failed', { err: err.message, id });
            return res.status(500).json({ error: err.message });
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/health-reports/:id/resend-whatsapp
// ─────────────────────────────────────────────────────────────────────────────

router.post(
    '/:id/resend-whatsapp',
    roleMiddleware(RESEND_ROLES),
    async (req, res) => {
        const { id } = req.params;
        try {
            const report = await prisma.healthReport.findUnique({
                where: { id },
                include: {
                    patient: {
                        include: {
                            user: { include: { notificationPreference: true } },
                        },
                    },
                    doctor: { include: { user: true } },
                    branch: true,
                },
            });
            if (!report) return res.status(404).json({ error: 'Report not found' });

            if (!report.pdfPath) {
                return res.status(404).json({ error: 'PDF file not found' });
            }
            const absolute = path.isAbsolute(report.pdfPath)
                ? report.pdfPath
                : path.join(BACKEND_ROOT, report.pdfPath);
            if (!fs.existsSync(absolute)) {
                return res.status(404).json({ error: 'PDF file not found' });
            }

            const prefNumber = report.patient?.user?.notificationPreference?.whatsappNumber;
            const fallback   = report.patient?.phoneNumber ;
            const whatsappNumber = normalisePhone(prefNumber || fallback);
            if (!whatsappNumber) {
                return res.status(400).json({
                    success: false,
                    whatsappError: 'No WhatsApp number on file for this patient',
                });
            }

            const pdfBuffer = await fs.promises.readFile(absolute);
            const doctorName  = report.doctor?.fullName || report.doctor?.user?.email || 'your doctor';
            const patientName = report.patient?.fullName || report.patient?.user?.email || 'Patient';
            const reportDate  = fmtDateForFilename(new Date()).replace(/-/g, '-');
            const branchName  = report.branch?.name || 'Al-Shifa';

            try {
                const result = await WhatsAppService.sendDocument({
                    phone:    whatsappNumber,
                    document: pdfBuffer.toString('base64'),
                    filename: `AlShifa-Health-Report-${reportDate}.pdf`,
                    caption:  `📋 *Your Al-Shifa Health Report*\n\n`
                            + `Dear ${patientName},\n\n`
                            + `Your consultation report from Dr. ${doctorName} is ready.\n\n`
                            + `Date: ${reportDate}\n`
                            + `Branch: ${branchName}\n\n`
                            + `View and download it in your Al-Shifa app.`,
                });

                if (result?.status === 'SENT') {
                    await prisma.healthReport.update({
                        where: { id },
                        data:  { sentViaWhatsApp: true, whatsappSentAt: new Date() },
                    });
                    return res.json({ success: true, whatsappDelivered: true });
                }
                return res.status(200).json({
                    success: false,
                    whatsappDelivered: false,
                    whatsappError: result?.error || `WhatsApp returned status: ${result?.status || 'unknown'}`,
                });
            } catch (err) {
                logger.warn('[healthReports.resendWhatsApp] delivery failed', { err: err.message, id });
                return res.status(200).json({
                    success: false,
                    whatsappDelivered: false,
                    whatsappError: err.message,
                });
            }
        } catch (err) {
            logger.error('[healthReports.resendWhatsApp] failed', { err: err.message, id });
            return res.status(500).json({ error: err.message });
        }
    },
);

export default router;
