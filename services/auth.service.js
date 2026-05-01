import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import config from '../config/index.js';
import logger from '../lib/logger.js';
import { cacheService } from './cache.service.js';
import { emailService } from './email.service.js';
import { StreakService } from './streak.service.js';

const BCRYPT_ROUNDS = 12;

export class AuthService {
    // ── 1.1 Registration ─────────────────────────────────────────────────────────

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

        const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const user = await prisma.user.create({
            data: { email, password: hashed, role, branchId: data.branchId }
        });

        // Send verification email for patients
        try {
            await this._sendVerificationEmail(user);
        } catch (err) {
            logger.error('Failed to send verification email', err, { userId: user.id });
        }

        return { id: user.id, email: user.email, role: user.role, branchId: user.branchId };
    }

    // ── 1.1 Login ────────────────────────────────────────────────────────────────

    /**
     * Stamp the staff-activity feed so the user flips to ONLINE on the
     * admin dashboard the moment they authenticate. Best-effort — patients
     * are excluded (the feed only renders staff roles), and failures must
     * never block the login flow.
     */
    static async _recordLoginActivity(user) {
        if (!user || user.role === 'PATIENT') return;
        try {
            const { StaffActivityService } = await import('./staffActivity.service.js');
            await StaffActivityService.recordActivity(user.id, 'LOGIN', user.branchId || null);
        } catch (err) {
            logger.warn('[auth] failed to record LOGIN staff activity', { userId: user.id, err: err.message });
        }
    }

    static async login({ email, password }, { ip, userAgent } = {}) {
        const user = await prisma.user.findUnique({ where: { email } });

        if (!user || user.deletedAt) {
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

        // Block login for unverified patients (staff bypass for operational safety)
        if (user.role === 'PATIENT' && !user.emailVerifiedAt) {
            const error = new Error('Please verify your email before logging in');
            error.status = 403;
            error.code = 'EMAIL_NOT_VERIFIED';
            throw error;
        }

        // If MFA is enabled, return a temp token instead of real tokens
        if (user.mfaEnabled) {
            const tempToken = jwt.sign(
                { id: user.id, purpose: 'mfa' },
                config.jwt.secret,
                { expiresIn: '5m' }
            );
            return { mfaRequired: true, tempToken };
        }

        await this._bumpPatientStreakOnLogin(user);
        const tokens = await this._issueTokens(user, { ip, userAgent });
        await this._recordLoginActivity(user);
        return tokens;
    }

    // ── 1.1 Refresh Token Rotation ───────────────────────────────────────────────

    static async refresh(refreshToken, { ip, userAgent } = {}) {
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

        const tokenHash = this._hashToken(refreshToken);

        const tokenRecord = await prisma.refreshToken.findUnique({
            where: { tokenHash }
        });

        if (!tokenRecord) {
            const error = new Error('Invalid refresh token');
            error.status = 401;
            throw error;
        }

        if (tokenRecord.expiresAt < new Date()) {
            const error = new Error('Refresh token expired');
            error.status = 401;
            throw error;
        }

        const rotation = await prisma.refreshToken.updateMany({
            where: { id: tokenRecord.id, revokedAt: null },
            data: { revokedAt: new Date() }
        });

        // updateMany.count === 0 means someone else already revoked this token
        // (concurrent refresh or replay). Treat as reuse: burn all sessions.
        if (rotation.count === 0) {
            logger.warn('Refresh token reuse detected — revoking all sessions', {
                userId: tokenRecord.userId, ip
            });
            await prisma.refreshToken.updateMany({
                where: { userId: tokenRecord.userId, revokedAt: null },
                data: { revokedAt: new Date() }
            });
            const error = new Error('Token reuse detected. All sessions revoked.');
            error.status = 401;
            throw error;
        }

        const user = await prisma.user.findUnique({
            where: { id: decoded.id },
            select: { id: true, email: true, role: true, branchId: true, hospitalId: true, deletedAt: true }
        });

        if (!user || user.deletedAt) {
            const error = new Error('User not found or deactivated');
            error.status = 401;
            throw error;
        }

        return this._issueTokens(user, { ip, userAgent });
    }

    // ── 1.1 Logout ───────────────────────────────────────────────────────────────

    static async logout(refreshToken, accessToken) {
        // Revoke the refresh token
        if (refreshToken) {
            const tokenHash = this._hashToken(refreshToken);
            await prisma.refreshToken.updateMany({
                where: { tokenHash, revokedAt: null },
                data: { revokedAt: new Date() }
            });
        }

        // Capture userId off the access token so we can stamp the staff
        // activity feed below. JTI blacklisting reuses the same decode.
        let userId = null;
        if (accessToken) {
            try {
                const decoded = jwt.decode(accessToken);
                if (decoded?.id) userId = decoded.id;
                if (decoded?.jti) {
                    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
                    if (ttl > 0) {
                        await cacheService.set(`jti:blacklist:${decoded.jti}`, true, ttl);
                    }
                }
            } catch {
                // Best effort — don't fail logout
            }
        }

        // Stamp the staff activity feed so the user flips to OFFLINE
        // immediately on the admin dashboard. Best-effort.
        if (userId) {
            try {
                const u = await prisma.user.findUnique({
                    where: { id: userId },
                    select: { role: true, branchId: true },
                });
                if (u && u.role !== 'PATIENT') {
                    const { StaffActivityService } = await import('./staffActivity.service.js');
                    await StaffActivityService.recordActivity(userId, 'LOGOUT', u.branchId || null);
                }
            } catch (err) {
                logger.warn('[auth] failed to record LOGOUT staff activity', { userId, err: err.message });
            }
        }
    }

    // ── 1.1 Logout All Sessions ──────────────────────────────────────────────────

    static async logoutAll(userId) {
        const now = new Date();
        await prisma.$transaction([
            prisma.refreshToken.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: now }
            }),
            prisma.user.update({
                where: { id: userId },
                data: { tokensRevokedAt: now }
            })
        ]);
    }

    // ── 1.2 Email Verification ───────────────────────────────────────────────────

    static async verifyEmail(token) {
        const { userId, valid } = this._verifyHmacToken(token, 'email-verify');
        if (!valid) {
            const error = new Error('Invalid or expired verification token');
            error.status = 400;
            throw error;
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            const error = new Error('User not found');
            error.status = 404;
            throw error;
        }

        if (user.emailVerifiedAt) {
            return { message: 'Email already verified' };
        }

        await prisma.user.update({
            where: { id: userId },
            data: { emailVerifiedAt: new Date() }
        });

        return { message: 'Email verified successfully' };
    }

    static async resendVerification(email) {
        const user = await prisma.user.findUnique({ where: { email } });
        // Always return success (never reveal email existence)
        if (!user || user.emailVerifiedAt) {
            return { message: 'If account exists and is unverified, email sent' };
        }

        try {
            await this._sendVerificationEmail(user);
        } catch (err) {
            logger.error('Failed to resend verification email', err, { userId: user.id });
        }

        return { message: 'If account exists and is unverified, email sent' };
    }

    // ── 1.3 Password Reset ──────────────────────────────────────────────────────

    static async forgotPassword(email) {
        const user = await prisma.user.findUnique({ where: { email } });
        // Always return 200 — never reveal if email exists
        if (!user) {
            return { message: 'If account exists, password reset email sent' };
        }

        // Generate a random reset token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = this._hashToken(rawToken);

        // Store hashed token in DB (expires 1 hour)
        await prisma.passwordResetToken.create({
            data: {
                tokenHash,
                userId: user.id,
                expiresAt: new Date(Date.now() + 60 * 60 * 1000) // 1 hour
            }
        });

        // Send email with reset link
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
        const resetLink = `${frontendUrl}/reset-password?token=${rawToken}`;

        try {
            await emailService.sendNotification(
                user.email,
                'Password Reset Request',
                `Click the link below to reset your password. This link expires in 1 hour.\n\n${resetLink}\n\nIf you did not request this, please ignore this email.`
            );
        } catch (err) {
            logger.error('Failed to send password reset email', err, { userId: user.id });
        }

        return { message: 'If account exists, password reset email sent' };
    }

    static async resetPassword(token, newPassword) {
        const tokenHash = this._hashToken(token);
        const tokenRecord = await prisma.passwordResetToken.findUnique({
            where: { tokenHash }
        });

        if (!tokenRecord || tokenRecord.usedAt || tokenRecord.expiresAt < new Date()) {
            const error = new Error('Invalid or expired reset token');
            error.status = 400;
            throw error;
        }

        // Hash new password with bcrypt rounds=12
        const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

        const now = new Date();
        await prisma.$transaction([
            prisma.user.update({
                where: { id: tokenRecord.userId },
                data: { password: hashed, tokensRevokedAt: now }
            }),
            prisma.passwordResetToken.update({
                where: { id: tokenRecord.id },
                data: { usedAt: now }
            }),
            prisma.refreshToken.updateMany({
                where: { userId: tokenRecord.userId, revokedAt: null },
                data: { revokedAt: now }
            })
        ]);

        return { message: 'Password reset successfully' };
    }

    // ── 1.4 MFA — TOTP ─────────────────────────────────────────────────────────

    static async mfaSetup(userId) {
        const { authenticator } = await import('otplib');
        const QRCode = await import('qrcode');

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            const error = new Error('User not found');
            error.status = 404;
            throw error;
        }

        const secret = authenticator.generateSecret();
        const issuer = process.env.MFA_ISSUER || 'Al-Shifa Healthcare';
        const otpauth = authenticator.keyuri(user.email, issuer, secret);
        const qrCodeUrl = await QRCode.toDataURL(otpauth);

        // Store secret temporarily (not enabled until verified)
        await prisma.user.update({
            where: { id: userId },
            data: { mfaSecret: secret }
        });

        return { secret, qrCodeUrl, otpauth };
    }

    static async mfaVerifySetup(userId, totpCode) {
        const { authenticator } = await import('otplib');

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || !user.mfaSecret) {
            const error = new Error('MFA setup not initiated');
            error.status = 400;
            throw error;
        }

        const isValid = authenticator.check(totpCode, user.mfaSecret);
        if (!isValid) {
            const error = new Error('Invalid TOTP code');
            error.status = 400;
            throw error;
        }

        // Generate 10 backup codes
        const backupCodes = Array.from({ length: 10 }, () =>
            crypto.randomBytes(4).toString('hex').toUpperCase()
        );
        const hashedBackupCodes = await Promise.all(
            backupCodes.map(code => bcrypt.hash(code, BCRYPT_ROUNDS))
        );

        await prisma.user.update({
            where: { id: userId },
            data: { mfaEnabled: true, mfaBackupCodes: hashedBackupCodes }
        });

        return { message: 'MFA enabled successfully', backupCodes };
    }

    static async mfaValidate(tempToken, totpCode, { ip, userAgent } = {}) {
        let decoded;
        try {
            decoded = jwt.verify(tempToken, config.jwt.secret);
        } catch {
            const error = new Error('Invalid or expired MFA token');
            error.status = 401;
            throw error;
        }

        if (decoded.purpose !== 'mfa') {
            const error = new Error('Invalid token purpose');
            error.status = 401;
            throw error;
        }

        const user = await prisma.user.findUnique({ where: { id: decoded.id } });
        if (!user || !user.mfaEnabled || !user.mfaSecret) {
            const error = new Error('MFA not configured');
            error.status = 400;
            throw error;
        }

        const { authenticator } = await import('otplib');
        let isValid = authenticator.check(totpCode, user.mfaSecret);

        if (!isValid) {
            for (let i = 0; i < user.mfaBackupCodes.length; i++) {
                const match = await bcrypt.compare(totpCode, user.mfaBackupCodes[i]);
                if (match) {
                    const usedHash = user.mfaBackupCodes[i];
                    const consumed = await prisma.$transaction(async (tx) => {
                        const current = await tx.user.findUnique({
                            where: { id: user.id },
                            select: { mfaBackupCodes: true }
                        });
                        const idx = current?.mfaBackupCodes?.indexOf(usedHash) ?? -1;
                        if (idx === -1) return false;
                        const updatedCodes = [...current.mfaBackupCodes];
                        updatedCodes.splice(idx, 1);
                        await tx.user.update({
                            where: { id: user.id },
                            data: { mfaBackupCodes: updatedCodes }
                        });
                        return true;
                    });
                    if (consumed) isValid = true;
                    break;
                }
            }
        }

        if (!isValid) {
            const error = new Error('Invalid TOTP code');
            error.status = 401;
            throw error;
        }

        await this._bumpPatientStreakOnLogin(user);
        const tokens = await this._issueTokens(user, { ip, userAgent });
        await this._recordLoginActivity(user);
        return tokens;
    }

    static async mfaDisable(userId, password) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            const error = new Error('User not found');
            error.status = 404;
            throw error;
        }

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            const error = new Error('Invalid password');
            error.status = 401;
            throw error;
        }

        await prisma.user.update({
            where: { id: userId },
            data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] }
        });

        return { message: 'MFA disabled successfully' };
    }

    // ── 1.5 JTI Blacklist Check ──────────────────────────────────────────────────

    static async isJtiBlacklisted(jti) {
        if (!jti) return false;
        const blacklisted = await cacheService.get(`jti:blacklist:${jti}`);
        return !!blacklisted;
    }

    // ── Private Helpers ─────────────────────────────────────────────────────────

    /**
     * Treat a successful patient login as an "active day" so the dashboard
     * streak advances. Best-effort: any failure is logged but never blocks
     * login. No-op for non-patient roles (clinician streaks have a separate
     * activity definition driven by the daily scheduler).
     */
    static async _bumpPatientStreakOnLogin(user) {
        if (user.role !== 'PATIENT') return;
        try {
            const patient = await prisma.patient.findUnique({
                where: { userId: user.id },
                select: { id: true }
            });
            if (!patient) return;
            await StreakService.updatePatientStreak(patient.id);
        } catch (err) {
            logger.error('Failed to bump patient streak on login', err, { userId: user.id });
        }
    }

    static async _issueTokens(user, { ip, userAgent } = {}) {
        const jti = crypto.randomUUID();

        const accessToken = jwt.sign(
            { id: user.id, role: user.role, branchId: user.branchId, hospitalId: user.hospitalId ?? null, jti },
            config.jwt.secret,
            { expiresIn: config.jwt.expiresIn }
        );

        const refreshToken = jwt.sign(
            { id: user.id },
            config.jwt.refreshSecret,
            { expiresIn: config.jwt.refreshExpiresIn }
        );

        // Store refresh token hash in DB
        const tokenHash = this._hashToken(refreshToken);
        const decoded = jwt.decode(refreshToken);
        await prisma.refreshToken.create({
            data: {
                tokenHash,
                userId: user.id,
                expiresAt: new Date(decoded.exp * 1000),
                deviceInfo: userAgent || null,
                ipAddress: ip || null
            }
        });

        // Store JTI in Redis for blacklist checking
        const accessDecoded = jwt.decode(accessToken);
        const ttl = accessDecoded.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
            await cacheService.set(`jti:active:${jti}`, user.id, ttl);
        }

        return {
            accessToken,
            refreshToken,
            user: { id: user.id, email: user.email, role: user.role, branchId: user.branchId }
        };
    }

    static _hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    static _generateHmacToken(userId, purpose, expiresInMs = 24 * 60 * 60 * 1000) {
        const timestamp = Date.now();
        const payload = `${userId}:${purpose}:${timestamp}`;
        const hmac = crypto.createHmac('sha256', config.jwt.secret)
            .update(payload)
            .digest('hex');
        const token = Buffer.from(JSON.stringify({ userId, purpose, timestamp, hmac }))
            .toString('base64url');
        return { token, expiresAt: new Date(timestamp + expiresInMs) };
    }

    static _verifyHmacToken(token, expectedPurpose, maxAgeMs = 24 * 60 * 60 * 1000) {
        try {
            const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
            const { userId, purpose, timestamp, hmac } = decoded;

            if (purpose !== expectedPurpose) return { valid: false };
            if (Date.now() - timestamp > maxAgeMs) return { valid: false };

            const expected = crypto.createHmac('sha256', config.jwt.secret)
                .update(`${userId}:${purpose}:${timestamp}`)
                .digest('hex');

            if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
                return { valid: false };
            }

            return { userId, valid: true };
        } catch {
            return { valid: false };
        }
    }

    static async _sendVerificationEmail(user) {
        const { token } = this._generateHmacToken(user.id, 'email-verify');
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
        const verifyLink = `${frontendUrl}/verify-email?token=${token}`;

        await emailService.sendNotification(
            user.email,
            'Verify Your Email — Al-Shifa Healthcare',
            `Welcome! Please verify your email address by clicking the link below. This link expires in 24 hours.\n\n${verifyLink}`
        );
    }
}
