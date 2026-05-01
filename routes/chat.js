import express from 'express';
import { z } from 'zod';
import { ChatService } from '../services/chat.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import prisma from '../lib/prisma.js';

const router = express.Router();

// All chat endpoints require an authenticated staff or patient role.
const CHAT_ROLES = ['PATIENT', 'DOCTOR', 'ADMIN_DOCTOR', 'THERAPIST', 'PHARMACIST', 'ADMIN'];
router.use(authMiddleware);
router.use(roleMiddleware(CHAT_ROLES));

const initiateSchema = z.object({
  partnerId: z.string().min(1).max(64),
});

// At least one clinician id must be present. Patients are restricted to
// their own patientId by `enforcePatientSelfOnConversation`.
const conversationSchema = z.object({
  patientId:    z.string().min(1).max(64).optional(),
  doctorId:     z.string().min(1).max(64).optional(),
  therapistId:  z.string().min(1).max(64).optional(),
  pharmacistId: z.string().min(1).max(64).optional(),
}).refine(
  (b) => b.doctorId || b.therapistId || b.pharmacistId,
  { message: 'one of doctorId / therapistId / pharmacistId is required' },
);

// When a PATIENT initiates a conversation via /conversation, they must match
// their own patientId — clinicians can specify any patient they're allowed to see.
async function enforcePatientSelfOnConversation(req, res, next) {
  if (req.user.role !== 'PATIENT') return next();
  const { patientId } = req.body || {};
  if (!patientId) return next();
  try {
    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      select: { userId: true },
    });
    if (!patient || patient.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden — patient id does not match caller' });
    }
    next();
  } catch (err) { next(err); }
}

/**
 * @swagger
 * /chat/initiate:
 *   post:
 *     tags: [Chat]
 *     summary: Initiate a chat conversation with another user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [partnerId]
 *             properties:
 *               partnerId: { type: string }
 *     responses:
 *       200: { description: Conversation created or returned }
 */
router.post('/initiate', validate({ body: initiateSchema }), async (req, res, next) => {
    try {
        const { partnerId } = req.body;
        const conversation = await ChatService.initiateConversation(req.user.id, partnerId);
        res.json(conversation);
    } catch (err) {
        next(err);
    }
});

/**
 * @swagger
 * /chat/conversation:
 *   post:
 *     tags: [Chat]
 *     summary: Get or create a conversation between patient and clinician
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               patientId: { type: string }
 *               doctorId: { type: string }
 *               therapistId: { type: string }
 *               pharmacistId: { type: string }
 *     responses:
 *       200: { description: Conversation returned }
 */
router.post('/conversation', validate({ body: conversationSchema }), enforcePatientSelfOnConversation, async (req, res, next) => {
    try {
        const { patientId, doctorId, therapistId, pharmacistId } = req.body;

        // Determine clinician type from whichever ID was provided
        let targetId, clinicianType;
        if (therapistId) {
            targetId = therapistId;
            clinicianType = 'THERAPIST';
        } else if (pharmacistId) {
            targetId = pharmacistId;
            clinicianType = 'PHARMACIST';
        } else {
            targetId = doctorId;
            clinicianType = 'DOCTOR';
        }

        const conversation = await ChatService.getOrCreateConversation(
            patientId,
            targetId,
            clinicianType
        );
        res.json(conversation);
    } catch (err) {
        next(err);
    }
});

/**
 * @swagger
 * /chat/conversations:
 *   get:
 *     tags: [Chat]
 *     summary: List all conversations for the authenticated user
 *     responses:
 *       200: { description: Array of conversations }
 */
router.get('/conversations', async (req, res, next) => {
    try {
        const conversations = await ChatService.listUserConversations(req.user.id);
        res.json(conversations);
    } catch (err) {
        next(err);
    }
});

/**
 * @swagger
 * /chat/messages/{conversationId}:
 *   get:
 *     tags: [Chat]
 *     summary: Get messages for a conversation
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200: { description: Paginated messages }
 *       403: { description: Unauthorized access to conversation }
 */
router.get('/messages/:conversationId', async (req, res, next) => {
    try {
        const { cursor, limit } = req.query;
        const result = await ChatService.getMessages(
            req.params.conversationId,
            req.user.id,
            { cursor, limit: limit ? parseInt(limit, 10) : 50 }
        );
        res.json(result);
    } catch (err) {
        if (err.message.includes('Unauthorized')) {
            return res.status(403).json({ error: err.message });
        }
        next(err);
    }
});

export default router;
