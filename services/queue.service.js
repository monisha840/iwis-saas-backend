/**
 * Queue Service — BullMQ-based job queue for asynchronous processing.
 *
 * Gracefully degrades when Redis is unavailable — queues are created lazily
 * and errors are caught so the server stays up.
 */

import config from '../config/index.js';
import logger from '../lib/logger.js';

// Parse Redis URL for connection object
function parseRedisUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port) || 6379,
      password: parsed.password || undefined,
      maxRetriesPerRequest: null,
    };
  } catch {
    return { host: 'localhost', port: 6379, maxRetriesPerRequest: null };
  }
}

const redisConnection = parseRedisUrl(config.redis.url);

const defaultJobOptions = {
  attempts: config.queue.maxAttempts,
  backoff: {
    type: 'exponential',
    delay: config.queue.backoffDelay,
  },
  removeOnComplete: 100,
  removeOnFail: 50,
};

// ── Lazy initialization — only create queues/workers when Redis is reachable ──

let _queuesInitialized = false;
let _notificationQueue = null;
let _auditQueue = null;
let _reportQueue = null;

async function ensureQueues() {
  if (_queuesInitialized) return;
  _queuesInitialized = true; // prevent re-entry

  try {
    const { Queue, Worker } = await import('bullmq');

    _notificationQueue = new Queue('notifications', { connection: redisConnection, defaultJobOptions });
    _auditQueue = new Queue('audit-writes', { connection: redisConnection, defaultJobOptions });
    _reportQueue = new Queue('report-exports', { connection: redisConnection, defaultJobOptions });

    // Suppress unhandled error events on queues
    for (const q of [_notificationQueue, _auditQueue, _reportQueue]) {
      q.on('error', (err) => {
        if (!q._loggedError) {
          logger.warn(`[Queue:${q.name}] Redis unavailable — queue degraded`, { error: err.message });
          q._loggedError = true;
        }
      });
    }

    // ── Workers ──────────────────────────────────────────────────────────────
    const notificationWorker = new Worker('notifications', async (job) => {
      if (job.name === 'webhook') {
        const { url, payload, secret, appointmentId } = job.data;
        logger.info('[Queue:notifications] Processing webhook job', { jobId: job.id, appointmentId });
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Webhook failed (${response.status}): ${body}`);
        }
        return { status: response.status };
      }

      if (job.name === 'in-app') {
        const { userId, title, body, type, relatedId } = job.data;
        logger.info('[Queue:notifications] Processing in-app notification', { jobId: job.id, userId });
        const { default: prisma } = await import('../lib/prisma.js');
        const { emitToUser } = await import('../websocket/index.js');
        const notification = await prisma.notification.create({
          data: {
            userId, title, message: body, type: type || 'GENERAL',
            priority: 'INFO', data: {}, ...(relatedId && { relatedId }),
          },
        });
        emitToUser(userId, 'notification', notification);
        return { notificationId: notification.id };
      }
    }, { connection: redisConnection, concurrency: config.queue.concurrency });

    const reportWorker = new Worker('report-exports', async (job) => {
      const { type, filters, requestedBy } = job.data;
      logger.info(`[Queue:reports] Processing ${job.name} export`, { jobId: job.id, type, requestedBy });
      const { ExportService } = await import('./export.service.js');
      if (job.name === 'pdf') return ExportService.generatePdfReport(type, filters, requestedBy);
      return ExportService.generateCsvReport(type, filters, requestedBy);
    }, { connection: redisConnection, concurrency: 2 });

    // Attach error handlers so unhandled rejections don't crash the process
    for (const w of [notificationWorker, reportWorker]) {
      w.on('error', (err) => {
        // Suppress Redis connection errors
      });
      w.on('failed', (job, err) => {
        logger.error(`[Queue:${w.name}] Job ${job?.id} failed`, err);
      });
      w.on('completed', (job) => {
        logger.info(`[Queue:${w.name}] Job ${job.id} completed`, { jobName: job.name });
      });
    }

    logger.info('[QueueService] BullMQ queues and workers initialized');
  } catch (err) {
    logger.warn('[QueueService] Failed to initialize queues — running without job queues', { error: err.message });
    _queuesInitialized = false; // allow retry later
  }
}

// Try to initialize on module load, but don't crash if Redis is unavailable
ensureQueues().catch(() => {});

// ── Exported queue references (may be null if Redis unavailable) ─────────────

export const notificationQueue = { add: (...args) => _notificationQueue?.add(...args) };
export const auditQueue = { add: (...args) => _auditQueue?.add(...args) };
export const reportQueue = { add: (...args) => _reportQueue?.add(...args) };

// ── Helper functions ────────────────────────────────────────────────────────

export async function enqueueAppointmentWebhook(appointmentId, payload) {
  if (!_notificationQueue) {
    logger.warn('[QueueService] Queue unavailable — skipping webhook enqueue');
    return null;
  }
  const job = await _notificationQueue.add('webhook', {
    url: config.notifications.n8nWebhookUrl,
    secret: config.notifications.webhookSecret,
    payload, appointmentId,
  }, { ...defaultJobOptions, jobId: `webhook:${appointmentId}` });
  logger.info('[QueueService] Enqueued appointment webhook', { jobId: job.id, appointmentId });
  return job.id;
}

export async function enqueueInAppNotification({ userId, title, body, type, relatedId }) {
  if (!_notificationQueue) return null;
  return _notificationQueue.add('in-app', { userId, title, body, type, relatedId }, defaultJobOptions);
}

export async function enqueueReport({ format = 'pdf', type, filters, requestedBy }) {
  if (!_reportQueue) return null;
  return _reportQueue.add(format, { type, filters, requestedBy }, defaultJobOptions);
}

// ── Bull Board Integration ──────────────────────────────────────────────────
export function getBullBoardQueues() {
  return [_notificationQueue, _auditQueue, _reportQueue].filter(Boolean);
}
