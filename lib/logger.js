/**
 * Centralized structured logger for audit traceability and production monitoring.
 */
const logger = {
    info(message, meta = {}) {
        this._log('INFO', message, meta);
    },
    warn(message, meta = {}) {
        this._log('WARN', message, meta);
    },
    error(message, error = null, meta = {}) {
        const errorMeta = error ? {
            error: error.message,
            stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
            ...meta
        } : meta;
        this._log('ERROR', message, errorMeta);
    },
    audit(action, userId, resourceId, meta = {}) {
        this._log('AUDIT', action, {
            userId,
            resourceId,
            timestamp: new Date().toISOString(),
            ...meta
        });
    },
    _log(level, message, meta) {
        const payload = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...meta
        };

        if (process.env.NODE_ENV === 'production') {
            console.log(JSON.stringify(payload));
        } else {
            const color = level === 'ERROR' ? '\x1b[31m' : level === 'WARN' ? '\x1b[33m' : level === 'AUDIT' ? '\x1b[35m' : '\x1b[36m';
            const reset = '\x1b[0m';
            console.log(`${color}[${level}]${reset} ${message}`, Object.keys(meta).length ? meta : '');
        }
    }
};

export default logger;
