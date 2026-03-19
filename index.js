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

import logger from './lib/logger.js';
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

import { initializeWebSocket } from './websocket/index.js';
import { schedulerService } from './services/scheduler.service.js';

const app = express();
const httpServer = createServer(app);

// Request Logger for Audit Traceability
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`, {
    origin: req.headers.origin,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });
  next();
});

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

// Basic Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' }
});

// Stricter Rate Limiting for Auth
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit each IP to 10 login attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again after an hour' }
});

app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:8080',
    'http://localhost:8081',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8081',
    process.env.FRONTEND_URL,
    // Support Render internal networking or same-origin requests
    '*.onrender.com'
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
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


// Redundant static serving removed for standalone architecture

// Global error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal Server Error'
    : err.message || 'Internal Server Error';

  logger.error(`API Error: ${req.method} ${req.url}`, err, {
    status,
    userId: req.user?.id,
    role: req.user?.role
  });

  res.status(status).json({
    error: message,
    ...(err.suggestedSlot && { suggestedSlot: err.suggestedSlot }),
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

const PORT = process.env.PORT || 4000;

// Initialize WebSocket server
initializeWebSocket(httpServer);

// Initialize scheduler for automated tasks
schedulerService.init();

httpServer.listen(PORT, () => {
  logger.info(`Backend server running on port ${PORT}`, { env: process.env.NODE_ENV });
  logger.info('WebSocket server initialized');
  logger.info('Scheduler service running');
});
