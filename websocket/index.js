import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';
import config from '../config/index.js';

let io;

/**
 * Initialize Socket.IO server
 */
export function initializeWebSocket(httpServer) {
    io = new Server(httpServer, {
        cors: {
            // Use same origin list as the HTTP API — single source of truth via config
            origin: config.cors.origins,
            credentials: true,
        },
    });

    // Authentication middleware
    io.use((socket, next) => {
        const token = socket.handshake.auth.token;
        if (!token) {
            return next(new Error('Authentication error: No token provided'));
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
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

                // Notify all other participants via the persistent notification pipeline.
                // This ensures the message surfaces in their notification panel and unread badge
                // even when they are not currently in the conversation room.
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
            socket.to(`conversation:${conversationId}`).emit('user_typing', {
                userId: socket.userId,
                isTyping
            });
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
