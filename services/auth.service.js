import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import prisma from '../lib/prisma.js';

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
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        const refreshToken = jwt.sign(
            { id: user.id },
            process.env.JWT_REFRESH_SECRET,
            { expiresIn: '7d' }
        );

        return {
            accessToken,
            refreshToken,
            user: { id: user.id, email: user.email, role: user.role, branchId: user.branchId }
        };
    }
}
