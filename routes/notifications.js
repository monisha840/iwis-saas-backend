import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { notificationService } from '../services/notification.service.js';
import prisma from '../lib/prisma.js';

const router = express.Router();

router.get('/', authMiddleware, async (req, res, next) => {
    try {
        const userId = req.user.id;
        const unreadOnly = req.query.unreadOnly === 'true';

        // Support both legacy skip/take and new page/limit params
        const opts = { unreadOnly };
        if (req.query.skip != null || req.query.take != null) {
            opts.skip = parseInt(req.query.skip) || 0;
            opts.take = parseInt(req.query.take) || 20;
        } else {
            opts.page = parseInt(req.query.page) || 1;
            opts.limit = parseInt(req.query.limit) || 20;
        }

        const result = await notificationService.getUserNotifications(userId, opts);

        res.json(result);
    } catch (err) {
        next(err);
    }
});

router.put('/:id/read', authMiddleware, async (req, res, next) => {
    try {
        const notification = await notificationService.markAsRead(req.params.id);
        res.json(notification);
    } catch (err) {
        next(err);
    }
});

router.put('/read-all', authMiddleware, async (req, res, next) => {
    try {
        await notificationService.markAllAsRead(req.user.id);
        res.json({ message: 'All notifications marked as read' });
    } catch (err) {
        next(err);
    }
});

router.get('/preferences', authMiddleware, async (req, res, next) => {
    try {
        const prefs = await notificationService.getPreferences(req.user.id);
        res.json(prefs);
    } catch (err) {
        next(err);
    }
});

router.put('/preferences', authMiddleware, async (req, res, next) => {
    try {
        const prefs = await notificationService.updatePreferences(req.user.id, req.body);
        res.json(prefs);
    } catch (err) {
        next(err);
    }
});

router.get('/unread-count', authMiddleware, async (req, res, next) => {
    try {
        const count = await notificationService.getUnreadCount(req.user.id);
        res.json({ count });
    } catch (err) {
        next(err);
    }
});

router.get('/delivery-stats', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const { from, to } = req.query;
        const where = {};
        if (from || to) {
            where.createdAt = {};
            if (from) where.createdAt.gte = new Date(from);
            if (to) where.createdAt.lte = new Date(to);
        }

        const stats = await prisma.notificationDelivery.groupBy({
            by: ['channel', 'status'],
            where,
            _count: { id: true },
        });

        const failures = await prisma.notificationDelivery.findMany({
            where: { ...where, status: 'FAILED' },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
                id: true, channel: true, errorMessage: true, createdAt: true,
                notification: { select: { type: true, title: true, userId: true } }
            }
        });

        res.json({ stats, recentFailures: failures });
    } catch (err) {
        next(err);
    }
});

export default router;
