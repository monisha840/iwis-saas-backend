import express from 'express';
import { z } from 'zod';
import { WellnessService } from '../services/wellness.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import prisma from '../lib/prisma.js';

const router = express.Router();

const checkInSchema = z.object({
    painLevel: z.number().min(0).max(10),
    sleepHours: z.number().min(0),
    mood: z.string(),
    notes: z.string().optional(),
});

const prescribeSchema = z.object({
    patientId: z.string(),
    videoId: z.string(),
    notes: z.string().optional(),
});

router.get('/stats', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
    try {
        const data = await WellnessService.getStats(req.user.id);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

router.post('/check-in', authMiddleware, roleMiddleware(['PATIENT']), validate({ body: checkInSchema }), async (req, res, next) => {
    try {
        const data = await WellnessService.submitCheckIn(req.user.id, req.body);
        res.json({ message: 'Check-in successful (+10 Zen Points)', data });
    } catch (err) {
        next(err);
    }
});

router.get('/videos', authMiddleware, async (req, res, next) => {
    try {
        const videos = await WellnessService.getVideos();
        res.json(videos);
    } catch (err) {
        next(err);
    }
});

router.get('/my-prescriptions', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
    try {
        const prescriptions = await WellnessService.getMyPrescriptions(req.user.id);
        res.json(prescriptions);
    } catch (err) {
        next(err);
    }
});

router.post('/prescribe', authMiddleware, roleMiddleware(['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR', 'ADMIN']), validate({ body: prescribeSchema }), async (req, res, next) => {
    try {
        const { patientId } = req.body;

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

        const prescription = await WellnessService.prescribeVideo(req.user.id, req.body);
        res.json({ message: 'Video prescribed successfully', prescription });
    } catch (err) {
        next(err);
    }
});

router.get('/my-medications', authMiddleware, roleMiddleware(['PATIENT']), async (req, res, next) => {
    try {
        const medications = await WellnessService.getMyMedications(req.user.id);
        res.json(medications);
    } catch (err) {
        next(err);
    }
});

const medicationLogSchema = z.object({
    prescriptionId: z.string(),
    quantityTaken: z.number().optional(),
    date: z.string().optional(),
    notes: z.string().optional(),
});

router.post('/medication-log', authMiddleware, roleMiddleware(['PATIENT']), validate({ body: medicationLogSchema }), async (req, res, next) => {
    try {
        const log = await WellnessService.submitMedicationLog(req.user.id, req.body);
        res.json({ message: 'Medication logged successfully', log });
    } catch (err) {
        next(err);
    }
});

export default router;
