import express from 'express';
import { ChatService } from '../services/chat.service.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

router.post('/initiate', authMiddleware, async (req, res, next) => {
    try {
        const { partnerId } = req.body;
        const conversation = await ChatService.initiateConversation(req.user.id, partnerId);
        res.json(conversation);
    } catch (err) {
        next(err);
    }
});

router.post('/conversation', authMiddleware, async (req, res, next) => {
    try {
        const { patientId, doctorId, therapistId } = req.body;
        const conversation = await ChatService.getOrCreateConversation(
            patientId,
            doctorId || therapistId,
            !!therapistId
        );
        res.json(conversation);
    } catch (err) {
        next(err);
    }
});

router.get('/conversations', authMiddleware, async (req, res, next) => {
    try {
        const conversations = await ChatService.listUserConversations(req.user.id);
        res.json(conversations);
    } catch (err) {
        next(err);
    }
});

router.get('/messages/:conversationId', authMiddleware, async (req, res, next) => {
    try {
        const messages = await ChatService.getMessages(req.params.conversationId);
        res.json(messages);
    } catch (err) {
        next(err);
    }
});

export default router;
