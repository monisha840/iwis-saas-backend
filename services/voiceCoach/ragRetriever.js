/**
 * Voice Coach — RAG retrieval.
 *
 * Loads the embedded passage corpus from data/ragCorpus/corpus.json (built by
 * scripts/buildRagIndex.js), embeds the patient's query at request time, and
 * returns the top-K most similar passages by cosine similarity.
 *
 * Safety: this module never throws on the hot path. If the corpus is missing,
 * the OpenAI call fails, or the embedding shape is wrong, retrievePassages()
 * returns an empty array and the caller (llm.service.js) falls back to the
 * existing no-RAG prompt — voice coach must keep working when RAG is down.
 *
 * Scale: brute-force cosine over a JS array. Adequate up to ~10k passages
 * (~50 ms per query). Migrate to pgvector when scale demands it.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import logger from '../../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_FILE = path.resolve(__dirname, '..', '..', 'data', 'ragCorpus', 'corpus.json');

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;
const QUERY_CACHE_TTL_MS = 60_000;
const DEFAULT_TOP_K = 4;
// Tuned for cross-lingual retrieval (Tamil queries against an English corpus).
// text-embedding-3-small scores Tamil↔English pairs noticeably lower than
// English↔English; 0.3 filters good matches out. 0.2 keeps semantic noise out
// while letting cross-lingual matches through.
const DEFAULT_MIN_SIMILARITY = 0.2;

let _client = null;
function client() {
    if (_client) return _client;
    if (!process.env.OPENAI_API_KEY) return null;
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _client;
}

let _corpus = null;
let _corpusLoadAttempted = false;

function loadCorpus() {
    if (_corpusLoadAttempted) return _corpus;
    _corpusLoadAttempted = true;
    try {
        if (!fs.existsSync(CORPUS_FILE)) {
            logger.warn('[RagRetriever] corpus.json not found — RAG disabled', { path: CORPUS_FILE });
            return null;
        }
        const raw = fs.readFileSync(CORPUS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed?.passages?.length) {
            logger.warn('[RagRetriever] corpus.json has no passages — RAG disabled');
            return null;
        }
        if (parsed.dim && parsed.dim !== EMBED_DIM) {
            logger.warn('[RagRetriever] corpus dim mismatch — RAG disabled', {
                expected: EMBED_DIM,
                found: parsed.dim,
            });
            return null;
        }
        logger.info('[RagRetriever] corpus loaded', {
            count: parsed.passages.length,
            model: parsed.model,
            builtAt: parsed.builtAt,
        });
        _corpus = parsed.passages;
        return _corpus;
    } catch (err) {
        logger.error('[RagRetriever] failed to load corpus', err);
        return null;
    }
}

const _queryCache = new Map();

function getCachedEmbedding(query) {
    const entry = _queryCache.get(query);
    if (!entry) return null;
    if (Date.now() - entry.at > QUERY_CACHE_TTL_MS) {
        _queryCache.delete(query);
        return null;
    }
    return entry.embedding;
}

function setCachedEmbedding(query, embedding) {
    if (_queryCache.size > 200) {
        const oldest = _queryCache.keys().next().value;
        _queryCache.delete(oldest);
    }
    _queryCache.set(query, { embedding, at: Date.now() });
}

async function embedQuery(queryText) {
    const cached = getCachedEmbedding(queryText);
    if (cached) return cached;
    const oai = client();
    if (!oai) return null;
    try {
        const res = await oai.embeddings.create({ model: EMBED_MODEL, input: queryText });
        const vec = res?.data?.[0]?.embedding;
        if (!vec || vec.length !== EMBED_DIM) {
            logger.warn('[RagRetriever] unexpected embedding shape', { length: vec?.length });
            return null;
        }
        setCachedEmbedding(queryText, vec);
        return vec;
    } catch (err) {
        logger.warn('[RagRetriever] embedding API failed — falling back to no-RAG', {
            error: err?.message,
        });
        return null;
    }
}

export function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
}

// Topic passages are clinically-reviewed classical references with sources;
// tips are short daily-living one-liners without citations. We prefer topic
// passages over tips when both score similarly so the patient gets an
// authoritative, cited answer instead of a random matching tip.
const TOPIC_PASSAGE_BONUS = 0.05;

function effectiveScore(passage, rawScore) {
    if (passage.source === 'TOPIC_PASSAGES') return rawScore + TOPIC_PASSAGE_BONUS;
    return rawScore;
}

// Detect dosha keywords in the query (English or Tamil) so we can prefer
// passages tagged with that dosha. Soft-filter: we drop non-matching
// passages only if matching ones exist; otherwise fall through to scoring
// the whole corpus.
function detectDoshaTag(queryText) {
    const lower = (queryText || '').toLowerCase();
    if (/\b(vata|வாட்டா|வாதா)\b/u.test(lower)) return 'vata';
    if (/\b(pitta|பித்தா)\b/u.test(lower)) return 'pitta';
    if (/\b(kapha|கபா|கபம்)\b/u.test(lower)) return 'kapha';
    return null;
}

export function topK(queryVec, passages, k, minSimilarity) {
    if (!queryVec || !passages?.length) return [];
    const scored = [];
    for (const p of passages) {
        const score = cosineSimilarity(queryVec, p.embedding);
        if (score >= minSimilarity) {
            scored.push({ passage: p, score, adjusted: effectiveScore(p, score) });
        }
    }
    scored.sort((a, b) => b.adjusted - a.adjusted);
    return scored.slice(0, k).map(({ passage, score }) => ({ passage, score }));
}

/**
 * Retrieve the top-K passages most relevant to the patient query.
 *
 * @param {string} queryText
 * @param {{ topK?: number, minSimilarity?: number, language?: 'en'|'ta' }} [opts]
 *   When `language` is set, only passages tagged with that language are
 *   scored. When omitted, all passages in the corpus are eligible (back-
 *   compat with the pre-bilingual corpus).
 * @returns {Promise<Array<{ id, source, topic, sources?, tags?, language?, text, score }>>}
 *   Empty array when RAG is disabled, the corpus is missing, or the query is
 *   blank — callers MUST treat empty as "fall back to no-RAG prompt".
 */
export async function retrievePassages(queryText, opts = {}) {
    if (!queryText || !queryText.trim()) return [];
    const k = opts.topK ?? DEFAULT_TOP_K;
    const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    const language = opts.language;

    const corpus = loadCorpus();
    if (!corpus) return [];

    // Filter by language when requested. Pre-bilingual corpora have no
    // language field on passages; in that case we keep all of them so the
    // retriever still works during the cutover window.
    let filtered = language
        ? corpus.filter(p => !p.language || p.language === language)
        : corpus;
    if (!filtered.length) return [];

    // Soft dosha-tag filter. When the query explicitly names a dosha,
    // restrict to passages tagged with that dosha so a Vata question can't
    // retrieve a Pitta watermelon tip. If the filter would empty the
    // candidate set, fall through to scoring the unfiltered subset.
    const doshaTag = detectDoshaTag(queryText);
    if (doshaTag) {
        const doshaSubset = filtered.filter(p => Array.isArray(p.tags) && p.tags.includes(doshaTag));
        if (doshaSubset.length > 0) filtered = doshaSubset;
    }

    const queryVec = await embedQuery(queryText.trim());
    if (!queryVec) return [];

    const hits = topK(queryVec, filtered, k, minSim);

    // Always log the top-3 raw scores (no threshold) so we can tune from real
    // data even when the threshold filtered everything. Cheap — k=3 over the
    // language-filtered subset is microseconds and we already computed scores.
    const top3Raw = topK(queryVec, filtered, 3, -1);
    logger.info('[RagRetriever] retrieval scores', {
        queryPreview: queryText.slice(0, 60),
        language: language ?? 'any',
        candidateCount: filtered.length,
        top3: top3Raw.map(r => ({ id: r.passage.id, score: Number(r.score.toFixed(4)) })),
        kept: hits.length,
        threshold: minSim,
    });

    return hits.map(({ passage, score }) => ({
        id: passage.id,
        source: passage.source,
        topic: passage.topic,
        sources: passage.sources,
        tags: passage.tags,
        language: passage.language,
        text: passage.text,
        score: Number(score.toFixed(4)),
    }));
}

/** Test-only: reset internal caches between unit tests. */
export function __resetForTests() {
    _corpus = null;
    _corpusLoadAttempted = false;
    _client = null;
    _queryCache.clear();
}

/** Test-only: inject a corpus directly so tests don't need a real corpus.json. */
export function __setCorpusForTests(passages) {
    _corpus = passages;
    _corpusLoadAttempted = true;
}

/** Test-only: inject a fake OpenAI client. */
export function __setClientForTests(fakeClient) {
    _client = fakeClient;
}
