import logger from '../lib/logger.js';

// Fields to redact from request bodies
const SENSITIVE_FIELDS = new Set([
    'password', 'newPassword', 'currentPassword', 'confirmPassword',
    'token', 'refreshToken', 'accessToken', 'secret', 'mfaSecret',
    'otp', 'code', 'backupCode',
]);

function redactSensitive(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const redacted = {};
    for (const [key, value] of Object.entries(obj)) {
        if (SENSITIVE_FIELDS.has(key)) {
            redacted[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            redacted[key] = redactSensitive(value);
        } else {
            redacted[key] = value;
        }
    }
    return redacted;
}

function truncateBody(body, maxLength = 2000) {
    if (!body) return undefined;
    const str = JSON.stringify(body);
    if (str.length <= maxLength) return body;
    return { _truncated: true, _length: str.length };
}

export function requestLogger(req, res, next) {
    const start = Date.now();

    // Capture original end to intercept response
    const originalEnd = res.end;
    let responseBody;

    res.end = function(chunk, encoding) {
        // Only capture JSON responses for debug logging
        if (chunk && res.getHeader('content-type')?.includes('application/json')) {
            try {
                responseBody = JSON.parse(chunk.toString());
            } catch { /* non-JSON, skip */ }
        }
        originalEnd.call(this, chunk, encoding);
    };

    res.on('finish', () => {
        const duration = Date.now() - start;
        const logData = {
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            duration: `${duration}ms`,
            userId: req.user?.id || null,
            role: req.user?.role || null,
            ip: req.ip,
            requestId: req.headers['x-request-id'] || res.getHeader('X-Request-Id'),
            userAgent: req.get('user-agent'),
        };

        // Include request body in debug mode (redacted)
        if (process.env.LOG_LEVEL === 'debug' && req.body && Object.keys(req.body).length > 0) {
            logData.requestBody = truncateBody(redactSensitive(req.body));
        }

        // Include response body in debug mode for errors (redacted)
        if (process.env.LOG_LEVEL === 'debug' && res.statusCode >= 400 && responseBody) {
            logData.responseBody = truncateBody(redactSensitive(responseBody));
        }

        // Log level based on status code
        if (res.statusCode >= 500) {
            logger.error('Request failed', logData);
        } else if (res.statusCode >= 400) {
            logger.warn('Request error', logData);
        } else if (duration > 3000) {
            logger.warn('Slow request', logData);
        } else {
            logger.info('Request completed', logData);
        }
    });

    next();
}
