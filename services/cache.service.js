import { createClient } from 'redis';
import logger from '../lib/logger.js';

class CacheService {
    constructor() {
        this.client = createClient({
            url: process.env.REDIS_URL || 'redis://localhost:6379',
            socket: {
                connectTimeout: 2000,   // 2 second connection timeout
                reconnectStrategy: (retries) => {
                    if (retries > 3) return false; // Stop retrying after 3 attempts
                    return Math.min(retries * 200, 1000);
                }
            }
        });

        this.client.on('error', (err) => {
            // Only log first error to avoid spamming logs when Redis is down
            if (!this._loggedError) {
                logger.warn('Redis unavailable — cache disabled. Leaderboard will compute fresh data on each request.', { message: err.message });
                this._loggedError = true;
            }
        });
        this.client.on('connect', () => {
            this._loggedError = false;
            logger.info('Redis Client Connected');
        });
        this.client.on('reconnecting', () => {
            logger.info('Redis Client Reconnecting...');
        });

        this._connected = false;
        this._available = true; // Assume available until proven otherwise
    }

    async connect() {
        if (this._connected) return;
        if (!this._available) return; // Redis is down, skip attempts

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
        if (!this._available) return null;
        try {
            await this.connect();
            if (!this._available) return null;
            const value = await this.client.get(key);
            return value ? JSON.parse(value) : null;
        } catch (err) {
            logger.error(`Cache Get Error [${key}]`, err);
            return null;
        }
    }

    async set(key, value, ttlSeconds = 3600) {
        if (!this._available) return false;
        try {
            await this.connect();
            if (!this._available) return false;
            await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
            return true;
        } catch (err) {
            logger.error(`Cache Set Error [${key}]`, err);
            return false;
        }
    }

    async del(key) {
        if (!this._available) return false;
        try {
            await this.connect();
            if (!this._available) return false;
            await this.client.del(key);
            return true;
        } catch (err) {
            logger.error(`Cache Del Error [${key}]`, err);
            return false;
        }
    }

    async flush() {
        if (!this._available) return false;
        try {
            await this.connect();
            if (!this._available) return false;
            await this.client.flushAll();
            return true;
        } catch (err) {
            logger.error('Cache Flush Error', err);
            return false;
        }
    }
}

export const cacheService = new CacheService();
