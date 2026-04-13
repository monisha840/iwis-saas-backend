/**
 * Centralized environment-based configuration.
 * Single source of truth for all env vars — no process.env scattered across services.
 *
 * Usage:
 *   import config from '../config/index.js';
 *   config.jwt.secret
 */

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction,

  server: {
    port: parseInt(process.env.PORT || '4000', 10),
  },

  cors: {
    // Comma-separated origins in ALLOWED_ORIGINS env var, or fall back to defaults
    origins: [
      'http://localhost:5173',
      'http://localhost:8080',
      'http://localhost:8081',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:8081',
      ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
      ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : []),
    ].filter(Boolean),
  },

  jwt: {
    // In production the app will crash at startup if either secret is absent.
    // In development fallbacks are used so fresh checkouts start without a full .env.
    secret: process.env.JWT_SECRET || (isProduction
      ? (() => { throw new Error('JWT_SECRET is required in production'); })()
      : 'dev-fallback-secret-do-not-use-in-production'),
    refreshSecret: process.env.JWT_REFRESH_SECRET || (isProduction
      ? (() => { throw new Error('JWT_REFRESH_SECRET is required in production'); })()
      : 'dev-fallback-refresh-secret-do-not-use-in-production'),
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  database: {
    url: process.env.DATABASE_URL,
    logQueries: process.env.DB_LOG_QUERIES === 'true' || !isProduction,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    connectTimeout: 2000,
    maxRetries: 3,
  },

  rateLimit: {
    windowMs: 15 * 60 * 1000,
    // Production: 600/15min — multi-page clinical apps with parallel fetches + search
    // need headroom. Development: 2000/15min so hot-reloads and testing never hit the limiter.
    max: parseInt(process.env.RATE_LIMIT_MAX || (isProduction ? '600' : '2000'), 10),
    authWindowMs: 60 * 60 * 1000,
    // Production: strict 10/hour. Development: 200/hour.
    authMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX || (isProduction ? '10' : '200'), 10),
  },

  notifications: {
    n8nWebhookUrl: process.env.N8N_WEBHOOK_URL || (isProduction
      ? (() => { throw new Error('N8N_WEBHOOK_URL is required in production'); })()
      : null),
    webhookSecret: process.env.WEBHOOK_SECRET || (isProduction
      ? (() => { throw new Error('WEBHOOK_SECRET is required in production'); })()
      : 'dev-webhook-secret-do-not-use-in-production'),
  },

  email: {
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASSWORD,
    from: process.env.EMAIL_FROM || 'noreply@alshifa.health',
  },

  sms: {
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioFromNumber: process.env.TWILIO_FROM_NUMBER,
  },

  webPush: {
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@alshifa.health',
  },

  queue: {
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '5', 10),
    maxAttempts: parseInt(process.env.QUEUE_MAX_ATTEMPTS || '3', 10),
    backoffDelay: parseInt(process.env.QUEUE_BACKOFF_DELAY || '5000', 10),
  },

  upload: {
    maxFileSizeMb: parseInt(process.env.UPLOAD_MAX_MB || '10', 10),
    dir: process.env.UPLOAD_DIR || 'uploads',
  },
};

export default config;
