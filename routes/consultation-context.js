/**
 * GET /api/patient/:patientId/consultation-context
 *
 * Single-shot aggregate that powers the Consultation Room patient-history
 * panel. Six data sources fetched in parallel and returned in one
 * response so the doctor's panel doesn't waterfall HTTP requests:
 *
 *   1. Previous prescriptions (latest 30 — full medication detail)
 *   2. Previous appointments (latest 10 — with assigned clinician)
 *   3. Visit summaries (latest 30 — diagnosis + treatment plan summary)
 *   4. Triage history (all sessions — score, urgency, regions)
 *   5. Pain & vitals — last 14 daily check-ins (painRegions arrays) +
 *      most-recent latched vital per type
 *   6. Active treatment journey with phases + milestones
 *
 * RBAC: only clinicians who could plausibly consult on this patient may
 * read the full context — DOCTOR / ADMIN_DOCTOR / THERAPIST / ADMIN /
 * BRANCH_ADMIN / SUPER_ADMIN. Patients can read their own context (the
 * aggregate is also useful for the patient-side timeline).
 */

import express from 'express';
import { Prisma } from '@prisma/client';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import { getCurrentTenant } from '../lib/tenantContext.js';
import logger from '../lib/logger.js';

const router = express.Router();

router.get(
  '/:patientId/consultation-context',
  authMiddleware,
  roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST', 'ADMIN', 'BRANCH_ADMIN', 'SUPER_ADMIN', 'PATIENT']),
  async (req, res, next) => {
    try {
      const { patientId } = req.params;

      // Patients may only read their own context.
      if (req.user.role === 'PATIENT') {
        const me = await prisma.patient.findUnique({
          where: { userId: req.user.id },
          select: { id: true },
        });
        if (!me || me.id !== patientId) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: {
          id: true, fullName: true, dob: true, gender: true,
          phoneNumber: true, profilePhoto: true,
          user: { select: { email: true } },
        },
      });
      if (!patient) return res.status(404).json({ error: 'Patient not found' });

      const tenant = getCurrentTenant();

      const [
        prescriptions,
        appointments,
        visitSummaries,
        triageSessions,
        dailyCheckIns,
        latestVitals,
        activeJourney,
      ] = await Promise.all([
        prisma.prescription.findMany({
          where: { patientId },
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: {
            id: true, medicationName: true, dosage: true, frequency: true,
            duration: true, notes: true, totalQuantity: true,
            createdAt: true,
            doctor: { select: { id: true, fullName: true, specialization: true } },
            therapist: { select: { id: true, fullName: true } },
          },
        }),

        prisma.appointment.findMany({
          where: { patientId },
          orderBy: { date: 'desc' },
          take: 10,
          select: {
            id: true, date: true, status: true,
            consultationType: true, consultationMode: true,
            sessionNotes: true, notes: true,
            doctor: { select: { id: true, fullName: true, specialization: true } },
            therapist: { select: { id: true, fullName: true } },
          },
        }),

        prisma.visitSummary.findMany({
          where: { patientId, sentToPatient: true },
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: {
            id: true, diagnosis: true, treatmentNotes: true,
            dietaryAdvice: true, nextSteps: true, followUpDate: true,
            clinicianName: true, sentAt: true, createdAt: true,
            appointmentId: true,
          },
        }),

        prisma.triageSession.findMany({
          where: { patientId },
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: {
            id: true, severity: true, urgencyLevel: true, compositeScore: true,
            painRegions: true, responses: true, createdAt: true,
            // Reports / scans the patient uploaded during the triage
            // questionnaire — surface them so the reviewing doctor can
            // pull up the lab work that prompted the booking without
            // hunting through the patient profile.
            documents: {
              select: {
                id: true, fileName: true, fileUrl: true, fileType: true,
                fileSize: true, category: true, description: true, createdAt: true,
              },
              orderBy: { createdAt: 'desc' },
            },
          },
        }),

        // Pain & vitals: last 14 check-ins for the body-map timeline
        prisma.dailyCheckIn.findMany({
          where: { patientId },
          orderBy: { createdAt: 'desc' },
          take: 14,
          select: {
            id: true, painLevel: true, painRegions: true, mood: true,
            sleepHours: true, createdAt: true,
          },
        }),

        // Latest latched vital per type. Patient.id and the User on the
        // patient share a 1:1 relation; vitals are written under
        // PatientVital.patientId = User.id (matches enhancedDashboard
        // service convention), so we look up via the user.
        // Parameterised (no string interpolation). Tenant guard: when a request
        // tenant is set, restrict to vitals whose owning User is in that hospital.
        prisma.$queryRaw`
          SELECT DISTINCT ON ("type") "type", "value", "unit", "recordedAt"
          FROM "PatientVital"
          WHERE "patientId" IN (SELECT "userId" FROM "Patient" WHERE "id" = ${patientId})
          ${tenant
            ? Prisma.sql`AND "patientId" IN (SELECT "id" FROM "User" WHERE "hospitalId" = ${tenant})`
            : Prisma.empty}
          ORDER BY "type", "recordedAt" DESC`.catch(() => []),

        prisma.treatmentJourney.findFirst({
          where: { patientId, status: 'ACTIVE' },
          include: {
            phases: { orderBy: { order: 'asc' } },
            milestones: { orderBy: { targetDate: 'asc' } },
          },
        }),
      ]);

      res.json({
        patient: {
          id: patient.id,
          fullName: patient.fullName,
          dob: patient.dob,
          gender: patient.gender,
          phoneNumber: patient.phoneNumber,
          profilePhoto: patient.profilePhoto,
          email: patient.user?.email || null,
        },
        prescriptions,
        appointments,
        visitSummaries,
        triageSessions,
        painCheckIns: dailyCheckIns,
        latestVitals: Array.isArray(latestVitals) ? latestVitals : [],
        activeJourney,
      });
    } catch (err) {
      logger.error('[ConsultationContext] failed', { err: err.message });
      next(err);
    }
  },
);

export default router;
