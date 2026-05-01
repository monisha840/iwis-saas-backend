/**
 * BullMQ queue: consultation-feedback-request
 *
 * Fires a `feedback_request` Socket.IO event to the patient's user room
 * 30 seconds after their appointment transitions to COMPLETED. The 30s
 * delay gives the clinician time to wrap up notes / billing without the
 * patient seeing the prompt mid-handoff.
 *
 * Lazy-init mirrors queue.service.js — Redis outage gracefully degrades
 * to a no-op (the patient simply won't see the live prompt; the legacy
 * 24h reminder + dashboard checks pick up the slack).
 *
 * Journey-completion uses a SEPARATE event (`journey_feedback_request`)
 * fired immediately from journey.service.js — it doesn't go through this
 * queue because there's no transient race to wait out.
 */
import config from '../config/index.js';
import logger from '../lib/logger.js';

function parseRedisUrl(url) {
    try {
        const parsed = new URL(url);
        return {
            host:                 parsed.hostname,
            port:                 parseInt(parsed.port) || 6379,
            password:             parsed.password || undefined,
            maxRetriesPerRequest: null,
        };
    } catch {
        return { host: 'localhost', port: 6379, maxRetriesPerRequest: null };
    }
}

const redisConnection = parseRedisUrl(config.redis.url);

const defaultJobOptions = {
    attempts: 3,
    backoff:  { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail:     50,
};

let _initialized = false;
let _queue        = null;
let _worker       = null;

async function ensureQueue() {
    if (_initialized) return;
    _initialized = true;

    try {
        const { Queue, Worker } = await import('bullmq');

        _queue = new Queue('consultation-feedback-request', {
            connection: redisConnection,
            defaultJobOptions,
        });
        _queue.on('error', (err) => {
            if (!_queue._loggedError) {
                logger.warn('[Queue:consultation-feedback-request] Redis unavailable — degraded', {
                    error: err.message,
                });
                _queue._loggedError = true;
            }
        });

        _worker = new Worker('consultation-feedback-request', async (job) => {
            const { appointmentId, patientUserId, clinicianId, clinicianName, clinicianRole } = job.data;
            const { emitToUser } = await import('../websocket/index.js');
            emitToUser(patientUserId, 'feedback_request', {
                appointmentId,
                clinicianId,
                clinicianName,
                clinicianRole,
            });
            logger.info('[Queue:consultation-feedback-request] feedback_request emitted', {
                appointmentId, patientUserId,
            });
            return { delivered: true };
        }, { connection: redisConnection, concurrency: 5 });

        _worker.on('error', () => { /* swallow Redis blips */ });
        _worker.on('failed', (job, err) => {
            logger.error('[Queue:consultation-feedback-request] job failed', { jobId: job?.id, err: err.message });
        });

        logger.info('[FeedbackRequestJob] queue + worker initialised');
    } catch (err) {
        logger.warn('[FeedbackRequestJob] init failed — running without queue', { error: err.message });
        _initialized = false;
    }
}

ensureQueue().catch(() => {});

/**
 * Enqueue a delayed feedback_request socket emit.
 *
 * @param {object} payload
 * @param {string} payload.appointmentId
 * @param {string} payload.patientUserId  Patient's User.id (used as socket-room key)
 * @param {string} payload.clinicianId    Clinician's User.id
 * @param {string} payload.clinicianName  Display name for the prompt
 * @param {string} payload.clinicianRole  DOCTOR | THERAPIST | ADMIN_DOCTOR
 * @param {object} [opts]
 * @param {number} [opts.delay=30000]     Milliseconds to wait before delivery
 */
export async function enqueueFeedbackRequest(payload, opts = {}) {
    if (!_queue) {
        // Try one more time in case Redis came back online after first init.
        await ensureQueue();
        if (!_queue) {
            logger.warn('[FeedbackRequestJob] queue unavailable — skipping enqueue', {
                appointmentId: payload?.appointmentId,
            });
            return null;
        }
    }
    const delay = Number.isFinite(opts.delay) ? opts.delay : 30_000;
    const job = await _queue.add('feedback-request', payload, {
        ...defaultJobOptions,
        delay,
        // Idempotency — if appointment status flips COMPLETED → something → COMPLETED
        // again, we only want one prompt per appointment.
        jobId: `feedback-request:${payload.appointmentId}`,
    });
    logger.info('[FeedbackRequestJob] enqueued', { jobId: job.id, delay, appointmentId: payload.appointmentId });
    return job.id;
}

export function getFeedbackRequestQueue() {
    return _queue;
}
