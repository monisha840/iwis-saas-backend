import express from 'express';
import prisma from '../lib/prisma.js';
import { AdherenceService } from '../services/adherence.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';

const router = express.Router();

/**
 * Get today's medication schedule for the logged-in patient
 */
router.get('/today', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
    try {
        const patientRecord = await prisma.patient.findUnique({
            where: { userId: req.user.id },
            select: { id: true }
        });
        if (!patientRecord) return res.status(404).json({ message: "Patient profile not found" });

        const schedule = await AdherenceService.getTodaySchedule(patientRecord.id);
        res.json(schedule);
    } catch (err) {
        next(err);
    }
});

/**
 * Log adherence for a specific medication dose
 */
router.post('/log', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
    try {
        const patientRecord = await prisma.patient.findUnique({
            where: { userId: req.user.id },
            select: { id: true }
        });
        if (!patientRecord) return res.status(404).json({ message: "Patient profile not found" });

        const { prescriptionId, slot, scheduledTime, taken, notes, dateStr } = req.body;
        const result = await AdherenceService.logAdherence({
            patientId: patientRecord.id,
            prescriptionId,
            slot,
            scheduledTime,
            taken,
            notes,
            dateStr
        });
        res.json({ success: true, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * Get adherence statistics for a patient (accessible by patient, doctor, admin)
 */
router.get('/stats/:patientId', authMiddleware, roleMiddleware(['PATIENT', 'DOCTOR', 'THERAPIST', 'ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const { patientId } = req.params;
        const days = parseInt(req.query.days) || 30;

        // Permission check: Patient can only see their own stats
        if (req.user.role === 'PATIENT') {
            const patientRecord = await prisma.patient.findUnique({
                where: { userId: req.user.id },
                select: { id: true }
            });
            if (patientRecord?.id !== patientId) {
                return res.status(403).json({ message: "Access denied: You can only view your own statistics" });
            }
        }

        // IDOR protection: verify clinician is assigned to the patient
        if (req.user.role === 'DOCTOR' || req.user.role === 'THERAPIST') {
            const isAssigned = await prisma.appointment.findFirst({
                where: {
                    patientId,
                    status: { in: ['CONFIRMED', 'COMPLETED', 'ASSIGNED'] },
                    OR: [
                        { doctor: { userId: req.user.id } },
                        { therapist: { userId: req.user.id } },
                    ]
                }
            });
            if (!isAssigned) {
                const journeyAssigned = await prisma.journey.findFirst({
                    where: {
                        patientId,
                        OR: [
                            { doctor: { userId: req.user.id } },
                            { therapist: { userId: req.user.id } },
                        ]
                    }
                });
                if (!journeyAssigned) return res.status(403).json({ error: 'Forbidden: not assigned to this patient' });
            }
        }

        const stats = await AdherenceService.getAdherenceStats(patientId, days);
        res.json(stats);
    } catch (err) {
        next(err);
    }
});

export default router;
