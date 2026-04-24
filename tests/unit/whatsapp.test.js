import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config BEFORE importing the service so `enabled` evaluates to true.
vi.mock('../../config/index.js', () => ({
    default: {
        whatsapp: {
            baseUrl: 'https://evo.test',
            apiKey: 'test-key',
            instance: 'test-instance',
            defaultConsultationMinutes: 30,
        },
    },
}));

// Logger stub to keep test output clean.
vi.mock('../../lib/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), audit: vi.fn() },
}));

import { WhatsAppService, _parseStatusFromError } from '../../services/whatsapp.service.js';

describe('_parseStatusFromError', () => {
    it('extracts HTTP status from error message', () => {
        expect(_parseStatusFromError(new Error('Evolution sendText failed (429): rate limit'))).toBe(429);
        expect(_parseStatusFromError(new Error('Evolution sendText failed (500): server error'))).toBe(500);
        expect(_parseStatusFromError(new Error('Evolution sendText failed (400): bad number'))).toBe(400);
    });

    it('returns null for messages without a status', () => {
        expect(_parseStatusFromError(new Error('network timeout'))).toBeNull();
        expect(_parseStatusFromError(null)).toBeNull();
    });
});

describe('WhatsAppService.sendText retry behaviour', () => {
    let fetchMock;
    let sleepSpy;

    beforeEach(() => {
        fetchMock = vi.fn();
        globalThis.fetch = fetchMock;
        // Short-circuit the backoff sleeps so the test suite stays fast.
        sleepSpy = vi.spyOn(global, 'setTimeout').mockImplementation((cb) => { cb(); return 0; });
    });

    afterEach(() => {
        sleepSpy.mockRestore();
        vi.restoreAllMocks();
    });

    function makeResponse(status, body = '') {
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => body,
            json: async () => ({ key: { id: 'evo_123' } }),
        };
    }

    it('returns SENT on first-attempt success (no retries)', async () => {
        fetchMock.mockResolvedValueOnce(makeResponse(200));
        const result = await WhatsAppService.sendText('919999999999', 'hi');
        expect(result.status).toBe('SENT');
        expect(result.externalId).toBe('evo_123');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a 429 rate-limit up to MAX_ATTEMPTS', async () => {
        fetchMock
            .mockResolvedValueOnce(makeResponse(429, 'too many'))
            .mockResolvedValueOnce(makeResponse(429, 'too many'))
            .mockResolvedValueOnce(makeResponse(200));
        const result = await WhatsAppService.sendText('919999999999', 'hi');
        expect(result.status).toBe('SENT');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries 5xx then succeeds', async () => {
        fetchMock
            .mockResolvedValueOnce(makeResponse(503))
            .mockResolvedValueOnce(makeResponse(200));
        const result = await WhatsAppService.sendText('919999999999', 'hi');
        expect(result.status).toBe('SENT');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries network errors (fetch throws)', async () => {
        fetchMock
            .mockRejectedValueOnce(new Error('network timeout'))
            .mockResolvedValueOnce(makeResponse(200));
        const result = await WhatsAppService.sendText('919999999999', 'hi');
        expect(result.status).toBe('SENT');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fails fast on 400 (bad number — non-retryable)', async () => {
        fetchMock.mockResolvedValueOnce(makeResponse(400, 'invalid number'));
        await expect(WhatsAppService.sendText('919999999999', 'hi')).rejects.toThrow(/\(400\)/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails fast on 401 (auth — non-retryable)', async () => {
        fetchMock.mockResolvedValueOnce(makeResponse(401, 'bad apikey'));
        await expect(WhatsAppService.sendText('919999999999', 'hi')).rejects.toThrow(/\(401\)/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws after MAX_ATTEMPTS of persistent transient failure', async () => {
        fetchMock.mockResolvedValue(makeResponse(503));
        await expect(WhatsAppService.sendText('919999999999', 'hi')).rejects.toThrow(/\(503\)/);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('short-circuits on missing arguments without any retry', async () => {
        const r1 = await WhatsAppService.sendText('', 'hi');
        expect(r1.status).toBe('FAILED');
        const r2 = await WhatsAppService.sendText('919999999999', '');
        expect(r2.status).toBe('FAILED');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
