import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

export function initSentry() {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
        console.log('[Sentry] No SENTRY_DSN configured — error tracking disabled');
        return;
    }

    Sentry.init({
        dsn,
        environment: process.env.NODE_ENV || 'development',
        release: process.env.npm_package_version || '1.0.0',
        integrations: [
            nodeProfilingIntegration(),
        ],
        tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
        profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
        beforeSend(event) {
            // Scrub sensitive data
            if (event.request?.data) {
                const sensitive = ['password', 'token', 'secret', 'refreshToken', 'accessToken'];
                for (const key of sensitive) {
                    if (event.request.data[key]) {
                        event.request.data[key] = '[REDACTED]';
                    }
                }
            }
            return event;
        },
    });

    console.log('[Sentry] Initialized for environment:', process.env.NODE_ENV || 'development');
}

export { Sentry };
