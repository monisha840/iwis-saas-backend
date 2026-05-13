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
import feedbackRoutes from './routes/feedback.js';
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
import staffChatRoutes from './routes/staff-chat.js';
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
import enhancedDashboardRoutes from './routes/enhanced-dashboard.js';
import prescribedVitalsRoutes from './routes/prescribed-vitals.js';
import visitSummaryRoutes from './routes/visit-summary.js';
import queueRoutes from './routes/queue.js';
import consultationContextRoutes from './routes/consultation-context.js';
import superAdminRoutes from './routes/super-admin.js';
// IWIS competitor features
import therapyRoomRoutes from './routes/therapyRoom.js';
import dietPrescriptionRoutes from './routes/dietPrescription.js';
import dietPackageRoutes from './routes/dietPackage.js';
import clinicalPhotoRoutes from './routes/clinicalPhoto.js';
import therapistSkillRoutes from './routes/therapistSkill.js';
import treatmentPackageRoutes from './routes/treatmentPackage.js';
import groupSessionRoutes from './routes/groupSession.js';
import homeTherapyRoutes from './routes/homeTherapy.js';
// Billing disabled application-wide — invoice routes intentionally unmounted.
// import invoiceRoutes from './routes/invoices.js';
// Dashboard refactor
import todoRoutes from './routes/todos.js';
import dashboardSummaryRoutes from './routes/dashboard-summary.js';
// Self-Examination Protocol (IWIS pre-consultation)
import selfExamRoutes from './routes/self-exam.js';
// Messaging templates + configurable daily reminder
import messageTemplateRoutes from './routes/message-templates.js';
import reminderSettingRoutes from './routes/reminder-settings.js';
// Critical-journey: admin view of at-risk patients
import criticalJourneyRoutes from './routes/critical-journey.js';
// Recent audit-log feed (admin dashboard activity widget)
import auditLogRoutes from './routes/audit-logs.js';
// Inbound webhooks (Daily.co room-ended, etc.)
import webhooksRoutes from './routes/webhooks.js';
// Ayurvedic Voice Health Coach (AYURVEDIC_VOICE_COACH feature)
import voiceCoachRoutes from './routes/voice-coach.js';
import painMapRoutes from './routes/painMap.js';
// Monday Motivation Card — daily Ayurvedic tip per patient, +5 Zen Points
// on first read, optional save / share. Routes were authored but never
// mounted in this file; the Monday cron lived only in the node-cron
// fallback (services/scheduler.service.js), so when Redis was up the
// BullMQ scheduler ran without it. Both gaps fixed in this commit.
import motivationRoutes from './routes/motivation.js';
// SOAP-format therapist session notes (Subjective / Objective /
// Assessment / Plan). Separate from Appointment.sessionNotes (doctor
// consult notes) — see routes/therapistNotes.js for the access model.
import therapistNotesRoutes from './routes/therapistNotes.js';
// Sheizen-inspired daily tracking — water / activity / measurements /
// meal-photo / full-day-bonus. Patient-only logging endpoints + a doctor
// summary for the PatientTimeline view. Auth + role are enforced per-route
// inside the file; we just mount it here.
import dailyTrackingRoutes from './routes/dailyTracking.js';

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
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Security Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Video-call providers are allowed for script / iframe / connect so both
      // Jitsi (fallback) and Daily.co (primary when DAILY_API_KEY is set) can
      // embed inside ConsultationRoom.
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://meet.jit.si", "https://*.daily.co"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc:     ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "https://meet.jit.si", "wss://*.jit.si", "https://*.daily.co", "wss://*.daily.co"],
      frameSrc:   ["'self'", "https://meet.jit.si", "https://*.daily.co"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      objectSrc:  ["'none'"],
      mediaSrc:   ["'self'", "https://*.youtube.com", "https://*.vimeo.com", "https://*.daily.co"],
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

// Patient feedback (star ratings + 4-question consultation flow)
app.use('/api/feedback', feedbackRoutes);

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
// Staff DMs + branch group chats — separate domain from patient chat,
// see services/staffChat.service.js for RBAC + tenancy rules.
app.use('/api/staff-chat', staffChatRoutes);
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
app.use('/api/patient/dashboard', enhancedDashboardRoutes);
app.use('/api/patients/:patientId/prescribed-vitals', prescribedVitalsRoutes);
// Live Patient Queue Management (arrival, consultation lifecycle, board)
app.use('/api/queue', queueRoutes);
// Consultation Room — single-shot patient history aggregate
app.use('/api/patient', consultationContextRoutes);
app.use('/api/visit-summary', visitSummaryRoutes);
// Monday Motivation Card — patient-only endpoints (today / save / saved /
// :id/read). Auth is enforced inside the route file via authMiddleware +
// roleMiddleware(['PATIENT']), so we don't add a layer here.
app.use('/api/motivation', motivationRoutes);
app.use('/api/therapist-notes', therapistNotesRoutes);
// Daily tracking — frontend dailyTracking.service.ts hits these directly.
// The router existed but was never mounted, which caused HTML 404 responses
// on every water/activity/meal-photo/measurement call.
app.use('/api/daily-tracking', dailyTrackingRoutes);
// Pain Map (clinician + patient self) — mounted at /api so it can serve both
//   /api/patients/:patientId/pain-map  (clinician, scoped)
//   /api/patient/pain/my-map           (patient, self-only)
app.use('/api', painMapRoutes);

// IWIS competitor feature additions
app.use('/api/therapy-rooms', therapyRoomRoutes);
app.use('/api/diet-prescriptions', dietPrescriptionRoutes);
app.use('/api/diet-packages', dietPackageRoutes);
app.use('/api/clinical-photos', clinicalPhotoRoutes);
app.use('/api/therapists', therapistSkillRoutes);
app.use('/api/packages', treatmentPackageRoutes);
app.use('/api/group-sessions', groupSessionRoutes);
// Home Therapy — doctor-authored referral, admin-approved, GPS-tracked sessions.
app.use('/api/home-therapy', homeTherapyRoutes);
// app.use('/api/invoices', invoiceRoutes); // billing disabled

// Dashboard refactor
app.use('/api/todos', todoRoutes);
app.use('/api/dashboards', dashboardSummaryRoutes);

// Self-Examination Protocol (IWIS pre-consultation)
app.use('/api/self-exam', selfExamRoutes);
app.use('/api/message-templates', messageTemplateRoutes);
app.use('/api/reminder-settings', reminderSettingRoutes);

// Critical-journey — admin view of at-risk patients (feature-gated)
app.use('/api/critical-journey', criticalJourneyRoutes);

// Recent audit-log activity feed for the admin dashboard
app.use('/api/audit-logs', auditLogRoutes);

// Ayurvedic Voice Health Coach — patient-facing 24/7 coach (feature-gated)
app.use('/api/voice-coach', voiceCoachRoutes);

// Voice-Note dictation helper — clinician-side dictation → OpenAI structuring
// → 7 visit-summary fields auto-filled into the consultation form. No audio
// leaves the browser; only the live STT transcript is sent to the backend.
import voiceNoteRefineRoutes from './services/voiceNote/refine.route.js';
import { authMiddleware as voiceNoteAuthMw, roleMiddleware as voiceNoteRoleMw } from './middleware/auth.js';
app.use(
  '/api/voice-note',
  voiceNoteAuthMw,
  voiceNoteRoleMw(['DOCTOR', 'ADMIN_DOCTOR']),
  voiceNoteRefineRoutes,
);

// Ayurvedic Food Database + Recipe Library (Feature 1) — branch-scoped
// catalogue + recipe library + DietMeal ↔ Food links. Per-route role
// gating lives inside ayurvedicFood.js; only authMiddleware runs here.
import ayurvedicFoodRoutes from './routes/ayurvedicFood.js';
import { authMiddleware as ayurAuthMw } from './middleware/auth.js';
app.use('/api/ayurvedic-foods', ayurAuthMw, ayurvedicFoodRoutes);

// Branded PDF Health Report + WhatsApp delivery (Feature 2). Per-route
// role gating lives inside healthReports.js; only authMiddleware runs here.
import healthReportsRoutes from './routes/healthReports.js';
import { authMiddleware as healthReportsAuthMw } from './middleware/auth.js';
app.use('/api/health-reports', healthReportsAuthMw, healthReportsRoutes);

// Auto-generated Follow-Up Tasks (Feature 5). Per-route role gating lives
// inside followUpTasks.js; only authMiddleware runs here.
import followUpTasksRoutes from './routes/followUpTasks.js';
import { authMiddleware as followUpAuthMw } from './middleware/auth.js';
app.use('/api/follow-up-tasks', followUpAuthMw, followUpTasksRoutes);

// Workflow Automation Rules Engine (Feature 3). Branch-scoped no-code
// automation; per-route role gating lives inside workflowRules.js.
import workflowRulesRoutes from './routes/workflowRules.js';
import { authMiddleware as workflowAuthMw } from './middleware/auth.js';
app.use('/api/workflow-rules', workflowAuthMw, workflowRulesRoutes);

// Inbound webhooks (Daily.co room-ended → auto-complete appointment, etc.)
// Route uses express.raw() internally for HMAC verification — scoped local
// to the /daily handler so the global JSON parser doesn't reach it.
app.use('/api/webhooks', webhooksRoutes);

// Super Admin (platform-level) — mounted separately; its own auth chain.
app.use('/api/super-admin', superAdminRoutes);

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

// JSON 404 catch-all — must be AFTER all routes, BEFORE error handlers.
// Without this, Express's default handler returns an HTML body for any
// unmatched path, which the frontend then renders as raw "<!DOCTYPE html>"
// inside toast error popups. Returning JSON here keeps the error surface
// consistent with what the rest of the API emits.
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    },
  });
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

httpServer.listen(PORT, async () => {
  logger.info(`Backend server running on port ${PORT}`, { env: process.env.NODE_ENV });
  logger.info('WebSocket server initialized');
  logger.info('Scheduler service running');

  // Prominently surface Redis state at startup. When Redis is unavailable,
  // several features degrade silently (BullMQ → node-cron, Bull Board hidden,
  // JTI blacklist best-effort, no horizontal scaling). Make the operator aware.
  try {
    const { cacheService } = await import('./services/cache.service.js');
    // Give the client a beat to attempt its initial connection.
    await new Promise(r => setTimeout(r, 500));
    const { connected, circuitOpen } = cacheService.getStatus();
    if (connected && !circuitOpen) {
      logger.info('[Redis] ✅ Connected — BullMQ + circuit breaker + JTI blacklist active');
    } else {
      logger.warn(
        '[Redis] ⚠️ NOT CONNECTED — scheduled jobs fall back to in-process node-cron, ' +
        'Bull Board unavailable, JTI blacklist disabled, horizontal scaling won\'t work. ' +
        'Set REDIS_URL in .env (default redis://localhost:6379) and start a Redis service.',
      );
    }
  } catch (err) {
    logger.warn('[Redis] state check failed:', err.message);
  }
});
