import { initSentry, Sentry } from './lib/sentry.js';
import dotenv from 'dotenv';
dotenv.config();
initSentry();

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import config from './config/index.js';
import logger from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { globalLimiter } from './middleware/rateLimiter.js';
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
import gamificationRoutes from './routes/gamification.js';
import timelineRoutes from './routes/timeline.js';
import refillRoutes from './routes/refill.js';
import featureFlagRoutes from './routes/feature-flags.js';
import referralRoutes from './routes/referrals.js';
import retentionChecklistRoutes from './routes/retention-checklist.js';
import journeyRoutes from './routes/journey.js';
import searchRoutes from './routes/search.js';
import slotOptimizationRoutes from './routes/slotOptimization.js';
// New feature routes
import operationsRoutes from './routes/operations.js';
import clinicianGamificationRoutes from './routes/clinician-gamification.js';
import patientGamificationRoutes from './routes/patient-gamification.js';
import announcementRoutes from './routes/announcements.js';
import handoffRoutes from './routes/handoff.js';
import portalRoutes from './routes/portal.js';
import visitSummaryRoutes from './routes/visit-summary.js';

import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';
import { initializeWebSocket } from './websocket/index.js';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/dist/queueAdapters/bullMQ.js';
import { ExpressAdapter } from '@bull-board/express';
import { initScheduledJobs, getScheduledJobsQueue } from './services/scheduledJobs.service.js';
import { FeatureFlagService } from './services/feature-flag.service.js';

const app = express();
const httpServer = createServer(app);

// Attach a unique request ID for log tracing
app.use((req, res, next) => {
  req.id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  res.setHeader('X-Request-Id', req.id);
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

// Global rate limiter for all API routes — per-endpoint auth limiters are in routes/auth.js
app.use('/api/', globalLimiter);

app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// Structured request/response logger (after body parsers, before routes)
app.use(requestLogger);

// Detailed health check endpoint
app.get('/health', async (req, res) => {
  try {
    const { default: prisma } = await import('./lib/prisma.js');
    const { cacheService } = await import('./services/cache.service.js');

    // Check database
    let dbStatus = 'disconnected';
    let pendingMigrations = 0;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = 'connected';
    } catch {}

    // Check Redis
    const redisStatus = cacheService.getStatus();

    res.status(200).json({
      status: 'ok',
      database: dbStatus,
      pendingMigrations,
      redisConnected: redisStatus.connected,
      redisCircuitOpen: redisStatus.circuitOpen,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(200).json({ status: 'ok' });
  }
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
app.use('/api/gamification', gamificationRoutes);
app.use('/api/patients', timelineRoutes);
app.use('/api/refills', refillRoutes);
app.use('/api/feature-flags', featureFlagRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/retention-checklist', retentionChecklistRoutes);
app.use('/api/journeys', journeyRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/slot-optimization', slotOptimizationRoutes);
// New feature routes
app.use('/api/operations', operationsRoutes);
app.use('/api/clinician-gamification', clinicianGamificationRoutes);
app.use('/api/patient-gamification', patientGamificationRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/handoff', handoffRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/visit-summary', visitSummaryRoutes);

// Bull Board admin dashboard — admin-only (lazy: only mounts if queues are available)
import { authMiddleware as authMw, roleMiddleware as roleMw } from './middleware/auth.js';
import { getBullBoardQueues } from './services/queue.service.js';
try {
  const bullQueues = getBullBoardQueues();
  const scheduledQ = getScheduledJobsQueue();
  if (scheduledQ) bullQueues.push(scheduledQ);
  if (bullQueues.length > 0) {
    const bullBoardAdapter = new ExpressAdapter();
    bullBoardAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: bullQueues.map(q => new BullMQAdapter(q)),
      serverAdapter: bullBoardAdapter,
    });
    app.use('/admin/queues', authMw, roleMw(['ADMIN']), bullBoardAdapter.getRouter());
  }
} catch (e) {
  logger.warn('Bull Board not mounted — queues unavailable');
}

// Redundant static serving removed for standalone architecture

// Swagger API docs
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Al-Shifa API Documentation',
}));

// Also serve the raw spec
app.get('/api/docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
});

// Sentry error handler — must be before the app error handler
app.use(Sentry.expressErrorHandler());

// Global error handler — imported from middleware/errorHandler.js
app.use(errorHandler);

const PORT = config.server.port;

// Initialize WebSocket server
initializeWebSocket(httpServer);

// Initialize scheduled jobs (BullMQ with node-cron fallback)
initScheduledJobs().catch(err => logger.error('Scheduled jobs init failed', err));

// Seed default feature flags (idempotent — safe to run every startup)
FeatureFlagService.seedDefaults().catch(err => logger.error('Feature flag seed failed', err));

httpServer.listen(PORT, () => {
  logger.info(`Backend server running on port ${PORT}`, { env: process.env.NODE_ENV });
  logger.info('WebSocket server initialized');
  logger.info('Scheduler service running');
});
