/**
 * Queue Service — Bull-based job queue for asynchronous processing.
 *
 * WHY:
 *  The current notification system fires an n8n webhook synchronously inside the
 *  request cycle, which: (a) adds latency to the main response, (b) causes the
 *  request to fail if the webhook endpoint is down, and (c) uses an in-process
 *  Set for idempotency that disappears on restart — breaking horizontal scaling.
 *
 * This module provides:
 *  • notificationQueue  — webhook / push / email / SMS dispatch
 *  • auditQueue         — high-volume audit writes (batched, non-blocking)
 *  • reportQueue        — heavy PDF/CSV exports
 *
 * Each queue:
 *  - Retries on failure with exponential backoff
 *  - Persists jobs in Redis (survive restarts)
 *  - Emits structured log events for monitoring
 *
 * Usage:
 *   import { notificationQueue } from '../services/queue.service.js';
 *   await notificationQueue.add('appointment-confirmation', { appointmentId });
 */

import Bull from 'bull';
import config from '../config/index.js';
import logger from '../lib/logger.js';

// ── Shared Redis connection options ─────────────────────────────────────────
const redisOpts = {
  url: config.redis.url,
  // Bull accepts redis options directly; gracefully degrade if Redis is absent
  socket: {
    connectTimeout: config.redis.connectTimeout,
    reconnectStrategy: (retries) => {
      if (retries > config.redis.maxRetries) {
        logger.warn('[QueueService] Redis unreachable — queues operating in degraded (no-retry) mode');
        return false;
      }
      return Math.min(retries * 200, 1000);
    },
  },
};

const defaultJobOptions = {
  attempts: config.queue.maxAttempts,
  backoff: {
    type: 'exponential',
    delay: config.queue.backoffDelay,
  },
  removeOnComplete: 100, // keep last 100 completed jobs for inspection
  removeOnFail: 50,
};

// ── Queue definitions ────────────────────────────────────────────────────────

export const notificationQueue = new Bull('notifications', config.redis.url);
export const auditQueue = new Bull('audit-writes', config.redis.url);
export const reportQueue = new Bull('report-exports', config.redis.url);

// ── Notification Queue Processor ────────────────────────────────────────────
/**
 * Job types:
 *   'webhook'       — POST to n8n or external webhook
 *   'push'          — Web-push notification
 *   'email'         — Nodemailer transactional email
 *   'sms'           — Twilio SMS
 *   'in-app'        — Persist Notification record + Socket.IO emit
 */
notificationQueue.process('webhook', config.queue.concurrency, async (job) => {
  const { url, payload, secret, appointmentId } = job.data;
  logger.info('[Queue:notifications] Processing webhook job', { jobId: job.id, appointmentId });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': secret,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Webhook failed (${response.status}): ${body}`);
  }

  return { status: response.status };
});

notificationQueue.process('in-app', config.queue.concurrency, async (job) => {
  const { userId, title, body, type, relatedId } = job.data;
  logger.info('[Queue:notifications] Processing in-app notification', { jobId: job.id, userId });

  // Lazy import to avoid circular dependencies
  const { default: prisma } = await import('../lib/prisma.js');
  const { emitToUser } = await import('../websocket/index.js');

  const notification = await prisma.notification.create({
    data: {
      userId,
      title,
      message: body,   // schema field is 'message', not 'body'
      type: type || 'GENERAL',
      priority: 'INFO',
      data: {},
      ...(relatedId && { relatedId }),
    },
  });

  emitToUser(userId, 'notification', notification);
  return { notificationId: notification.id };
});

// ── Report Export Queue Processor ─────────────────────────────────────────
reportQueue.process('pdf', 2, async (job) => {
  const { type, filters, requestedBy } = job.data;
  logger.info('[Queue:reports] Processing PDF export', { jobId: job.id, type, requestedBy });

  const { ExportService } = await import('./export.service.js');
  const result = await ExportService.generatePdfReport(type, filters, requestedBy);
  return result;
});

reportQueue.process('csv', 2, async (job) => {
  const { type, filters, requestedBy } = job.data;
  logger.info('[Queue:reports] Processing CSV export', { jobId: job.id, type, requestedBy });

  const { ExportService } = await import('./export.service.js');
  const result = await ExportService.generateCsvReport(type, filters, requestedBy);
  return result;
});

// ── Shared event handlers ────────────────────────────────────────────────────
function attachQueueEvents(queue) {
  queue.on('failed', (job, err) => {
    logger.error(`[Queue:${queue.name}] Job ${job.id} failed after ${job.attemptsMade} attempt(s)`, err, {
      jobName: job.name,
      data: job.data,
    });
  });

  queue.on('stalled', (job) => {
    logger.warn(`[Queue:${queue.name}] Job ${job.id} stalled`, { jobName: job.name });
  });

  queue.on('completed', (job, result) => {
    logger.info(`[Queue:${queue.name}] Job ${job.id} completed`, { jobName: job.name, result });
  });
}

attachQueueEvents(notificationQueue);
attachQueueEvents(auditQueue);
attachQueueEvents(reportQueue);

// ── Graceful shutdown ────────────────────────────────────────────────────────
async function closeQueues() {
  logger.info('[QueueService] Closing queues...');
  await Promise.all([
    notificationQueue.close(),
    auditQueue.close(),
    reportQueue.close(),
  ]);
  logger.info('[QueueService] All queues closed');
}

process.on('SIGTERM', closeQueues);
process.on('SIGINT', closeQueues);

/**
 * Helper: enqueue an appointment-confirmation webhook (replaces the inline fetch in notification.service.js).
 *
 * @param {string} appointmentId
 * @param {object} payload       - Pre-built webhook payload
 */
export async function enqueueAppointmentWebhook(appointmentId, payload) {
  const job = await notificationQueue.add(
    'webhook',
    {
      url: config.notifications.n8nWebhookUrl,
      secret: config.notifications.webhookSecret,
      payload,
      appointmentId,
    },
    {
      ...defaultJobOptions,
      jobId: `webhook:${appointmentId}`, // idempotency key — Bull deduplicates by jobId
    }
  );
  logger.info('[QueueService] Enqueued appointment webhook', { jobId: job.id, appointmentId });
  return job.id;
}

/**
 * Helper: enqueue an in-app notification for a user.
 */
export async function enqueueInAppNotification({ userId, title, body, type, relatedId }) {
  return notificationQueue.add('in-app', { userId, title, body, type, relatedId }, defaultJobOptions);
}

/**
 * Helper: enqueue a report export job.
 */
export async function enqueueReport({ format = 'pdf', type, filters, requestedBy }) {
  return reportQueue.add(format, { type, filters, requestedBy }, defaultJobOptions);
}
