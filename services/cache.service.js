import { createClient } from 'redis';
import logger from '../lib/logger.js';

const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.REDIS_CIRCUIT_BREAKER_THRESHOLD || '5', 10);
const CIRCUIT_BREAKER_RESET_MS = 60 * 1000; // 60 seconds

class CacheService {
    constructor() {
        this.client = createClient({
            url: process.env.REDIS_URL || 'redis://localhost:6379',
            socket: {
                connectTimeout: 2000,
                reconnectStrategy: (retries) => {
                    if (retries > 10) return false;
                    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
                    return Math.min(Math.pow(2, retries) * 1000, 30000);
                }
            }
        });

        this.client.on('error', (err) => {
            if (!this._loggedError) {
                logger.warn('Redis unavailable — cache disabled.', { message: err.message });
                this._loggedError = true;
            }
        });
        this.client.on('connect', () => {
            this._loggedError = false;
            this._consecutiveFailures = 0;
            this._circuitOpen = false;
            logger.info('Redis Client Connected');
        });
        this.client.on('reconnecting', () => {
            logger.info('Redis Client Reconnecting...');
        });

        this._connected = false;
        this._available = true;
        // Circuit breaker state
        this._consecutiveFailures = 0;
        this._circuitOpen = false;
        this._circuitOpenedAt = null;
    }

    _checkCircuitBreaker() {
        if (!this._circuitOpen) return false;

        // Half-open: allow a probe after reset period
        const elapsed = Date.now() - this._circuitOpenedAt;
        if (elapsed >= CIRCUIT_BREAKER_RESET_MS) {
            logger.info('Redis circuit breaker half-open — probing');
            this._circuitOpen = false;
            return false;
        }

        return true; // Circuit is open, skip Redis
    }

    _recordFailure() {
        this._consecutiveFailures++;
        if (this._consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !this._circuitOpen) {
            this._circuitOpen = true;
            this._circuitOpenedAt = Date.now();
            logger.warn(`Redis circuit breaker OPEN after ${this._consecutiveFailures} consecutive failures — skipping Redis for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`);
        }
    }

    _recordSuccess() {
        if (this._consecutiveFailures > 0 || this._circuitOpen) {
            logger.info('Redis circuit breaker reset — connection healthy');
        }
        this._consecutiveFailures = 0;
        this._circuitOpen = false;
    }

    async connect() {
        if (this._connected) return;
        if (!this._available) return;

        try {
            await Promise.race([
                this.client.connect(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connection timed out')), 2000))
            ]);
            this._connected = true;
            this._available = true;
        } catch (err) {
            logger.warn(`Redis not available: ${err.message}. Cache will be skipped.`);
            this._available = false;
            this._connected = false;
        }
    }

    async get(key) {
        if (!this._available || this._checkCircuitBreaker()) return null;
        try {
            await this.connect();
            if (!this._available) return null;
            const value = await this.client.get(key);
            this._recordSuccess();
            return value ? JSON.parse(value) : null;
        } catch (err) {
            this._recordFailure();
            logger.error(`Cache Get Error [${key}]`, err);
            return null;
        }
    }

    async set(key, value, ttlSeconds = 3600) {
        if (!this._available || this._checkCircuitBreaker()) return false;
        try {
            await this.connect();
            if (!this._available) return false;
            await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
            this._recordSuccess();
            return true;
        } catch (err) {
            this._recordFailure();
            logger.error(`Cache Set Error [${key}]`, err);
            return false;
        }
    }

    async del(key) {
        if (!this._available || this._checkCircuitBreaker()) return false;
        try {
            await this.connect();
            if (!this._available) return false;
            await this.client.del(key);
            this._recordSuccess();
            return true;
        } catch (err) {
            this._recordFailure();
            logger.error(`Cache Del Error [${key}]`, err);
            return false;
        }
    }

    /**
     * Atomic SET-IF-ABSENT with TTL (`SET key val EX ttl NX`).
     *
     * Returns:
     *   `true`  — key was set (we acquired the slot — caller may proceed)
     *   `false` — key already exists (rate-limited / locked out — caller must skip)
     *   `null`  — Redis unavailable / circuit open (caller decides whether to fail-open or fail-closed)
     *
     * Used by the home-therapy location-ping endpoint to throttle each
     * therapist to one ping every 10 seconds.
     */
    async setIfAbsent(key, value, ttlSeconds) {
        if (!this._available || this._checkCircuitBreaker()) return null;
        try {
            await this.connect();
            if (!this._available) return null;
            // node-redis v4 string form: returns 'OK' on success, null on existing key.
            const reply = await this.client.set(key, String(value), { EX: ttlSeconds, NX: true });
            this._recordSuccess();
            return reply === 'OK';
        } catch (err) {
            this._recordFailure();
            logger.error(`Cache setIfAbsent Error [${key}]`, err);
            return null;
        }
    }

    async flush() {
        if (!this._available || this._checkCircuitBreaker()) return false;
        try {
            await this.connect();
            if (!this._available) return false;
            await this.client.flushAll();
            this._recordSuccess();
            return true;
        } catch (err) {
            this._recordFailure();
            logger.error('Cache Flush Error', err);
            return false;
        }
    }

    async invalidatePattern(pattern) {
        if (!this._available || this._checkCircuitBreaker()) return false;
        try {
            await this.connect();
            if (!this._available) return false;
            let cursor = 0;
            do {
                const reply = await this.client.scan(cursor, { MATCH: pattern, COUNT: 100 });
                cursor = reply.cursor;
                if (reply.keys.length > 0) {
                    await this.client.del(reply.keys);
                }
            } while (cursor !== 0);
            this._recordSuccess();
            return true;
        } catch (err) {
            this._recordFailure();
            logger.error(`Cache invalidatePattern Error [${pattern}]`, err);
            return false;
        }
    }

    /**
     * Get circuit breaker status for health checks.
     */
    getStatus() {
        return {
            connected: this._connected,
            available: this._available,
            circuitOpen: this._circuitOpen,
            consecutiveFailures: this._consecutiveFailures,
        };
    }
}

export const cacheService = new CacheService();
