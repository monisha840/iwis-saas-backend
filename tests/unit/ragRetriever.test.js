/**
 * RAG Retriever — unit tests.
 *
 * Three concerns:
 *   1. cosineSimilarity / topK — pure math
 *   2. retrievePassages — graceful fallback paths (blank query, no corpus, OpenAI error)
 *   3. retrievePassages — happy path with injected corpus + fake OpenAI client
 *
 * No real OpenAI / file I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ragRetriever = await import('../../services/voiceCoach/ragRetriever.js');
const {
    cosineSimilarity,
    topK,
    retrievePassages,
    __resetForTests,
    __setCorpusForTests,
    __setClientForTests,
} = ragRetriever;

beforeEach(() => {
    __resetForTests();
});

// ── Pure math ─────────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
    it('returns 1 for identical unit vectors', () => {
        const v = [1, 0, 0];
        expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
    });

    it('returns 0 for orthogonal vectors', () => {
        expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
    });

    it('returns -1 for opposite-direction vectors', () => {
        expect(cosineSimilarity([1, 1, 0], [-1, -1, 0])).toBeCloseTo(-1, 6);
    });

    it('returns 0 when either vector is null', () => {
        expect(cosineSimilarity(null, [1, 2])).toBe(0);
        expect(cosineSimilarity([1, 2], null)).toBe(0);
    });

    it('returns 0 when shapes mismatch', () => {
        expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    });

    it('returns 0 when one vector is all zeros (no division by zero)', () => {
        expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
    });

    it('handles non-unit vectors via normalisation', () => {
        // Both point in the same direction, different magnitudes.
        expect(cosineSimilarity([2, 0, 0], [5, 0, 0])).toBeCloseTo(1, 6);
    });
});

describe('topK', () => {
    const corpus = [
        { id: 'a', embedding: [1, 0, 0] },
        { id: 'b', embedding: [0.9, 0.1, 0] },
        { id: 'c', embedding: [0, 1, 0] },
        { id: 'd', embedding: [-1, 0, 0] },
    ];

    it('orders results by similarity descending', () => {
        const out = topK([1, 0, 0], corpus, 4, -1);
        expect(out.map(r => r.passage.id)).toEqual(['a', 'b', 'c', 'd']);
        expect(out[0].score).toBeGreaterThan(out[1].score);
    });

    it('respects k', () => {
        const out = topK([1, 0, 0], corpus, 2, -1);
        expect(out).toHaveLength(2);
        expect(out.map(r => r.passage.id)).toEqual(['a', 'b']);
    });

    it('filters by minSimilarity', () => {
        const out = topK([1, 0, 0], corpus, 4, 0.5);
        // 'c' is orthogonal (~0) and 'd' is opposite (-1) — both excluded.
        expect(out.map(r => r.passage.id)).toEqual(['a', 'b']);
    });

    it('returns [] when query vector is null', () => {
        expect(topK(null, corpus, 4, 0)).toEqual([]);
    });

    it('returns [] when corpus is empty', () => {
        expect(topK([1, 0, 0], [], 4, 0)).toEqual([]);
    });
});

// ── Graceful fallback paths ──────────────────────────────────────────────

describe('retrievePassages — fallback paths', () => {
    it('returns [] for a blank query', async () => {
        expect(await retrievePassages('')).toEqual([]);
        expect(await retrievePassages('   ')).toEqual([]);
        expect(await retrievePassages(null)).toEqual([]);
    });

    it('returns [] when no corpus is loaded', async () => {
        // No __setCorpusForTests call — _corpusLoadAttempted goes through fs path
        // which will fail in the test sandbox. Should swallow and return [].
        const out = await retrievePassages('what is vata');
        expect(out).toEqual([]);
    });

    it('returns [] when the OpenAI client is missing', async () => {
        __setCorpusForTests([
            { id: 'x', embedding: new Array(1536).fill(0.001), text: 'foo' },
        ]);
        // No __setClientForTests AND no OPENAI_API_KEY → client() returns null.
        const prev = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            expect(await retrievePassages('hello')).toEqual([]);
        } finally {
            if (prev) process.env.OPENAI_API_KEY = prev;
        }
    });

    it('returns [] when the OpenAI call throws', async () => {
        __setCorpusForTests([
            { id: 'x', embedding: new Array(1536).fill(0.001), text: 'foo' },
        ]);
        __setClientForTests({
            embeddings: {
                create: vi.fn().mockRejectedValue(new Error('boom')),
            },
        });
        expect(await retrievePassages('hello')).toEqual([]);
    });

    it('returns [] when the embedding shape is wrong', async () => {
        __setCorpusForTests([
            { id: 'x', embedding: new Array(1536).fill(0.001), text: 'foo' },
        ]);
        __setClientForTests({
            embeddings: {
                create: vi.fn().mockResolvedValue({
                    data: [{ embedding: [0.1, 0.2, 0.3] }],
                }),
            },
        });
        expect(await retrievePassages('hello')).toEqual([]);
    });
});

// ── Happy path ────────────────────────────────────────────────────────────

describe('retrievePassages — happy path', () => {
    function makeVec(seed) {
        const v = new Array(1536).fill(0);
        // Encode a "topic" by setting a small handful of slots based on seed.
        for (let i = 0; i < 1536; i++) v[i] = Math.sin((i + 1) * seed) * 0.01;
        return v;
    }

    const corpus = [
        { id: 'vata-winter', topic: 'Vata in winter', source: 'TOPIC', tags: ['vata'], text: 'warm sesame oil...', embedding: makeVec(1) },
        { id: 'pitta-summer', topic: 'Pitta in summer', source: 'TOPIC', tags: ['pitta'], text: 'coconut water...', embedding: makeVec(2) },
        { id: 'kapha-spring', topic: 'Kapha in spring', source: 'TOPIC', tags: ['kapha'], text: 'honey and pungent...', embedding: makeVec(3) },
    ];

    it('returns top-K passages with metadata and similarity score', async () => {
        __setCorpusForTests(corpus);
        __setClientForTests({
            embeddings: {
                create: vi.fn().mockResolvedValue({
                    data: [{ embedding: makeVec(1) }],
                }),
            },
        });

        const out = await retrievePassages('vata in winter', { topK: 2, minSimilarity: -1 });
        expect(out).toHaveLength(2);
        expect(out[0].id).toBe('vata-winter');
        expect(out[0].topic).toBe('Vata in winter');
        expect(out[0].text).toBe('warm sesame oil...');
        expect(out[0].tags).toEqual(['vata']);
        expect(out[0].score).toBeGreaterThan(0.99);
        expect(typeof out[0].score).toBe('number');
        // No embedding is leaked to callers.
        expect('embedding' in out[0]).toBe(false);
    });

    it('caches the query embedding so a second call within TTL only calls OpenAI once', async () => {
        __setCorpusForTests(corpus);
        const create = vi.fn().mockResolvedValue({
            data: [{ embedding: makeVec(1) }],
        });
        __setClientForTests({ embeddings: { create } });

        await retrievePassages('same query', { topK: 1, minSimilarity: -1 });
        await retrievePassages('same query', { topK: 1, minSimilarity: -1 });

        expect(create).toHaveBeenCalledTimes(1);
    });

    it('applies the minSimilarity threshold and can return [] when nothing clears it', async () => {
        __setCorpusForTests(corpus);
        // Embedding orthogonal to every corpus vector → no matches above 0.5.
        const orthog = new Array(1536).fill(0);
        orthog[0] = 1;
        __setClientForTests({
            embeddings: {
                create: vi.fn().mockResolvedValue({ data: [{ embedding: orthog }] }),
            },
        });
        const out = await retrievePassages('totally unrelated', { topK: 4, minSimilarity: 0.9 });
        expect(out).toEqual([]);
    });
});
