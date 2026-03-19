import express from 'express';
import { z } from 'zod';
import { AuthService } from '../services/auth.service.js';
import { validate } from '../middleware/validate.js';

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

router.post('/login', validate({ body: loginSchema }), async (req, res, next) => {
  try {
    const result = await AuthService.login(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh — exchange a valid refresh token for a new access token.
// No authentication middleware required (the refresh token IS the credential).
const refreshSchema = z.object({
  refreshToken: z.string()
});

router.post('/refresh', validate({ body: refreshSchema }), async (req, res, next) => {
  try {
    const { accessToken } = await AuthService.refresh(req.body.refreshToken);
    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
});

export default router;
