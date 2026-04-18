import express from 'express';
import { z } from 'zod';
import { AuthService } from '../services/auth.service.js';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  loginLimiter,
  refreshLimiter,
  passwordResetLimiter,
  verificationLimiter,
  mfaLimiter
} from '../middleware/rateLimiter.js';

const router = express.Router();

// Self-registration is restricted to PATIENT only.
// Staff accounts (DOCTOR, THERAPIST, ADMIN, etc.) must be provisioned by an admin
// via the authenticated POST /api/user/create-user endpoint.
const strongPassword = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

const registerSchema = z.object({
  email: z.string().email(),
  password: strongPassword,
  role: z.literal('PATIENT').default('PATIENT'),
  referralCode: z.string().optional()
});

/**
 * @swagger
 * /auth/register:
 *   post:
 *     tags: [Authentication]
 *     summary: Register a new patient account
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               referralCode: { type: string }
 *     responses:
 *       201: { description: Registration successful }
 *       400: { description: Validation error }
 *       409: { description: Email already exists }
 */
router.post('/register', validate({ body: registerSchema }), async (req, res, next) => {
  try {
    const user = await AuthService.register(req.body);
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

/**
 * @swagger
 * /auth/login:
 *   post:
 *     tags: [Authentication]
 *     summary: Login with email and password
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200: { description: Login successful, returns JWT tokens }
 *       401: { description: Invalid credentials }
 *       403: { description: Email not verified or MFA required }
 */
router.post('/login', loginLimiter, validate({ body: loginSchema }), async (req, res, next) => {
  try {
    const result = await AuthService.login(req.body, {
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh — exchange a valid refresh token for new tokens (rotation).
const refreshSchema = z.object({
  refreshToken: z.string()
});

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     tags: [Authentication]
 *     summary: Refresh access token
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200: { description: New token pair returned }
 *       401: { description: Invalid or revoked refresh token }
 */
router.post('/refresh', refreshLimiter, validate({ body: refreshSchema }), async (req, res, next) => {
  try {
    const result = await AuthService.refresh(req.body.refreshToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout — revoke specific device session
const logoutSchema = z.object({
  refreshToken: z.string().optional()
});

router.post('/logout', async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const accessToken = authHeader && authHeader.split(' ')[1];
    await AuthService.logout(req.body.refreshToken, accessToken);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout-all — revoke all sessions
router.post('/logout-all', authMiddleware, async (req, res, next) => {
  try {
    await AuthService.logoutAll(req.user.id);
    res.json({ message: 'All sessions revoked' });
  } catch (err) {
    next(err);
  }
});

// ── Email Verification ──────────────────────────────────────────────────────

router.get('/verify-email', async (req, res, next) => {
  try {
    const result = await AuthService.verifyEmail(req.query.token);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const resendVerificationSchema = z.object({
  email: z.string().email()
});

router.post('/resend-verification', verificationLimiter, validate({ body: resendVerificationSchema }), async (req, res, next) => {
  try {
    const result = await AuthService.resendVerification(req.body.email);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Password Reset ──────────────────────────────────────────────────────────

const forgotPasswordSchema = z.object({
  email: z.string().email()
});

router.post('/forgot-password', passwordResetLimiter, validate({ body: forgotPasswordSchema }), async (req, res, next) => {
  try {
    const result = await AuthService.forgotPassword(req.body.email);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const resetPasswordSchema = z.object({
  token: z.string(),
  password: strongPassword
});

router.post('/reset-password', passwordResetLimiter, validate({ body: resetPasswordSchema }), async (req, res, next) => {
  try {
    const result = await AuthService.resetPassword(req.body.token, req.body.password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── MFA / TOTP ──────────────────────────────────────────────────────────────

router.post('/mfa/setup', authMiddleware, async (req, res, next) => {
  try {
    const result = await AuthService.mfaSetup(req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const mfaVerifySetupSchema = z.object({
  code: z.string().length(6)
});

router.post('/mfa/verify-setup', authMiddleware, validate({ body: mfaVerifySetupSchema }), async (req, res, next) => {
  try {
    const result = await AuthService.mfaVerifySetup(req.user.id, req.body.code);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const mfaValidateSchema = z.object({
  tempToken: z.string(),
  code: z.string().min(6).max(8) // 6-digit TOTP or 8-char backup code
});

router.post('/mfa/validate', mfaLimiter, validate({ body: mfaValidateSchema }), async (req, res, next) => {
  try {
    const result = await AuthService.mfaValidate(req.body.tempToken, req.body.code, {
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const mfaDisableSchema = z.object({
  password: z.string().min(1)
});

router.post('/mfa/disable', authMiddleware, validate({ body: mfaDisableSchema }), async (req, res, next) => {
  try {
    const result = await AuthService.mfaDisable(req.user.id, req.body.password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
