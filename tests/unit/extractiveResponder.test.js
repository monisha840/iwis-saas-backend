/**
 * ExtractiveResponder — unit tests.
 *
 * Covers:
 *   1. Pure helpers (firstName, tokenize, splitSentences, pickRelevantSentences,
 *      formatCitation, truncateForVoice, renderHit, renderNoHit)
 *   2. generateReply integration with mocked context + retriever (English and
 *      Tamil paths, no-hit fallback, retrieval failure fallback, language
 *      override, PROFILE_INCOMPLETE propagation)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the two collaborators BEFORE importing the responder so its top-level
// imports get our doubles instead of the real services (which would try to
// open Prisma and OpenAI).
const buildContextMock = vi.fn();
const retrievePassagesMock = vi.fn();

vi.mock('../../services/voiceCoach/context.service.js', () => ({
    VoiceCoachContextService: { buildContext: (...a) => buildContextMock(...a) },
}));

vi.mock('../../services/voiceCoach/ragRetriever.js', () => ({
    retrievePassages: (...a) => retrievePassagesMock(...a),
}));

const { ExtractiveResponderService, _internals } = await import(
    '../../services/voiceCoach/extractiveResponder.js'
);

beforeEach(() => {
    buildContextMock.mockReset();
    retrievePassagesMock.mockReset();
});

// ── Helpers ───────────────────────────────────────────────────────────────

describe('firstName', () => {
    it('returns first whitespace-delimited token', () => {
        expect(_internals.firstName('Ranjan Kumar Patel')).toBe('Ranjan');
    });
    it('handles single-word names', () => {
        expect(_internals.firstName('Maalik')).toBe('Maalik');
    });
    it('returns null for empty / null inputs', () => {
        expect(_internals.firstName('')).toBeNull();
        expect(_internals.firstName(null)).toBeNull();
        expect(_internals.firstName('   ')).toBeNull();
    });
});

describe('tokenize', () => {
    it('drops English stop-words and short tokens', () => {
        const out = _internals.tokenize('What should I eat for Vata in winter?', 'en');
        // 'what', 'should', 'i', 'for', 'in' are all dropped (stop-words / length).
        expect(out).toEqual(['eat', 'vata', 'winter']);
    });
    it('lowercases and strips punctuation', () => {
        const out = _internals.tokenize('Adathodai, Triphala — both!', 'en');
        expect(out).toEqual(['adathodai', 'triphala', 'both']);
    });
    it('keeps Tamil tokens without stop-word filtering', () => {
        const out = _internals.tokenize('வாட்டாவிற்கு என்ன சாப்பிட', 'ta');
        expect(out.length).toBeGreaterThanOrEqual(2);
        expect(out.every(t => /[\p{L}\p{N}]+/u.test(t))).toBe(true);
    });
});

describe('splitSentences', () => {
    it('splits on Western terminals', () => {
        const out = _internals.splitSentences('First sentence. Second one! Third?');
        expect(out).toEqual(['First sentence.', 'Second one!', 'Third?']);
    });
    it('returns [] for empty / null', () => {
        expect(_internals.splitSentences('')).toEqual([]);
        expect(_internals.splitSentences(null)).toEqual([]);
    });
});

describe('pickRelevantSentences', () => {
    const passage = 'Warm sesame oil massages help pacify Vata in winter. Drink ginger tea after meals. Avoid cold drinks and raw salads. Sleep before ten.';

    it('picks top-N by query keyword overlap', () => {
        const out = _internals.pickRelevantSentences(passage, 'vata winter cold', 'en', 2);
        expect(out.length).toBe(2);
        // "Vata in winter" sentence and the "cold drinks" sentence should win.
        expect(out[0]).toContain('Vata in winter');
        expect(out[1]).toContain('cold drinks');
    });

    it('preserves original passage order in the output', () => {
        const out = _internals.pickRelevantSentences(passage, 'cold vata winter', 'en', 2);
        const idx0 = passage.indexOf(out[0]);
        const idx1 = passage.indexOf(out[1]);
        expect(idx0).toBeLessThan(idx1);
    });

    it('returns all sentences when there are fewer than N', () => {
        const out = _internals.pickRelevantSentences('Only one sentence.', 'anything', 'en', 3);
        expect(out).toEqual(['Only one sentence.']);
    });

    it('falls back to first-N when query has no useful tokens', () => {
        const out = _internals.pickRelevantSentences(passage, 'the a is', 'en', 2);
        expect(out).toEqual(_internals.splitSentences(passage).slice(0, 2));
    });
});

describe('formatCitation', () => {
    it('formats English citation', () => {
        expect(_internals.formatCitation(['Charaka Sutrasthana 6'], 'en'))
            .toBe(' (Source: Charaka Sutrasthana 6)');
    });
    it('formats Tamil citation', () => {
        expect(_internals.formatCitation(['Charaka Sutrasthana 6'], 'ta'))
            .toBe(' (மூலம்: Charaka Sutrasthana 6)');
    });
    it('joins multiple sources with semicolons', () => {
        expect(_internals.formatCitation(['Charaka', 'Sushruta'], 'en'))
            .toBe(' (Source: Charaka; Sushruta)');
    });
    it('returns a generic citation when no sources are present', () => {
        // Tips have no `sources` field; we still surface a coherent citation
        // so every reply has some attribution.
        expect(_internals.formatCitation(undefined, 'en')).toBe(' (Source: Ayurvedic daily-living guidance)');
        expect(_internals.formatCitation([], 'ta')).toBe(' (மூலம்: பாரம்பரிய ஆயுர்வேத வாழ்க்கைமுறை வழிகாட்டுதல்)');
    });
});

describe('truncateSnippet', () => {
    it('returns text unchanged when under the cap', () => {
        const text = 'Short reply.';
        expect(_internals.truncateSnippet(text, 320)).toBe(text);
    });
    it('cuts at the last sentence terminal when overflowing', () => {
        const long = 'A. ' + 'B'.repeat(200) + '. ' + 'C'.repeat(200) + '.';
        const out = _internals.truncateSnippet(long, 320);
        expect(out.length).toBeLessThanOrEqual(320);
        expect(out.endsWith('.')).toBe(true);
    });
});

describe('detectPersonalIntent', () => {
    it('detects doctor questions in English', () => {
        expect(_internals.detectPersonalIntent('who is my doctor')).toBe('doctor');
        expect(_internals.detectPersonalIntent('Who is my consultation doctor?')).toBe('doctor');
        expect(_internals.detectPersonalIntent('my vaidya?')).toBe('doctor');
    });
    it('detects doctor questions in Tamil', () => {
        expect(_internals.detectPersonalIntent('என மருத்துவர் யார்?')).toBe('doctor');
    });
    it('detects prescription questions', () => {
        expect(_internals.detectPersonalIntent('what medicine am I taking?')).toBe('prescription');
        expect(_internals.detectPersonalIntent('my current medications')).toBe('prescription');
    });
    it('detects appointment questions', () => {
        expect(_internals.detectPersonalIntent('when is my next appointment')).toBe('appointment');
        expect(_internals.detectPersonalIntent('upcoming appointment')).toBe('appointment');
    });
    it('detects treatment-phase questions', () => {
        expect(_internals.detectPersonalIntent('what treatment phase am I in')).toBe('treatment_phase');
    });
    it('returns null for general questions', () => {
        expect(_internals.detectPersonalIntent('what food helps Vata')).toBeNull();
        expect(_internals.detectPersonalIntent('how does Adathodai work')).toBeNull();
    });
});

describe('renderPersonalAnswer', () => {
    const baseCtx = {
        doctor: { fullName: 'Saleem', specialization: 'Ayurveda' },
        prescriptions: [{ medicationName: 'Adathodai', dosage: '1 tbsp', frequency: 'BD' }],
        activePhase: { name: 'Detox', dayInPhase: 3, durationDays: 7 },
    };

    it('doctor intent uses ctx.doctor.fullName', () => {
        const out = _internals.renderPersonalAnswer({
            intent: 'doctor', ctx: baseCtx, patientName: 'Ranjan', language: 'en',
        });
        expect(out).toBe('Ranjan, your doctor is Dr. Saleem (Ayurveda).');
    });
    it('doctor intent in Tamil', () => {
        const out = _internals.renderPersonalAnswer({
            intent: 'doctor', ctx: baseCtx, patientName: 'Ranjan', language: 'ta',
        });
        expect(out).toContain('Ranjan');
        expect(out).toContain('Dr. Saleem');
    });
    it('prescription intent lists active medications', () => {
        const out = _internals.renderPersonalAnswer({
            intent: 'prescription', ctx: baseCtx, patientName: 'Ranjan', language: 'en',
        });
        expect(out).toContain('Adathodai');
        expect(out).toContain('1 tbsp');
        expect(out).toContain('BD');
    });
    it('prescription intent handles no active prescriptions', () => {
        const out = _internals.renderPersonalAnswer({
            intent: 'prescription',
            ctx: { ...baseCtx, prescriptions: [] },
            patientName: 'Ranjan',
            language: 'en',
        });
        expect(out).toContain("don't have any active prescriptions");
    });
    it('treatment_phase intent returns the phase name + day', () => {
        const out = _internals.renderPersonalAnswer({
            intent: 'treatment_phase', ctx: baseCtx, patientName: 'Ranjan', language: 'en',
        });
        expect(out).toContain('Detox');
        expect(out).toContain('Day 3/7');
    });
    it('appointment intent points to Appointments tab', () => {
        const out = _internals.renderPersonalAnswer({
            intent: 'appointment', ctx: baseCtx, patientName: 'Ranjan', language: 'en',
        });
        expect(out).toContain('Appointments tab');
    });
});

describe('renderHit preserves citation', () => {
    it('keeps the Tamil citation even when snippet is very long', () => {
        const longTamil = 'வாட்டாவை சமன்படுத்த வெண்ணெய்ய தடவவும். '.repeat(20);
        const out = _internals.renderHit({
            patientName: 'Syed',
            snippet: longTamil,
            sources: ['Charaka Samhita Sutrasthana 6'],
            language: 'ta',
        });
        expect(out).toContain('(மூலம்: Charaka Samhita Sutrasthana 6)');
        expect(out.startsWith('Syed,')).toBe(true);
    });
    it('keeps the English citation when snippet is very long', () => {
        const longEnglish = 'Warm sesame oil grounds Vata. '.repeat(40);
        const out = _internals.renderHit({
            patientName: 'Ranjan',
            snippet: longEnglish,
            sources: ['Charaka Sutrasthana 6'],
            language: 'en',
        });
        expect(out).toContain('(Source: Charaka Sutrasthana 6)');
        expect(out.startsWith('Ranjan,')).toBe(true);
    });
});

describe('renderHit and renderNoHit', () => {
    it('renderHit composes "${name}, ${snippet} (Source: ...)"', () => {
        const out = _internals.renderHit({
            patientName: 'Ranjan',
            snippet: 'Warm foods pacify Vata.',
            sources: ['Charaka Sutrasthana 6'],
            language: 'en',
        });
        expect(out).toBe('Ranjan, Warm foods pacify Vata. (Source: Charaka Sutrasthana 6)');
    });

    it('renderHit handles missing patient name', () => {
        const out = _internals.renderHit({
            patientName: null,
            snippet: 'Warm foods pacify Vata.',
            sources: ['Charaka'],
            language: 'en',
        });
        expect(out).toBe('Warm foods pacify Vata. (Source: Charaka)');
    });

    it('renderNoHit returns the English fallback', () => {
        const out = _internals.renderNoHit({ patientName: 'Ranjan', language: 'en' });
        expect(out).toContain('Ranjan');
        expect(out).toContain("don't have a curated reference");
    });

    it('renderNoHit returns the Tamil fallback', () => {
        const out = _internals.renderNoHit({ patientName: 'Ranjan', language: 'ta' });
        expect(out).toContain('Ranjan');
        expect(out).toContain('மருத்துவரிடம்');
    });
});

// ── generateReply integration ─────────────────────────────────────────────

function ctxFor({ name = 'Ranjan Kumar', lang = 'ta' } = {}) {
    return {
        patient: { fullName: name, preferredCoachLang: lang },
        doctor: { fullName: 'Dr. Saleem', specialization: 'Ayurveda', assignmentType: 'PRIMARY' },
        prescriptions: [],
        recentCheckIns: [],
        recentVitals: [],
        recentMessages: [],
        activePhase: null,
    };
}

describe('ExtractiveResponderService.generateReply', () => {
    it('rejects an empty transcript', async () => {
        await expect(
            ExtractiveResponderService.generateReply({ patientId: 'p1', userTranscript: '' })
        ).rejects.toThrow(/userTranscript is required/);
    });

    it('propagates PROFILE_INCOMPLETE from context build', async () => {
        const err = new Error('No primary doctor');
        err.code = 'PROFILE_INCOMPLETE';
        buildContextMock.mockRejectedValueOnce(err);

        await expect(
            ExtractiveResponderService.generateReply({ patientId: 'p1', userTranscript: 'hello' })
        ).rejects.toThrow(/No primary doctor/);
    });

    it('returns a templated English reply when a passage is retrieved', async () => {
        buildContextMock.mockResolvedValueOnce(ctxFor({ name: 'Ranjan', lang: 'en' }));
        retrievePassagesMock.mockResolvedValueOnce([
            {
                id: 'seed-vata-pacification-winter',
                source: 'TOPIC_PASSAGES',
                topic: 'Vata in winter',
                sources: ['Charaka Sutrasthana 6'],
                tags: ['vata'],
                language: 'en',
                text: 'Warm sesame oil grounds Vata. Drink ginger tea after meals. Avoid cold drinks.',
                score: 0.31,
            },
        ]);

        const out = await ExtractiveResponderService.generateReply({
            patientId: 'p1',
            userTranscript: 'What food helps Vata in winter?',
        });

        expect(out.model).toBe('extractive-rag-v1');
        expect(out.languageUsed).toBe('en');
        expect(out.transcript.startsWith('Ranjan,')).toBe(true);
        expect(out.transcript).toContain('(Source: Charaka Sutrasthana 6)');
        expect(out.retrievedPassages).toEqual([
            { id: 'seed-vata-pacification-winter', score: 0.31 },
        ]);
        expect(retrievePassagesMock).toHaveBeenCalledWith(
            'What food helps Vata in winter?',
            expect.objectContaining({ topK: 1, language: 'en' }),
        );
    });

    it('returns a Tamil reply when the patient prefers Tamil', async () => {
        buildContextMock.mockResolvedValueOnce(ctxFor({ name: 'Ranjan', lang: 'ta' }));
        retrievePassagesMock.mockResolvedValueOnce([
            {
                id: 'seed-vata-pacification-winter-ta',
                source: 'TOPIC_PASSAGES',
                topic: 'Vata winter',
                sources: ['Charaka Sutrasthana 6'],
                tags: ['vata'],
                language: 'ta',
                text: 'வாட்டாவை குளிர்காலத்தில் சமன்படுத்த சூடான எண்ணெய் தடவவும். கருஞ்சீரக டீ அருந்துங்கள்.',
                score: 0.28,
            },
        ]);

        const out = await ExtractiveResponderService.generateReply({
            patientId: 'p1',
            userTranscript: 'வாட்டாவிற்கு என்ன சாப்பிட',
        });

        expect(out.languageUsed).toBe('ta');
        expect(out.transcript.startsWith('Ranjan,')).toBe(true);
        expect(out.transcript).toContain('மூலம்: Charaka Sutrasthana 6');
        expect(retrievePassagesMock).toHaveBeenCalledWith(
            'வாட்டாவிற்கு என்ன சாப்பிட',
            expect.objectContaining({ language: 'ta' }),
        );
    });

    it('honours languageOverride over the patient preference', async () => {
        buildContextMock.mockResolvedValueOnce(ctxFor({ name: 'Ranjan', lang: 'ta' }));
        retrievePassagesMock.mockResolvedValueOnce([]);

        const out = await ExtractiveResponderService.generateReply({
            patientId: 'p1',
            userTranscript: 'What food helps Vata?',
            languageOverride: 'en',
        });

        expect(out.languageUsed).toBe('en');
        expect(out.transcript).toContain("don't have a curated reference");
        expect(retrievePassagesMock).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ language: 'en' }),
        );
    });

    it('returns a no-hit reply when retrieval returns []', async () => {
        buildContextMock.mockResolvedValueOnce(ctxFor({ name: 'Maalik', lang: 'en' }));
        retrievePassagesMock.mockResolvedValueOnce([]);

        const out = await ExtractiveResponderService.generateReply({
            patientId: 'p2',
            userTranscript: 'Some totally unrelated question',
        });

        expect(out.transcript).toContain('Maalik');
        expect(out.transcript).toContain("don't have a curated reference");
        expect(out.retrievedPassages).toEqual([]);
        expect(out.contextSnapshot.retrievedCount).toBe(0);
    });

    it('falls back to no-hit reply when retrieval throws', async () => {
        buildContextMock.mockResolvedValueOnce(ctxFor({ name: 'Maalik', lang: 'en' }));
        retrievePassagesMock.mockRejectedValueOnce(new Error('OpenAI is down'));

        const out = await ExtractiveResponderService.generateReply({
            patientId: 'p2',
            userTranscript: 'anything',
        });

        expect(out.transcript).toContain("don't have a curated reference");
        expect(out.retrievedPassages).toEqual([]);
    });
});
