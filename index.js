import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import config from './config/index.js';
import logger from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
// ... other imports
import userRoutes from './routes/user.js';
import appointmentsRoutes from './routes/appointments.js';
import prescriptionRoutes from './routes/prescription.js';
import consultationRoutes from './routes/consultation.js';
import notificationRoutes from './routes/notifications.js';
import reportsRoutes from './routes/reports.js';
import bulkRoutes from './routes/bulk.js';
import pharmacyRoutes from './routes/pharmacy.js';
import triageRoutes from './routes/triage.js';
import wellnessRoutes from './routes/wellness.js';
import chatRoutes from './routes/chat.js';
import branchRoutes from './routes/branch.js';
import availabilityRoutes from './routes/availability.js';
import adherenceRoutes from './routes/adherence.js';
import leaderboardRoutes from './routes/leaderboard.js';
import timelineRoutes from './routes/timeline.js';
import refillRoutes from './routes/refill.js';
import featureFlagRoutes from './routes/feature-flags.js';
import referralRoutes from './routes/referrals.js';
import retentionChecklistRoutes from './routes/retention-checklist.js';

import { initializeWebSocket } from './websocket/index.js';
import { schedulerService } from './services/scheduler.service.js';
import { FeatureFlagService } from './services/feature-flag.service.js';

const app = express();
const httpServer = createServer(app);

// Attach a unique request ID for log tracing
app.use((req, res, next) => {
  req.id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Request Logger for Audit Traceability
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`, {
    requestId: req.id,
    origin: req.headers.origin,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });
  next();
});

// CORS must come first so preflight OPTIONS requests get Access-Control headers
// before rate limiters or helmet can intercept and respond without them.
app.use(cors({
  origin: config.cors.origins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Security Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://meet.jit.si"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "https://meet.jit.si", "wss://*.jit.si"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "https://*.youtube.com", "https://*.vimeo.com"],
      upgradeInsecureRequests: [],
    },
  },
}));

// Basic Rate Limiting — values from centralized config
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' }
});

// Stricter Rate Limiting for Auth
const authLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again after an hour' }
});

app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Auth routes
app.use('/api/auth', authRoutes);

// User profile routes
app.use('/api/user', userRoutes);

// Appointments routes
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/prescriptions', prescriptionRoutes);
app.use('/api/consultations', consultationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/bulk', bulkRoutes);
app.use('/api/pharmacy', pharmacyRoutes);
app.use('/api/triage', triageRoutes);
app.use('/api/wellness', wellnessRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/adherence', adherenceRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/patients', timelineRoutes);
app.use('/api/refills', refillRoutes);
app.use('/api/feature-flags', featureFlagRoutes);
app.use('/api/referrals', referralRoutes);app.use('/api/retention-checklist', retentionChecklistRoutes);

// Redundant static serving removed for standalone architecture

// Global error handler — imported from middleware/errorHandler.js
app.use(errorHandler);

const PORT = config.server.port;

// Initialize WebSocket server
initializeWebSocket(httpServer);

// Initialize scheduler for automated tasks
schedulerService.init();

// Seed default feature flags (idempotent — safe to run every startup)
FeatureFlagService.seedDefaults().catch(err => logger.error('Feature flag seed failed', err));

httpServer.listen(PORT, () => {
  logger.info(`Backend server running on port ${PORT}`, { env: process.env.NODE_ENV });
  logger.info('WebSocket server initialized');
  logger.info('Scheduler service running');
});
