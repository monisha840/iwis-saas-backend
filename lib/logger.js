/**
 * Centralized structured logger for audit traceability and production monitoring.
 *
 * Production: structured JSON logs to stdout + rotating file logs.
 * Development: colored terminal output.
 */

import fs from 'fs';
import path from 'path';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_DIR = process.env.LOG_DIR || './logs';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Ensure log directory exists
if (IS_PRODUCTION) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevelNum = LEVELS[LOG_LEVEL] ?? 2;

// Track error rate for alerting
let errorCount = 0;
let lastErrorReset = Date.now();

function shouldLog(level) {
    return (LEVELS[level] ?? 2) <= currentLevelNum;
}

function formatStructured(level, message, meta) {
    return JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...meta,
    });
}

function writeToFile(line) {
    if (!IS_PRODUCTION) return;
    try {
        const date = new Date().toISOString().split('T')[0];
        const filePath = path.join(LOG_DIR, `app-${date}.log`);
        fs.appendFileSync(filePath, line + '\n');
    } catch {}
}

const logger = {
    info(message, meta = {}) {
        if (!shouldLog('info')) return;
        this._log('info', message, meta);
    },
    warn(message, meta = {}) {
        if (!shouldLog('warn')) return;
        this._log('warn', message, meta);
    },
    error(message, error = null, meta = {}) {
        if (!shouldLog('error')) return;
        const errorMeta = error ? {
            error: error.message,
            stack: IS_PRODUCTION ? undefined : error.stack,
            ...meta
        } : meta;
        this._log('error', message, errorMeta);

        // Track error rate
        errorCount++;
        const now = Date.now();
        if (now - lastErrorReset >= 60000) {
            if (errorCount > parseInt(process.env.ERROR_RATE_ALERT_THRESHOLD || '10', 10)) {
                this._log('warn', `High error rate detected: ${errorCount} errors in last minute`, { errorCount });
            }
            errorCount = 0;
            lastErrorReset = now;
        }
    },
    debug(message, meta = {}) {
        if (!shouldLog('debug')) return;
        this._log('debug', message, meta);
    },
    audit(action, userId, resourceId, meta = {}) {
        this._log('info', `[AUDIT] ${action}`, {
            audit: true,
            action,
            userId,
            resourceId,
            timestamp: new Date().toISOString(),
            ...meta
        });
    },
    _log(level, message, meta) {
        if (IS_PRODUCTION) {
            const line = formatStructured(level, message, meta);
            console.log(line);
            writeToFile(line);
        } else {
            const colors = {
                error: '\x1b[31m',
                warn: '\x1b[33m',
                info: '\x1b[36m',
                debug: '\x1b[90m',
            };
            const color = colors[level] || '\x1b[36m';
            const reset = '\x1b[0m';
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
            console.log(`${color}[${level.toUpperCase()}]${reset} ${message}`, metaStr ? meta : '');
        }
    }
};

export default logger;
