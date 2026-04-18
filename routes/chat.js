import express from 'express';
import { ChatService } from '../services/chat.service.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

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
router.post('/initiate', authMiddleware, async (req, res, next) => {
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
router.post('/conversation', authMiddleware, async (req, res, next) => {
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
router.get('/conversations', authMiddleware, async (req, res, next) => {
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
router.get('/messages/:conversationId', authMiddleware, async (req, res, next) => {
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
