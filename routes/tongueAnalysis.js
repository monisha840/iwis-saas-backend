/**
 * F03 · Multimodal Diagnostic AI — Jihva Pariksha photo endpoints.
 *
 *   POST /api/wellness/check-in/tongue-photo         (PATIENT)
 *   GET  /api/patients/:patientId/tongue-observations (DOCTOR / ADMIN_DOCTOR)
 *
 * Both gated by MULTIMODAL_DIAGNOSTIC_AI. The POST endpoint never blocks
 * the check-in flow — analysis failures still result in a saved record
 * (with `analysisNotes: 'Analysis unavailable'`), so the patient never
 * sees the wizard get stuck because of an LLM hiccup.
 */

import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { getUploadMiddleware, uploadToSupabase } from '../middleware/upload.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { analyseTongue } from '../services/tongue/tongueAnalyser.js';

const router = express.Router();

// ── POST /api/wellness/check-in/tongue-photo ────────────────────────────────
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_MB = 5;
const tongueUpload = getUploadMiddleware({ maxSizeMb: MAX_MB, fieldName: 'photo' });

router.post(
    '/wellness/check-in/tongue-photo',
    authMiddleware,
    roleMiddleware(['PATIENT']),
    requireFeature('MULTIMODAL_DIAGNOSTIC_AI'),
    tongueUpload,
    async (req, res, next) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'photo is required' });
            if (!ALLOWED_MIME.has(req.file.mimetype)) {
                return res.status(400).json({ error: 'Only JPEG, PNG or WEBP photos are accepted' });
            }
            // Multer's `limits.fileSize` already enforces the 5MB ceiling
            // before this handler runs — when exceeded the upload errors out
            // before req.file exists. This guard is belt-and-braces only.
            if (req.file.size > MAX_MB * 1024 * 1024) {
                return res.status(400).json({ error: `Photo exceeds ${MAX_MB} MB limit` });
            }

            // Resolve the calling user → Patient row. Tongue observations
            // hang off Patient.id; the wellness check-in route follows the
            // same pattern.
            const patient = await prisma.patient.findUnique({
                where: { userId: req.user.id },
                select: { id: true, user: { select: { hospitalId: true } } },
            });
            if (!patient) return res.status(404).json({ error: 'Patient profile not found' });

            // checkInId is OPTIONAL — patient may upload outside the wizard
            // if a later UX surfaces it standalone. When supplied, we
            // verify ownership so a patient can't link to someone else's
            // check-in.
            const checkInId = (req.body?.checkInId || '').toString().trim() || null;
            if (checkInId) {
                const ci = await prisma.dailyCheckIn.findUnique({
                    where: { id: checkInId },
                    select: { patientId: true },
                });
                if (!ci || ci.patientId !== patient.id) {
                    return res.status(403).json({ error: 'checkInId does not belong to this patient' });
                }
            }

            // Upload to Supabase Storage. The shared helper uses bucket
            // 'medical-documents' by default; we route tongue photos to
            // 'tongue-photos' for clearer ops segregation. If the bucket
            // doesn't exist yet, the helper logs and falls back to local
            // disk — the upload always returns a usable URL.
            let photoUrl;
            try {
                const renamed = {
                    ...req.file,
                    // Encode patient + hospital + timestamp into the path so
                    // ops can locate a file from the DB record without
                    // joining tables.
                    originalname: `${patient.user?.hospitalId ?? 'no-hospital'}/${patient.id}/${Date.now()}.${(req.file.originalname.split('.').pop() ?? 'jpg').toLowerCase()}`,
                };
                photoUrl = await uploadToSupabase(renamed, 'tongue-photos');
            } catch (err) {
                logger.error('[tongue] storage upload failed', { err: err.message });
                return res.status(502).json({ error: 'Photo storage temporarily unavailable. Please try again.' });
            }

            // Fetch ConstitutionProfile so the LLM gets the right context.
            const constitution = await prisma.constitutionProfile.findUnique({
                where: { patientId: patient.id }, select: { prakriti: true },
            }).catch(() => null);
            const prakriti = constitution?.prakriti ?? null;

            // Run analysis. NEVER throws — returns null on any failure.
            const analysis = await analyseTongue(photoUrl, prakriti);

            const observation = await prisma.tongueObservation.create({
                data: {
                    patientId: patient.id,
                    checkInId: checkInId,
                    photoUrl,
                    observedAt: new Date(),
                    aiCoatingColour:    analysis?.coatingColour ?? null,
                    aiCoatingThickness: analysis?.coatingThickness ?? null,
                    aiMoisture:         analysis?.moisture ?? null,
                    cracks:             analysis?.cracks ?? false,
                    doshaIndication:    analysis?.doshaIndication ?? null,
                    confidence:         analysis?.confidence ?? null,
                    analysisNotes:      analysis?.analysisNotes ?? (analysis ? null : 'Analysis unavailable'),
                    rawAnalysis:        analysis?.rawAnalysis ?? null,
                },
                select: {
                    id: true, patientId: true, checkInId: true, photoUrl: true,
                    observedAt: true, aiCoatingColour: true, aiCoatingThickness: true,
                    aiMoisture: true, cracks: true, doshaIndication: true,
                    confidence: true, analysisNotes: true, alertEmitted: true,
                },
            });

            // 7) Flag a critical patient when the analysis is confident and
            //    points at a dosha imbalance. Mirror the upsert/merge pattern
            //    used by careGapAgent (F07) and doshaCron (F04) so multiple
            //    detectors can coexist on the same PatientCriticalFlag row.
            let alertEmitted = false;
            const dosha = observation.doshaIndication;
            const conf  = observation.confidence ?? 0;
            const triggerAlert =
                dosha && dosha !== 'BALANCED' && conf > 0.6;

            if (triggerAlert) {
                try {
                    const existing = await prisma.patientCriticalFlag.findUnique({
                        where: { patientId: patient.id },
                        select: { reasons: true, severity: true },
                    });
                    const incoming = {
                        type: 'TONGUE_PARIKSHA_ALERT',
                        observationId: observation.id,
                        doshaIndication: dosha,
                        confidence: conf,
                        detectedAt: new Date().toISOString(),
                    };
                    const priorReasons = Array.isArray(existing?.reasons) ? existing.reasons : [];
                    const mergedReasons = priorReasons
                        .filter((r) => r?.type !== 'TONGUE_PARIKSHA_ALERT')
                        .concat(incoming);

                    await prisma.patientCriticalFlag.upsert({
                        where: { patientId: patient.id },
                        create: {
                            patientId: patient.id,
                            // No branch context for patient-initiated uploads.
                            severity: 'LOW',
                            reasons: mergedReasons,
                            notes: 'Tongue Pariksha — review at next visit',
                            status: 'ACTIVE',
                        },
                        update: {
                            // Don't demote a HIGH severity (e.g. critical
                            // triage from F07) down to LOW — only raise.
                            ...(existing?.severity === 'HIGH' || existing?.severity === 'MEDIUM' ? {} : { severity: 'LOW' }),
                            reasons: mergedReasons,
                            lastDetectedAt: new Date(),
                            status: 'ACTIVE',
                            resolvedAt: null,
                            resolvedById: null,
                        },
                    });
                    await prisma.tongueObservation.update({
                        where: { id: observation.id },
                        data: { alertEmitted: true },
                    });
                    alertEmitted = true;
                } catch (err) {
                    logger.warn('[tongue] PatientCriticalFlag upsert failed', {
                        observationId: observation.id, err: err.message,
                    });
                }
            }

            res.status(201).json({ ...observation, alertEmitted });
        } catch (err) { next(err); }
    },
);

// ── GET /api/patients/:patientId/tongue-observations ────────────────────────
router.get(
    '/patients/:patientId/tongue-observations',
    authMiddleware,
    roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR']),
    requireFeature('MULTIMODAL_DIAGNOSTIC_AI'),
    async (req, res, next) => {
        try {
            const { patientId } = req.params;
            // Cross-hospital guard mirrors the dosha-forecast route.
            const patient = await prisma.patient.findUnique({
                where: { id: patientId },
                select: { id: true, user: { select: { hospitalId: true } } },
            });
            if (!patient) return res.status(404).json({ error: 'Patient not found' });
            if (patient.user?.hospitalId && req.user?.hospitalId &&
                patient.user.hospitalId !== req.user.hospitalId) {
                return res.status(403).json({ error: 'Forbidden — different hospital' });
            }

            const observations = await prisma.tongueObservation.findMany({
                where: { patientId },
                orderBy: { observedAt: 'desc' },
                take: 30,
                select: {
                    id: true,
                    photoUrl: true,
                    observedAt: true,
                    aiCoatingColour: true,
                    aiCoatingThickness: true,
                    aiMoisture: true,
                    cracks: true,
                    doshaIndication: true,
                    confidence: true,
                    analysisNotes: true,
                    alertEmitted: true,
                },
            });
            res.json({ observations });
        } catch (err) { next(err); }
    },
);

export default router;
