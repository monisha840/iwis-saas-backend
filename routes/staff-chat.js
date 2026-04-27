/**
 * /api/staff-chat — staff DMs and branch group chats.
 *
 * Distinct from /api/chat (patient-clinician). Auth + staff-role gate on every
 * route; service layer enforces hospital tenancy and per-thread membership.
 */

import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { auditAction } from '../middleware/auditLog.js';
import { StaffChatService } from '../services/staffChat.service.js';
import { emitToUser } from '../websocket/index.js';
import logger from '../lib/logger.js';

const router = express.Router();
const STAFF_ROLES = ['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR', 'THERAPIST', 'PHARMACIST'];

router.use(authMiddleware);
router.use(roleMiddleware(STAFF_ROLES));

function handleZod(res, err) {
    if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    return null;
}

function handleService(res, err, next) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
}

/* ─── Directory ───────────────────────────────────────────────────────── */

router.get('/users', async (req, res, next) => {
    try {
        const list = await StaffChatService.listAddressableStaff(req.user.id, {
            branchId: req.query.branchId || undefined,
            search: req.query.search || undefined,
        });
        res.json({ users: list });
    } catch (err) { handleService(res, err, next); }
});

/* ─── Threads ─────────────────────────────────────────────────────────── */

router.get('/threads', async (req, res, next) => {
    try {
        const threads = await StaffChatService.listThreadsForUser(req.user.id);
        res.json({ threads });
    } catch (err) { handleService(res, err, next); }
});

const directSchema = z.object({
    partnerUserId: z.string().min(1),
});
router.post('/threads/direct',
    auditAction('STAFF_CHAT_DM_OPEN', 'StaffThread', () => null),
    async (req, res, next) => {
        try {
            const body = directSchema.parse(req.body);
            const out = await StaffChatService.getOrCreateDirectThread(req.user.id, body.partnerUserId);
            res.status(201).json(out);
        } catch (err) {
            const z = handleZod(res, err); if (z) return;
            handleService(res, err, next);
        }
    },
);

const groupSchema = z.object({
    title: z.string().trim().min(2).max(80),
    branchId: z.string().nullable().optional(),
    memberUserIds: z.array(z.string().min(1)).max(100).optional(),
});
router.post('/threads/group',
    auditAction('STAFF_CHAT_GROUP_CREATE', 'StaffThread', () => null),
    async (req, res, next) => {
        try {
            const body = groupSchema.parse(req.body);
            const out = await StaffChatService.createGroupThread(req.user.id, {
                title: body.title,
                branchId: body.branchId ?? null,
                memberUserIds: body.memberUserIds || [],
            });
            res.status(201).json(out);
        } catch (err) {
            const z = handleZod(res, err); if (z) return;
            handleService(res, err, next);
        }
    },
);

router.get('/threads/:id', async (req, res, next) => {
    try {
        const detail = await StaffChatService.getThreadDetail(req.params.id, req.user.id);
        res.json(detail);
    } catch (err) { handleService(res, err, next); }
});

router.delete('/threads/:id',
    auditAction('STAFF_CHAT_GROUP_ARCHIVE', 'StaffThread', (req) => req.params.id),
    async (req, res, next) => {
        try {
            const out = await StaffChatService.archiveThread(req.params.id, req.user.id);
            res.json(out);
        } catch (err) { handleService(res, err, next); }
    },
);

/* ─── Messages ────────────────────────────────────────────────────────── */

router.get('/threads/:id/messages', async (req, res, next) => {
    try {
        const result = await StaffChatService.listMessages(req.params.id, req.user.id, {
            cursor: req.query.cursor || undefined,
            limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
        });
        res.json(result);
    } catch (err) { handleService(res, err, next); }
});

const messageSchema = z.object({ content: z.string().min(1).max(5000) });
router.post('/threads/:id/messages', async (req, res, next) => {
    try {
        const body = messageSchema.parse(req.body);
        const message = await StaffChatService.sendMessage(req.params.id, req.user.id, body.content);

        // Real-time fan-out via Socket.IO. Non-blocking — DB write already
        // succeeded, sockets are best-effort delivery for live UIs.
        try {
            const recipients = await StaffChatService.getNotifiableMemberIds(req.params.id, req.user.id);
            for (const userId of recipients) {
                emitToUser(userId, 'staff_chat_message', { threadId: req.params.id, message });
                emitToUser(userId, 'staff_chat_thread_updated', { threadId: req.params.id });
            }
            emitToUser(req.user.id, 'staff_chat_thread_updated', { threadId: req.params.id });
        } catch (sockErr) {
            logger.warn('[StaffChat] socket fan-out failed', { err: sockErr?.message });
        }

        res.status(201).json(message);
    } catch (err) {
        const z = handleZod(res, err); if (z) return;
        handleService(res, err, next);
    }
});

router.post('/threads/:id/read', async (req, res, next) => {
    try {
        await StaffChatService.markRead(req.params.id, req.user.id);
        res.json({ ok: true });
    } catch (err) { handleService(res, err, next); }
});

/* ─── Membership management ──────────────────────────────────────────── */

const addMemberSchema = z.object({ userId: z.string().min(1) });
router.post('/threads/:id/members',
    auditAction('STAFF_CHAT_GROUP_ADD_MEMBER', 'StaffThread', (req) => req.params.id),
    async (req, res, next) => {
        try {
            const body = addMemberSchema.parse(req.body);
            const out = await StaffChatService.addMember(req.params.id, req.user.id, body.userId);

            // Notify the newly-added member via socket so their thread list refreshes.
            try {
                emitToUser(body.userId, 'staff_chat_thread_updated', { threadId: req.params.id });
            } catch { /* best-effort */ }

            res.status(201).json(out);
        } catch (err) {
            const z = handleZod(res, err); if (z) return;
            handleService(res, err, next);
        }
    },
);

router.delete('/threads/:id/members/:userId',
    auditAction('STAFF_CHAT_GROUP_REMOVE_MEMBER', 'StaffThread', (req) => req.params.id),
    async (req, res, next) => {
        try {
            const out = await StaffChatService.removeMember(req.params.id, req.user.id, req.params.userId);

            try {
                emitToUser(req.params.userId, 'staff_chat_thread_updated', { threadId: req.params.id });
            } catch { /* best-effort */ }

            res.json(out);
        } catch (err) { handleService(res, err, next); }
    },
);

export default router;
