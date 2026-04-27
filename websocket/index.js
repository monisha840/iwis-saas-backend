import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';
import config from '../config/index.js';
import logger from '../lib/logger.js';

let io;

/**
 * Initialize Socket.IO server with optional Redis adapter for horizontal scaling.
 */
export async function initializeWebSocket(httpServer) {
    io = new Server(httpServer, {
        cors: {
            origin: config.cors.origins,
            credentials: true,
        },
    });

    // Redis adapter for horizontal scaling (when REDIS_ADAPTER_ENABLED=true)
    if (process.env.REDIS_ADAPTER_ENABLED === 'true') {
        try {
            const { createAdapter } = await import('@socket.io/redis-adapter');
            const { createClient } = await import('redis');
            const pubClient = createClient({ url: process.env.REDIS_URL });
            const subClient = pubClient.duplicate();
            await Promise.all([pubClient.connect(), subClient.connect()]);
            io.adapter(createAdapter(pubClient, subClient));
            logger.info('Socket.IO Redis adapter enabled — horizontal scaling ready');
        } catch (err) {
            logger.warn('Socket.IO Redis adapter failed to initialize, using default adapter', { error: err.message });
        }
    }

    // Authentication middleware
    io.use((socket, next) => {
        const token = socket.handshake.auth.token;
        if (!token) {
            return next(new Error('Authentication error: No token provided'));
        }

        try {
            const decoded = jwt.verify(token, config.jwt.secret);
            socket.userId = decoded.id;
            socket.userRole = decoded.role;
            next();
        } catch (err) {
            next(new Error('Authentication error: Invalid token'));
        }
    });

    io.on('connection', (socket) => {
        console.log(`[WebSocket] User ${socket.userId} connected`);

        // Join user-specific room
        socket.join(`user:${socket.userId}`);

        // Also join role-specific rooms
        socket.join(`role:${socket.userRole}`);

        // Chat Handlers
        socket.on('join_conversation', async (conversationId) => {
            try {
                // Verify the requesting user is actually a participant of this conversation
                const conversation = await prisma.conversation.findFirst({
                    where: {
                        id: conversationId,
                        OR: [
                            { patient:    { userId: socket.userId } },
                            { doctor:     { userId: socket.userId } },
                            { therapist:  { userId: socket.userId } },
                            { pharmacist: { userId: socket.userId } },
                        ]
                    },
                    select: { id: true }
                });

                if (!conversation) {
                    socket.emit('error', { message: 'Unauthorized: You are not a participant of this conversation' });
                    return;
                }

                socket.join(`conversation:${conversationId}`);
                console.log(`[WebSocket] User ${socket.userId} joined conversation ${conversationId}`);
            } catch (err) {
                console.error('[WebSocket] Error joining conversation:', err);
                socket.emit('error', { message: 'Failed to join conversation' });
            }
        });

        socket.on('send_message', async ({ conversationId, content }) => {
            try {
                // Validate conversationId
                if (typeof conversationId !== 'string' || !conversationId.trim()) {
                    socket.emit('error', { message: 'Invalid conversationId' });
                    return;
                }

                // Validate content
                if (typeof content !== 'string') {
                    socket.emit('error', { message: 'Message content must be a string' });
                    return;
                }

                // Trim, sanitize (strip HTML tags to prevent XSS), and length-check
                content = content.trim().replace(/<[^>]*>/g, '');

                if (content.length === 0) {
                    socket.emit('error', { message: 'Message content cannot be empty' });
                    return;
                }
                if (content.length > 5000) {
                    socket.emit('error', { message: 'Message content exceeds 5000 character limit' });
                    return;
                }

                // Re-verify membership before writing — prevents message injection even if room
                // was joined via a different socket session or after role/membership change.
                const isMember = await prisma.conversation.findFirst({
                    where: {
                        id: conversationId,
                        OR: [
                            { patient:    { userId: socket.userId } },
                            { doctor:     { userId: socket.userId } },
                            { therapist:  { userId: socket.userId } },
                            { pharmacist: { userId: socket.userId } },
                        ]
                    },
                    select: { id: true }
                });

                if (!isMember) {
                    socket.emit('error', { message: 'Unauthorized' });
                    return;
                }

                // Persist message to DB
                const message = await prisma.message.create({
                    data: {
                        conversationId,
                        senderId: socket.userId,
                        content
                    },
                    include: {
                        sender: {
                            select: {
                                id: true,
                                email: true,
                                role: true,
                                doctor: { select: { fullName: true, profilePhoto: true } },
                                patient: { select: { fullName: true } },
                                therapist: { select: { fullName: true, profilePhoto: true } }
                            }
                        }
                    }
                });

                // Emit to the conversation room (delivers to everyone already viewing the chat)
                io.to(`conversation:${conversationId}`).emit('new_message', message);

                // Notify all participants via their personal user-room AND the persistent
                // notification pipeline.  The user-room `conversation_updated` event lets
                // the sidebar conversation list update in real-time even when the user has
                // not joined the conversation room.
                try {
                    const conv = await prisma.conversation.findUnique({
                        where: { id: conversationId },
                        select: {
                            patient:    { select: { userId: true } },
                            doctor:     { select: { userId: true } },
                            therapist:  { select: { userId: true } },
                            pharmacist: { select: { userId: true } },
                        }
                    });

                    if (conv) {
                        // Resolve a human-readable sender name from the already-fetched message include
                        const senderName =
                            message.sender?.doctor?.fullName ||
                            message.sender?.therapist?.fullName ||
                            message.sender?.patient?.fullName ||
                            message.sender?.email ||
                            'Someone';

                        // Collect participant userIds, excluding the sender
                        const recipientUserIds = [
                            conv.patient?.userId,
                            conv.doctor?.userId,
                            conv.therapist?.userId,
                            conv.pharmacist?.userId,
                        ].filter((uid) => uid && uid !== socket.userId);

                        // Emit a lightweight sidebar-update event to every participant's
                        // personal room so their conversation list stays current even when
                        // they have not opened this specific conversation.
                        for (const userId of recipientUserIds) {
                            io.to(`user:${userId}`).emit('conversation_updated', {
                                conversationId,
                                lastMessage: message,
                            });
                        }

                        // Create a persistent notification record and emit to each recipient
                        await Promise.all(recipientUserIds.map(async (userId) => {
                            try {
                                const preview = content.length > 80
                                    ? content.slice(0, 80) + '\u2026'
                                    : content;

                                const notification = await prisma.notification.create({
                                    data: {
                                        userId,
                                        type: 'NEW_MESSAGE',
                                        title: `New message from ${senderName}`,
                                        message: preview,
                                        priority: 'INFO',
                                        isRead: false,
                                        data: {
                                            conversationId,
                                            messageId: message.id,
                                            senderRole: socket.userRole,
                                        },
                                    },
                                });

                                // Deliver immediately to recipient's personal room so the
                                // NotificationContext socket listener picks it up in real-time
                                io.to(`user:${userId}`).emit('notification', notification);
                            } catch (perUserErr) {
                                // Non-critical per-recipient failure — log and continue
                                console.error(
                                    `[WebSocket] Message notification failed for user ${userId}:`,
                                    perUserErr.message
                                );
                            }
                        }));
                    }
                } catch (notifErr) {
                    // Notification delivery is best-effort; message was already persisted and emitted
                    console.error('[WebSocket] Failed to dispatch message notifications:', notifErr.message);
                }

                console.log(`[WebSocket] Message sent in ${conversationId} by ${socket.userId}`);
            } catch (err) {
                console.error('[WebSocket] Send message error:', err);
                socket.emit('error', { message: 'Failed to send message' });
            }
        });

        socket.on('typing', ({ conversationId, isTyping }) => {
            if (typeof conversationId !== 'string' || !conversationId.trim()) {
                socket.emit('error', { message: 'Invalid conversationId' });
                return;
            }
            if (typeof isTyping !== 'boolean') {
                socket.emit('error', { message: 'isTyping must be a boolean' });
                return;
            }

            socket.to(`conversation:${conversationId}`).emit('user_typing', {
                userId: socket.userId,
                isTyping
            });
        });

        // ── Live Patient Queue rooms ────────────────────────────────────
        // Two room patterns power the real-time queue board:
        //   queue:doctor:<doctorId>:date:<YYYY-MM-DD>  — the doctor's own
        //     Today's Queue panel; only that doctor (or admin/branch_admin
        //     within branch scope) may join.
        //   queue:branch:<branchId>:date:<YYYY-MM-DD>  — the admin / branch
        //     admin Live Queue Board; admins and clinicians within the
        //     branch may join.
        // Membership is verified server-side on join — clients cannot just
        // pick a room name and listen.
        socket.on('join_queue_doctor', async ({ doctorId, date }) => {
            try {
                if (typeof doctorId !== 'string' || !doctorId.trim()) return;
                const dateKey = typeof date === 'string' && date ? date : new Date().toISOString().slice(0, 10);

                // Doctors can only join their own queue room. Admin /
                // branch_admin / admin_doctor may join any doctor's room
                // within their branch (branch check handled at the route
                // layer when they fetch the queue).
                if (socket.userRole === 'DOCTOR') {
                    const me = await prisma.doctor.findUnique({
                        where: { userId: socket.userId },
                        select: { id: true },
                    });
                    if (!me || me.id !== doctorId) {
                        socket.emit('error', { message: 'Unauthorized: not your queue' });
                        return;
                    }
                } else if (!['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'SUPER_ADMIN'].includes(socket.userRole)) {
                    socket.emit('error', { message: 'Unauthorized: queue access denied' });
                    return;
                }

                socket.join(`queue:doctor:${doctorId}:date:${dateKey}`);
            } catch (err) {
                console.error('[WebSocket] Error joining doctor queue room:', err);
            }
        });

        socket.on('join_queue_branch', async ({ branchId, date }) => {
            try {
                if (typeof branchId !== 'string' || !branchId.trim()) return;
                const dateKey = typeof date === 'string' && date ? date : new Date().toISOString().slice(0, 10);

                // Admins / clinicians within a branch may listen on the
                // branch board. BRANCH_ADMIN can only join their own
                // assigned branch — verified against User.branchId.
                if (socket.userRole === 'BRANCH_ADMIN') {
                    const me = await prisma.user.findUnique({
                        where: { id: socket.userId },
                        select: { branchId: true },
                    });
                    if (!me || me.branchId !== branchId) {
                        socket.emit('error', { message: 'Unauthorized: not your branch' });
                        return;
                    }
                } else if (!['ADMIN', 'ADMIN_DOCTOR', 'SUPER_ADMIN', 'DOCTOR', 'THERAPIST'].includes(socket.userRole)) {
                    socket.emit('error', { message: 'Unauthorized: branch board access denied' });
                    return;
                }

                socket.join(`queue:branch:${branchId}:date:${dateKey}`);
            } catch (err) {
                console.error('[WebSocket] Error joining branch queue room:', err);
            }
        });

        socket.on('leave_queue_doctor', ({ doctorId, date }) => {
            const dateKey = typeof date === 'string' && date ? date : new Date().toISOString().slice(0, 10);
            socket.leave(`queue:doctor:${doctorId}:date:${dateKey}`);
        });

        socket.on('leave_queue_branch', ({ branchId, date }) => {
            const dateKey = typeof date === 'string' && date ? date : new Date().toISOString().slice(0, 10);
            socket.leave(`queue:branch:${branchId}:date:${dateKey}`);
        });

        socket.on('disconnect', () => {
            console.log(`[WebSocket] User ${socket.userId} disconnected`);
        });
    });

    console.log('[WebSocket] Server initialized');
    return io;
}

/**
 * Get Socket.IO instance
 */
export function getIO() {
    if (!io) {
        throw new Error('Socket.IO not initialized');
    }
    return io;
}

/**
 * Emit notification to a specific user
 */
export function emitToUser(userId, event, data) {
    if (!io) {
        console.warn('[WebSocket] Socket.IO not initialized');
        return;
    }

    io.to(`user:${userId}`).emit(event, data);
    console.log(`[WebSocket] Emitted ${event} to user ${userId}`);
}

/**
 * Emit to all users with a specific role
 */
export function emitToRole(role, event, data) {
    if (!io) {
        console.warn('[WebSocket] Socket.IO not initialized');
        return;
    }

    io.to(`role:${role}`).emit(event, data);
    console.log(`[WebSocket] Emitted ${event} to role ${role}`);
}

/**
 * Emit to all connected clients
 */
export function emitToAll(event, data) {
    if (!io) {
        console.warn('[WebSocket] Socket.IO not initialized');
        return;
    }

    io.emit(event, data);
    console.log(`[WebSocket] Emitted ${event} to all clients`);
}

/**
 * Emit a queue event to BOTH the doctor's queue room and the branch's
 * queue room for the given date — every state transition fans out to both
 * audiences in a single helper so callers can't forget either side.
 *
 * date may be a Date or YYYY-MM-DD string; defaults to today.
 */
export function emitToQueueRooms({ doctorId, branchId, date, event, data }) {
    if (!io) {
        console.warn('[WebSocket] Socket.IO not initialized');
        return;
    }
    let dateKey;
    if (date instanceof Date) {
        dateKey = date.toISOString().slice(0, 10);
    } else if (typeof date === 'string' && date) {
        dateKey = date.length >= 10 ? date.slice(0, 10) : date;
    } else {
        dateKey = new Date().toISOString().slice(0, 10);
    }

    if (doctorId) {
        io.to(`queue:doctor:${doctorId}:date:${dateKey}`).emit(event, data);
    }
    if (branchId) {
        io.to(`queue:branch:${branchId}:date:${dateKey}`).emit(event, data);
    }
}
