import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';

let io;

/**
 * Initialize Socket.IO server
 */
export function initializeWebSocket(httpServer) {
    io = new Server(httpServer, {
        cors: {
            origin: [
                'http://localhost:5173',
                'http://localhost:8080',
                process.env.FRONTEND_URL,
            ].filter(Boolean),
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
        socket.on('join_conversation', (conversationId) => {
            socket.join(`conversation:${conversationId}`);
            console.log(`[WebSocket] User ${socket.userId} joined conversation ${conversationId}`);
        });

        socket.on('send_message', async ({ conversationId, content }) => {
            try {
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

                // Emit to the conversation room
                io.to(`conversation:${conversationId}`).emit('new_message', message);

                // Also notify participants if they aren't in the room? 
                // For now, simple room-based.

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
