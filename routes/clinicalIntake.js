/**
 * Clinician-side intake write endpoints.
 *
 *   POST  /api/patients/:patientId/vitals              record one or more vital readings
 *   POST  /api/patients/:patientId/constitution       upsert Prakriti / Agni / Satva
 *   PATCH /api/patients/:patientId/lifestyle-snapshot merge lifestyle into latest triage
 *
 * All three are gated to DOCTOR / ADMIN_DOCTOR / THERAPIST. The matching
 * GET endpoints live in routes/healthSummary.js and consume the same tables.
 *
 * Schema footgun: PatientVital.patientId references User.id (schema.prisma:1802),
 * NOT Patient.id like every other patient-relation in this codebase. We
 * resolve `Patient.id → Patient.userId` once at the start of each handler.
 */

import express from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';

const router = express.Router();

const CLINICIAN_ROLES = ['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST'];

// ── Vitals POST ─────────────────────────────────────────────────────────────
// Height is intentionally NOT a VitalType enum value — it goes into
// Patient.onboardingData.heightCm so the existing healthReport `pickHeight`
// helper continues to work without a schema migration.
const VITAL_TYPES = ['PAIN_SCORE', 'WEIGHT', 'SLEEP_HOURS', 'MOOD', 'BP_SYSTOLIC', 'BP_DIASTOLIC', 'GLUCOSE'];

const vitalsBodySchema = z.object({
    heightCm: z.number().min(30).max(260).nullable().optional(),
    readings: z.array(z.object({
        type:  z.enum(VITAL_TYPES),
        value: z.number(),
        unit:  z.string().min(1).max(16),
    })).default([]),
}).refine(
    (b) => b.heightCm != null || b.readings.length > 0,
    { message: 'At least one of heightCm or readings must be supplied' },
);

// ── Patient self-vitals ─────────────────────────────────────────────────────
// Same shape as the clinician endpoint, but resolves the patient from
// req.user (no path param) and writes with `source: 'self-reported'`.
// Lets patients log Weight, Height, Pain, Sleep Hours, Mood directly from
// the My Vitals tab so they don't have to wait for a clinician.
router.post(
    '/patient/self-vitals',
    authMiddleware,
    validate({ body: vitalsBodySchema }),
    async (req, res, next) => {
        try {
            if (req.user.role !== 'PATIENT') {
                return res.status(403).json({ error: 'Only patients may use this endpoint' });
            }
            const patient = await prisma.patient.findUnique({
                where: { userId: req.user.id },
                select: { id: true, userId: true, onboardingData: true },
            });
            if (!patient) return res.status(404).json({ error: 'No patient record linked to this account' });

            const { heightCm, readings } = req.body;
            const createdVitals = await prisma.$transaction(async (tx) => {
                const out = [];
                for (const r of readings) {
                    const row = await tx.patientVital.create({
                        data: {
                            patientId: patient.userId,
                            type:      r.type,
                            value:     r.value,
                            unit:      r.unit,
                            source:    'self-reported',
                        },
                    });
                    out.push(row);
                }
                if (heightCm != null) {
                    const merged = {
                        ...(patient.onboardingData && typeof patient.onboardingData === 'object' ? patient.onboardingData : {}),
                        heightCm,
                    };
                    await tx.patient.update({ where: { id: patient.id }, data: { onboardingData: merged } });
                }
                return out;
            });

            logger.info('[clinicalIntake] patient self-vitals recorded', {
                patientId: patient.id, count: createdVitals.length, height: heightCm,
            });
            res.status(201).json({ readings: createdVitals, heightCm });
        } catch (err) { next(err); }
    },
);

router.post(
    '/patients/:patientId/vitals',
    authMiddleware,
    roleMiddleware(CLINICIAN_ROLES),
    validate({ body: vitalsBodySchema }),
    async (req, res, next) => {
        try {
            const { patientId } = req.params;
            const { heightCm, readings } = req.body;

            const patient = await prisma.patient.findUnique({
                where: { id: patientId },
                select: { id: true, userId: true, onboardingData: true },
            });
            if (!patient) return res.status(404).json({ error: 'Patient not found' });

            const createdVitals = await prisma.$transaction(async (tx) => {
                const out = [];
                for (const r of readings) {
                    // patientId on PatientVital is User.id, not Patient.id (schema footgun).
                    const row = await tx.patientVital.create({
                        data: {
                            patientId: patient.userId,
                            type:      r.type,
                            value:     r.value,
                            unit:      r.unit,
                            source:    'clinician',
                        },
                    });
                    out.push(row);
                }

                // Height lives in onboardingData (legacy reader path). Merge so we
                // don't clobber other onboarding fields that may already exist.
                if (heightCm != null) {
                    const merged = {
                        ...(patient.onboardingData && typeof patient.onboardingData === 'object' ? patient.onboardingData : {}),
                        heightCm,
                    };
                    await tx.patient.update({
                        where: { id: patient.id },
                        data:  { onboardingData: merged },
                    });
                }

                return out;
            });

            logger.info('[clinicalIntake] vitals recorded', {
                patientId, by: req.user.id, count: createdVitals.length, height: heightCm,
            });
            res.status(201).json({ readings: createdVitals, heightCm });
        } catch (err) { next(err); }
    },
);

// ── Constitution POST (Prakriti / Agni / Satva) ─────────────────────────────
const PRAKRITI_VALUES = ['VATA', 'PITTA', 'KAPHA', 'VATA_PITTA', 'PITTA_KAPHA', 'VATA_KAPHA', 'TRIDOSHA'];
const AGNI_VALUES     = ['MANDAGNI', 'TIKSHNA', 'VISHAMA', 'SAMA'];

const constitutionBodySchema = z.object({
    prakriti:    z.enum(PRAKRITI_VALUES).nullable().optional(),
    satvaRating: z.number().int().min(1).max(10).nullable().optional(),
    agniType:    z.enum(AGNI_VALUES).nullable().optional(),
}).refine(
    (b) => b.prakriti != null || b.satvaRating != null || b.agniType != null,
    { message: 'At least one of prakriti, satvaRating, or agniType must be supplied' },
);

router.post(
    '/patients/:patientId/constitution',
    authMiddleware,
    roleMiddleware(CLINICIAN_ROLES),
    validate({ body: constitutionBodySchema }),
    async (req, res, next) => {
        try {
            const { patientId } = req.params;
            const patient = await prisma.patient.findUnique({
                where: { id: patientId }, select: { id: true },
            });
            if (!patient) return res.status(404).json({ error: 'Patient not found' });

            const updated = await prisma.constitutionProfile.upsert({
                where:  { patientId },
                create: {
                    patientId,
                    prakriti:      req.body.prakriti ?? null,
                    satvaRating:   req.body.satvaRating ?? null,
                    agniType:      req.body.agniType ?? null,
                    lastUpdatedBy: req.user.id,
                    completedAt:   new Date(),
                },
                update: {
                    ...(req.body.prakriti    !== undefined && { prakriti:    req.body.prakriti }),
                    ...(req.body.satvaRating !== undefined && { satvaRating: req.body.satvaRating }),
                    ...(req.body.agniType    !== undefined && { agniType:    req.body.agniType }),
                    lastUpdatedBy: req.user.id,
                    completedAt:   new Date(),
                },
            });
            logger.info('[clinicalIntake] constitution upserted', { patientId, by: req.user.id });
            res.status(201).json(updated);
        } catch (err) { next(err); }
    },
);

// ── Lifestyle PATCH (merges into latest TriageSession) ─────────────────────
const lifestyleBodySchema = z.object({
    sleepQuality:      z.number().int().min(1).max(5).nullable().optional(),
    stressLevel:       z.number().int().min(1).max(10).nullable().optional(),
    exerciseFrequency: z.string().max(80).nullable().optional(),
    dietType:          z.string().max(80).nullable().optional(),
}).refine(
    (b) => Object.values(b).some((v) => v !== undefined),
    { message: 'At least one lifestyle field must be supplied' },
);

router.patch(
    '/patients/:patientId/lifestyle-snapshot',
    authMiddleware,
    roleMiddleware(CLINICIAN_ROLES),
    validate({ body: lifestyleBodySchema }),
    async (req, res, next) => {
        try {
            const { patientId } = req.params;
            const patient = await prisma.patient.findUnique({
                where: { id: patientId }, select: { id: true },
            });
            if (!patient) return res.status(404).json({ error: 'Patient not found' });

            // Build a clean object of just the supplied fields so we don't
            // overwrite a previous value with undefined.
            const incoming = {};
            for (const k of ['sleepQuality', 'stressLevel', 'exerciseFrequency', 'dietType']) {
                if (req.body[k] !== undefined) incoming[k] = req.body[k];
            }

            const latest = await prisma.triageSession.findFirst({
                where: { patientId }, orderBy: { createdAt: 'desc' },
                select: { id: true, lifestyleData: true },
            });

            let saved;
            if (latest) {
                const merged = {
                    ...(latest.lifestyleData && typeof latest.lifestyleData === 'object' ? latest.lifestyleData : {}),
                    ...incoming,
                };
                saved = await prisma.triageSession.update({
                    where: { id: latest.id },
                    data:  { lifestyleData: merged },
                    select: { id: true, lifestyleData: true, createdAt: true },
                });
            } else {
                // No triage on file — create a minimal one tagged as a clinician
                // observation. responses + severity are required by the schema.
                saved = await prisma.triageSession.create({
                    data: {
                        patientId,
                        responses:     {},
                        severity:      'CLINICIAN_OBSERVATION',
                        lifestyleData: incoming,
                    },
                    select: { id: true, lifestyleData: true, createdAt: true },
                });
            }
            logger.info('[clinicalIntake] lifestyle upserted', {
                patientId, by: req.user.id, sessionId: saved.id,
            });
            res.status(200).json(saved);
        } catch (err) { next(err); }
    },
);

export default router;
