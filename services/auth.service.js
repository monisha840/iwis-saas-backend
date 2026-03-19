import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import prisma from '../lib/prisma.js';
import config from '../config/index.js';

export class AuthService {
    static async register(data) {
        const { email, password, role } = data;
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            const error = new Error('Email already registered');
            error.status = 409;
            throw error;
        }

        if (data.branchId) {
            const branch = await prisma.branch.findUnique({ where: { id: data.branchId } });
            if (!branch) {
                const error = new Error('Invalid branchId');
                error.status = 400;
                throw error;
            }
        }

        const hashed = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: { email, password: hashed, role, branchId: data.branchId }
        });

        return { id: user.id, email: user.email, role: user.role, branchId: user.branchId };
    }

    static async login({ email, password }) {
        const user = await prisma.user.findUnique({ where: { email } });

        if (!user) {
            const error = new Error('Invalid credentials');
            error.status = 401;
            throw error;
        }

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            const error = new Error('Invalid credentials');
            error.status = 401;
            throw error;
        }

        const accessToken = jwt.sign(
            { id: user.id, role: user.role, branchId: user.branchId },
            config.jwt.secret,
            { expiresIn: config.jwt.expiresIn }
        );

        const refreshToken = jwt.sign(
            { id: user.id },
            config.jwt.refreshSecret,
            { expiresIn: config.jwt.refreshExpiresIn }
        );

        return {
            accessToken,
            refreshToken,
            user: { id: user.id, email: user.email, role: user.role, branchId: user.branchId }
        };
    }

    /**
     * Verify a refresh token and issue a new access token.
     * Called by POST /api/auth/refresh.
     */
    static async refresh(refreshToken) {
        if (!refreshToken) {
            const error = new Error('Refresh token required');
            error.status = 401;
            throw error;
        }

        let decoded;
        try {
            decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
        } catch {
            const error = new Error('Invalid or expired refresh token');
            error.status = 401;
            throw error;
        }

        const user = await prisma.user.findUnique({
            where: { id: decoded.id },
            select: { id: true, email: true, role: true, branchId: true, deletedAt: true }
        });

        if (!user || user.deletedAt) {
            const error = new Error('User not found or deactivated');
            error.status = 401;
            throw error;
        }

        const accessToken = jwt.sign(
            { id: user.id, role: user.role, branchId: user.branchId },
            config.jwt.secret,
            { expiresIn: config.jwt.expiresIn }
        );

        return { accessToken };
    }
}
