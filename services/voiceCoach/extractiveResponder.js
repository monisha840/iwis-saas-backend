/**
 * Voice Coach — Extractive responder (no LLM at runtime).
 *
 * Drop-in alternative to VoiceCoachLLMService.generateReply. Instead of
 * sending the patient context + retrieved passages to gpt-4o-mini for prose
 * generation, this service:
 *
 *   1. Loads patient context (same buildContext call as the LLM path) — this
 *      preserves the PROFILE_INCOMPLETE safety contract.
 *   2. Detects the patient's language (override or stored preference).
 *   3. Calls retrievePassages with a language filter so Tamil queries match
 *      Tamil passages.
 *   4. Picks the 1-2 most query-relevant sentences from the top passage.
 *   5. Slots them into a language-specific template with patient name + source
 *      citation, and returns.
 *
 * No LLM call, no generation, no embedding of the patient context. Reply
 * quality depends entirely on corpus content and how well the retriever
 * scored the query. Designed to be feature-flagged in alongside the LLM path
 * so we can roll back instantly.
 *
 * Return shape matches VoiceCoachLLMService.generateReply so session.service
 * can swap between them without touching downstream code.
 */

import { VoiceCoachContextService } from './context.service.js';
import { retrievePassages } from './ragRetriever.js';
import logger from '../../lib/logger.js';

const TOP_K = 1;
const MIN_SIMILARITY = 0.2;
const SENTENCES_PER_REPLY = 2;
// Tamil text in Unicode runs ~1.5x the character count of equivalent English
// for the same spoken duration (vowel signs + grapheme clusters). Bumping the
// per-reply cap so 2-sentence Tamil snippets + citation both fit comfortably.
const MAX_REPLY_CHARS = 600;

// Small English stop-word list. Tamil queries get no stop-word filter — the
// effect on top-2 sentence selection is marginal and there's no compact
// canonical Tamil stop-word list worth importing for this.
const STOP_WORDS_EN = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do',
    'does', 'for', 'from', 'has', 'have', 'he', 'her', 'his', 'i', 'in',
    'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'she', 'should',
    'that', 'the', 'this', 'to', 'was', 'we', 'what', 'when', 'which',
    'who', 'why', 'will', 'with', 'you', 'your',
]);

function firstName(fullName) {
    if (!fullName) return null;
    const trimmed = fullName.trim();
    if (!trimmed) return null;
    return trimmed.split(/\s+/)[0];
}

function tokenize(text, language) {
    const lower = (text || '').toLowerCase();
    // Keep Unicode letters + numbers + combining marks (\p{M}). The mark class
    // is critical for Tamil — words like "வாட்டாவிற்கு" contain virama (்,
    // U+0BCD) and vowel signs that are \p{M}, not \p{L}. Without \p{M} the
    // regex would split the word into letter-shards and the test/feature
    // would never see a coherent Tamil token.
    const raw = lower.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
    if (language === 'en') {
        return raw.filter(t => t.length >= 2 && !STOP_WORDS_EN.has(t));
    }
    return raw.filter(t => t.length >= 2);
}

function splitSentences(text) {
    if (!text) return [];
    // Split on Western terminals (. ! ?) and Devanagari/Tamil danda (।).
    // Keep the splitter cheap and language-agnostic — both English and Tamil
    // passages in the corpus use Western punctuation in practice.
    return text
        .split(/(?<=[.!?।])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

function pickRelevantSentences(passageText, queryText, language, n) {
    const sentences = splitSentences(passageText);
    if (sentences.length <= n) return sentences;

    const queryTokens = new Set(tokenize(queryText, language));
    if (queryTokens.size === 0) {
        // Nothing to score against — return the first N sentences as a fallback.
        return sentences.slice(0, n);
    }

    const scored = sentences.map((sentence, idx) => {
        const sentTokens = tokenize(sentence, language);
        let overlap = 0;
        for (const t of sentTokens) {
            if (queryTokens.has(t)) overlap++;
        }
        return { sentence, idx, overlap };
    });

    // Pick top N by overlap, then restore original passage order so the reply
    // reads coherently.
    const top = [...scored]
        .sort((a, b) => b.overlap - a.overlap || a.idx - b.idx)
        .slice(0, n)
        .sort((a, b) => a.idx - b.idx);
    return top.map(t => t.sentence);
}

// Fallback used when a retrieved passage has no `sources` field. AYURVEDIC_TIPS
// entries are short daily-living one-liners curated by the clinic, not direct
// classical quotations — so we still surface a coherent citation rather than
// nothing, while making clear it's general guidance.
const GENERIC_CITATION = {
    en: 'Ayurvedic daily-living guidance',
    ta: 'பாரம்பரிய ஆயுர்வேத வாழ்க்கைமுறை வழிகாட்டுதல்',
};

function formatCitation(sources, language) {
    const joined = sources && sources.length ? sources.join('; ') : GENERIC_CITATION[language] ?? GENERIC_CITATION.en;
    return language === 'ta'
        ? ` (மூலம்: ${joined})`
        : ` (Source: ${joined})`;
}

function truncateSnippet(snippet, budget) {
    if (snippet.length <= budget) return snippet;
    const cut = snippet.slice(0, budget);
    const lastTerminal = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    return lastTerminal > budget * 0.5 ? cut.slice(0, lastTerminal + 1) : cut.trim() + '…';
}

function renderHit({ patientName, snippet, sources, language }) {
    // Citation always survives — we reserve its character budget first, then
    // truncate the snippet to fit the remaining space. Without this, long
    // Tamil snippets push the citation past MAX_REPLY_CHARS and the patient
    // never sees it.
    const nameLead = patientName ? `${patientName}, ` : '';
    const citation = formatCitation(sources, language);
    const reserved = nameLead.length + citation.length;
    const snippetBudget = Math.max(MAX_REPLY_CHARS - reserved, 80);
    const snippetText = truncateSnippet(snippet, snippetBudget);
    return `${nameLead}${snippetText}${citation}`;
}

function renderNoHit({ patientName, language }) {
    const nameLead = patientName ? `${patientName}, ` : '';
    if (language === 'ta') {
        return `${nameLead}இந்தக் கேள்விக்கு எங்கள் தரவில் தெளிவான பதில் இல்லை. தயவுசெய்து உங்கள் மருத்துவரிடம் கேளுங்கள்.`;
    }
    return `${nameLead}I don't have a curated reference for that question. Please check with your doctor at your next visit, or reach out via chat if it's urgent.`;
}

// ── Patient-data intents ─────────────────────────────────────────────────
//
// Personal questions ("who is my doctor?", "what am I taking?") have no
// answer in the Ayurvedic corpus — they require the patient's own clinical
// record. Detect these intents BEFORE retrieval and answer directly from
// the context we already loaded via buildContext.

const INTENT_DOCTOR = /\b(who(?:'?s| is) my (?:doctor|vaidya|physician|consult(?:ant|ation)|primary)|my (?:doctor|vaidya|consultation doctor)|consultation doctor)\b|என\s*(?:மருத்துவர்|வைத்தியர்)|எனது மருத்துவர்|நான் யாரிடம்/iu;
const INTENT_PRESCRIPTION = /\b(what (?:medicines?|medications?|prescriptions?)|what am i taking|my (?:current )?(?:medicines?|medications?|prescriptions?|tablets)|current medicines?|current medications?)\b|என\s*மருந்து|எனது மருந்து|நான் எடுக்கும்|என்ன மாத்திரை/iu;
const INTENT_APPOINTMENT = /\b(next (?:appointment|visit|consult)|when (?:is|do i have) (?:my|the) (?:next )?(?:appointment|visit|consult)|upcoming appointment)\b|அடுத்த சந்திப்பு|அடுத்த அப்பாயின்மென்ட்|எப்போது சந்திக்க/iu;
const INTENT_TREATMENT_PHASE = /\b(treatment phase|current phase|what (?:phase|stage)|where am i in my treatment)\b|எனது சிகிச்சை|என்ன கட்டத்தில்|சிகிச்சை கட்டம்/iu;

function detectPersonalIntent(query) {
    if (INTENT_DOCTOR.test(query)) return 'doctor';
    if (INTENT_PRESCRIPTION.test(query)) return 'prescription';
    if (INTENT_APPOINTMENT.test(query)) return 'appointment';
    if (INTENT_TREATMENT_PHASE.test(query)) return 'treatment_phase';
    return null;
}

function renderPersonalAnswer({ intent, ctx, patientName, language }) {
    const nameLead = patientName ? `${patientName}, ` : '';
    const ta = language === 'ta';

    if (intent === 'doctor') {
        const doc = ctx.doctor?.fullName ?? null;
        const docFmt = doc ? (doc.startsWith('Dr.') ? doc : `Dr. ${doc}`) : null;
        const spec = ctx.doctor?.specialization ?? null;
        if (!docFmt) {
            return ta
                ? `${nameLead}உங்களுக்கு இன்னும் ஒரு முதன்மை மருத்துவர் நியமிக்கப்படவில்லை — தயவுசெய்து கிளினிக்கைத் தொடர்பு கொள்ளுங்கள்.`
                : `${nameLead}you don't have a primary doctor assigned yet — please contact the clinic.`;
        }
        const specBit = spec ? (ta ? ` (${spec})` : ` (${spec})`) : '';
        return ta
            ? `${nameLead}உங்கள் மருத்துவர் ${docFmt}${specBit}.`
            : `${nameLead}your doctor is ${docFmt}${specBit}.`;
    }

    if (intent === 'prescription') {
        const rxs = ctx.prescriptions ?? [];
        if (rxs.length === 0) {
            return ta
                ? `${nameLead}தற்போது எந்த மருந்தும் பரிந்துரைக்கப்படவில்லை.`
                : `${nameLead}you don't have any active prescriptions right now.`;
        }
        const list = rxs.slice(0, 5).map(rx => {
            const name = rx.medicationName;
            const dose = rx.dosage ? `, ${rx.dosage}` : '';
            const freq = rx.frequency ? `, ${rx.frequency}` : '';
            return `${name}${dose}${freq}`;
        }).join('; ');
        return ta
            ? `${nameLead}உங்கள் தற்போதைய மருந்துகள்: ${list}.`
            : `${nameLead}your current medications are: ${list}.`;
    }

    if (intent === 'treatment_phase') {
        const phase = ctx.activePhase;
        if (!phase) {
            return ta
                ? `${nameLead}தற்போது நீங்கள் எந்த சிகிச்சைப் பயணத்திலும் இல்லை.`
                : `${nameLead}you're not in an active treatment journey at the moment.`;
        }
        const dayBit = phase.dayInPhase && phase.durationDays
            ? ` (${ta ? 'நாள்' : 'Day'} ${phase.dayInPhase}/${phase.durationDays})`
            : '';
        return ta
            ? `${nameLead}உங்கள் தற்போதைய சிகிச்சை கட்டம்: ${phase.name}${dayBit}.`
            : `${nameLead}your current treatment phase is ${phase.name}${dayBit}.`;
    }

    if (intent === 'appointment') {
        // buildContext doesn't currently include the next appointment. Until
        // it does, send the patient to the Appointments tab rather than guess.
        return ta
            ? `${nameLead}அடுத்த சந்திப்பின் தேதியைப் பார்க்க, ஆப்பின் "Appointments" தாவலைப் பாருங்கள் அல்லது கிளினிக்கைத் தொடர்பு கொள்ளுங்கள்.`
            : `${nameLead}for your next appointment, please check the Appointments tab in the app or contact the clinic.`;
    }

    return null;
}

export class ExtractiveResponderService {
    /**
     * Generate a coach reply for a single turn. Matches the signature of
     * VoiceCoachLLMService.generateReply for drop-in substitution.
     *
     * @param {Object}  params
     * @param {string}  params.patientId
     * @param {string}  params.userTranscript
     * @param {('ta'|'en')=} params.languageOverride
     * @returns {Promise<{ transcript, model, usage, languageUsed, retrievedPassages, contextSnapshot }>}
     */
    static async generateReply({ patientId, userTranscript, languageOverride }) {
        if (!userTranscript || !userTranscript.trim()) {
            const err = new Error('userTranscript is required');
            err.status = 400;
            throw err;
        }

        const ctx = await VoiceCoachContextService.buildContext(patientId);
        if (!ctx) {
            const err = new Error('Patient not found');
            err.status = 404;
            throw err;
        }

        const language = languageOverride === 'ta' || languageOverride === 'en'
            ? languageOverride
            : (ctx.patient.preferredCoachLang === 'en' ? 'en' : 'ta');

        const patientName = firstName(ctx.patient.fullName);
        const t0 = Date.now();

        // 1. Personal-data intents short-circuit retrieval. "Who is my doctor?",
        //    "What medicines am I taking?" etc. cannot be answered by the
        //    Ayurvedic corpus — they need the patient's own clinical record
        //    that buildContext already loaded.
        const personalIntent = detectPersonalIntent(userTranscript);
        if (personalIntent) {
            const personalReply = renderPersonalAnswer({
                intent: personalIntent,
                ctx,
                patientName,
                language,
            });
            const latencyMs = Date.now() - t0;
            logger.info('[ExtractiveResponder] personal-intent reply', {
                patientId,
                language,
                intent: personalIntent,
                replyLength: personalReply.length,
                latencyMs,
            });
            return {
                transcript: personalReply,
                model: 'extractive-rag-v1',
                usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, latencyMs },
                languageUsed: language,
                retrievedPassages: [],
                contextSnapshot: {
                    hasPrescriptions: ctx.prescriptions.length > 0,
                    hasActiveJourney: !!ctx.activePhase,
                    memoryTurns: ctx.recentMessages.length,
                    retrievedCount: 0,
                    personalIntent,
                },
            };
        }

        // 2. Corpus retrieval for non-personal questions.
        const retrieved = await retrievePassages(userTranscript, {
            topK: TOP_K,
            minSimilarity: MIN_SIMILARITY,
            language,
        }).catch(err => {
            logger.warn('[ExtractiveResponder] retrieval failed — returning no-hit reply', {
                patientId,
                error: err?.message,
            });
            return [];
        });

        let transcript;
        let usedPassage = null;
        if (retrieved.length === 0) {
            transcript = renderNoHit({ patientName, language });
        } else {
            usedPassage = retrieved[0];
            const snippet = pickRelevantSentences(
                usedPassage.text,
                userTranscript,
                language,
                SENTENCES_PER_REPLY,
            ).join(' ');
            transcript = renderHit({
                patientName,
                snippet,
                sources: usedPassage.sources,
                language,
            });
        }

        const latencyMs = Date.now() - t0;

        logger.info('[ExtractiveResponder] reply generated', {
            patientId,
            language,
            retrievedCount: retrieved.length,
            retrievedPassageId: usedPassage?.id ?? null,
            score: usedPassage?.score ?? null,
            replyLength: transcript.length,
            latencyMs,
        });

        return {
            transcript,
            // Mirror llm.service.generateReply's shape so session.service
            // doesn't need to branch on the response type. `model` carries the
            // mode label instead of an OpenAI model id.
            model: 'extractive-rag-v1',
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                latencyMs,
            },
            languageUsed: language,
            retrievedPassages: usedPassage
                ? [{ id: usedPassage.id, score: usedPassage.score }]
                : [],
            contextSnapshot: {
                hasPrescriptions: ctx.prescriptions.length > 0,
                hasActiveJourney: !!ctx.activePhase,
                memoryTurns: ctx.recentMessages.length,
                retrievedCount: retrieved.length,
            },
        };
    }
}

export default ExtractiveResponderService;
// Test-only — exported for unit tests.
export const _internals = {
    firstName,
    tokenize,
    splitSentences,
    pickRelevantSentences,
    formatCitation,
    truncateSnippet,
    renderHit,
    renderNoHit,
    detectPersonalIntent,
    renderPersonalAnswer,
};
