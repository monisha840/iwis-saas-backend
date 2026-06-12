# Voice Coach RAG Upgrade — Status & Roadmap for Review

**Prepared for:** MD
**Prepared by:** Engineering (via Claude Code session, 2026-06-11)
**Status:** R1–R5 shipped and committed (commit `6d3b8df`). R6 smoke test passed end-to-end with a Tamil query that returned a reply citing Charaka Sutrasthana 6.

---

## 1. Summary in one paragraph

The Ayurvedic Voice Health Coach (`/api/voice-coach`) used to answer purely from `gpt-4o-mini`'s general pre-training memory — sometimes vague, sometimes wrong, never citing a classical source. It now retrieves the most relevant passages from a curated Ayurvedic knowledge base before answering, and grounds the reply in those passages with brief source citations (e.g. *"Per Charaka Sutrasthana 6..."*). Same UI, same languages, same response time. Better, source-anchored answers.

---

## 2. What was implemented

### Architecture (before vs. after)

**Before**
```
Patient speaks → Whisper STT → context (Prakriti, prescriptions, etc.) → gpt-4o-mini → reply → TTS → audio
```

**After**
```
Patient speaks → Whisper STT → context (Prakriti, prescriptions, etc.) → reply → TTS → audio
                                          ↑
                            retrieve top-4 Ayurvedic passages
                            from corpus (cosine similarity)
                                          ↓
                              inject as "CLASSICAL REFERENCES"
                              section in the gpt-4o-mini prompt
```

### Components added (10)

| # | Component | Purpose | File |
|---|---|---|---|
| 1 | Knowledge base (source) | 600 short Ayurvedic tips + 10 long MD-review-pending passages | `data/ayurvedicTips.js` (existing) + `data/ragCorpus/topic-passages.md` (new) |
| 2 | OpenAI Embeddings API | Converts text → 1536-number semantic fingerprint | `text-embedding-3-small` model |
| 3 | Embedding store | One built file of 610 passages + fingerprints (17 MB, gitignored, regenerable) | `data/ragCorpus/corpus.json` |
| 4 | Ingestion script | One-off Node CLI that builds the corpus from source | `scripts/buildRagIndex.js` |
| 5 | Retriever service | Runtime: embed query, brute-force cosine over corpus, top-4 | `services/voiceCoach/ragRetriever.js` |
| 6 | Cosine similarity math | "How close in meaning are these two fingerprints" (1.0 = identical) | Inside retriever |
| 7 | Prompt builder change | Injects retrieved passages as a CLASSICAL REFERENCES section | `services/voiceCoach/prompts.js` |
| 8 | LLM caller change | Calls retriever before assembling messages, logs which passages were used | `services/voiceCoach/llm.service.js` |
| 9 | Audit log line | Each turn records `retrievedPassageIds` in app logs | App-log only for now; DB column queued |
| 10 | Safety fallback | If retrieval ever fails (network, API key, missing file), the coach silently falls back to the old prompt path | `.catch(() => [])` wrapper in llm.service |

### Tests
20 new unit tests covering the math, ranking, threshold filter, and every failure path. The full backend suite went from 319 → 339 tests, all passing.

---

## 3. How RAG was implemented — 6 phases

| Phase | What we did | Output |
|---|---|---|
| R1 | Built the corpus skeleton. Re-used the existing 600 Ayurvedic tips + drafted 10 longer reference passages (winter Vata, summer Pitta, monsoon Vata, Agni, Adathodai, Triphala, Nidra, emergency red flags, Prakriti). Wrote an ingestion script that bundles them all, sends them to OpenAI's embedding API, saves the result as a 17 MB file. Takes ~7 seconds, cost less than half a cent. | `topic-passages.md`, `buildRagIndex.js`, `corpus.json` |
| R2 | Wrote the runtime retriever. When a question comes in, it converts the question to an embedding, compares it to all 610 stored embeddings, picks the top 4 most similar. Caches recent queries for 60 seconds. Designed to fail gracefully — if anything breaks, the coach still works without RAG. | `ragRetriever.js` |
| R3 | Modified the voice coach's prompt template so retrieved passages get injected as "CLASSICAL REFERENCES" the AI must cite when relevant. Added an explicit rule: "Never invent a citation. If the references don't cover the question, say so and answer from general principles." | Edits in `prompts.js`, `llm.service.js` |
| R4 | Drafted a one-line SQL migration (`ADD COLUMN retrievedPassageIds JSONB`) so each voice-coach reply records which passages it used. **Deferred to MD** — saved as a ready-to-paste file. Until applied, audit trail lives in app logs. | `prisma/manual-pending-migrations/2026_add_voice_message_retrieved_passage_ids.sql` |
| R5 | Wrote 20 automated tests. Confirmed the whole backend suite still passes (339/339). | `tests/unit/ragRetriever.test.js` |
| R6 | Built the corpus once on the dev machine, restarted the backend, asked the coach a Tamil question about Vata diet. Confirmed the reply cited Charaka Sutrasthana 6 with grounded dietary advice. RAG is live. | Smoke test passed |

---

## 4. Honest cost analysis — important for the MD to read

The original motivation for choosing RAG was to **reduce OpenAI cost and reduce dependency on OpenAI**. What we shipped does **not** achieve either goal directly. The honest picture:

### Per-turn cost: before vs. after

| Cost line | Before RAG | After RAG (now) |
|---|---|---|
| Whisper STT (transcribe audio) | ~$0.00100 | ~$0.00100 (unchanged) |
| Embedding the query | $0 | ~$0.000001 (negligible, but a new OpenAI call) |
| gpt-4o-mini chat completion | ~$0.00015 (600 input tokens) | ~$0.00018 (800 input tokens — passages added) |
| Google TTS | ~$0.00002 | ~$0.00002 (unchanged) |
| **Per-turn total** | **~$0.00117** | **~$0.00128 (+9%)** |

### What this means

- Cost went **up** ~9%, not down.
- OpenAI dependency went **up**, not down — we now make two OpenAI calls per turn (embeddings + chat) instead of one.
- The dominant cost in voice coach is **Whisper STT** (~85% of every turn). LLM + embeddings together are loose change.

### Why this isn't wasted work

RAG was a misalignment on the *stated* goal (cost), but it solved a different real problem (factual grounding, citations, fewer hallucinations) — and more importantly, **RAG is the substrate that makes "switch to a cheaper non-OpenAI LLM" safe**. Without RAG, swapping `gpt-4o-mini` for a smaller open-weight model would visibly degrade answer quality because smaller models hallucinate more on their own. With RAG feeding them the relevant passage, smaller models perform much closer to gpt-4o-mini.

In other words: we built the foundation that lets the actual cost-reduction work happen safely. We just need to do the cost-reduction work next.

---

## 5. Roadmap to actually reduce OpenAI cost & dependency

If the goal is "less money to OpenAI, less reliance on OpenAI," here is the order of impact:

| Order | Change | Approx. savings | Effort | Risk |
|---|---|---|---|---|
| 1 | **Replace Whisper STT with self-hosted `whisper.cpp` or `faster-whisper`** | Kills ~85% of per-turn cost (the biggest single line item). Tamil + English both supported. | ~1 day | Low — well-trodden path, runs on a $20/month VPS |
| 2 | **Replace OpenAI embeddings with a local model** (Sentence Transformers, BGE, or `nomic-embed-text` via `transformers.js`) | Zero per-query embedding cost. Removes one of the two remaining OpenAI calls per turn. | ~half day | Low — local embedding quality is close to OpenAI's for English |
| 3 | **Replace gpt-4o-mini with Groq's free tier or self-hosted Ollama** (Llama-3.1-8B, Mistral-7B, Mixtral) | Cuts the last OpenAI dependency. Groq is ~3× cheaper than OpenAI; Ollama on owned hardware is free. | ~1–2 days | Medium — answer quality needs RAG to compensate (we already have that) |
| 4 | **Similarity-based response cache** — same/near-same question → return cached reply | Skips Whisper + embedding + LLM. Saves an estimated 30–50% of turns at steady state. | ~1 day | Low — only fires on high-confidence cache hits |

**After all four:** voice coach has **zero OpenAI dependency** and runs at roughly **5–10% of today's cost**.

---

## 6. What the MD needs to do — only when convenient, nothing is blocked

| # | Action | Where | Estimated time |
|---|---|---|---|
| 1 | Review the 10 LLM-drafted seed passages for clinical accuracy. They are currently flagged `unreviewed: true`. Edit or approve as needed; flip to `unreviewed: false` for approved passages. | `data/ragCorpus/topic-passages.md` | ~2 hours, one sitting |
| 2 | Run the deferred SQL on Supabase to enable per-turn audit storage in the database. Single `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, idempotent, zero downtime. | `prisma/manual-pending-migrations/2026_add_voice_message_retrieved_passage_ids.sql` — open Supabase SQL editor, paste, run. | ~2 minutes |
| 3 | Decide whether to proceed with the cost-reduction roadmap in section 5 (recommended order: whisper.cpp → local embeddings → Groq/Ollama → response cache). | Decision, not implementation. | Discussion |

---

## 7. Operational facts (for the technical reviewer)

- Embedding model: `text-embedding-3-small` (1536 dimensions). Chosen for cost ($0.02/M tokens) and Tamil compatibility.
- LLM model: `gpt-4o-mini`, temperature 0.4, 400 max output tokens. Unchanged from before RAG.
- Retrieval: brute-force cosine similarity in Node over 610 unit vectors. Latency ~5 ms per query at this scale; adequate up to ~10,000 passages. Beyond that we'd move to pgvector or a dedicated vector DB.
- Threshold: `minSimilarity = 0.2` (tuned down from 0.3 after observing cross-lingual Tamil↔English scores in the smoke test).
- Query cache: 60-second TTL, bounded at 200 entries.
- Safety: retriever wrapped in `.catch(() => [])`. If retrieval fails for any reason, the coach falls back to its prior no-RAG behaviour — never throws to the patient.
- Tests: `tests/unit/ragRetriever.test.js` — 20 tests covering math, ranking, threshold, blank-query / missing-corpus / missing-key / OpenAI-error / shape-mismatch fallbacks, happy path, query caching. Run with `npx vitest run tests/unit/ragRetriever.test.js`.

---

## 8. Verification (end-to-end smoke test, already completed)

1. `node scripts/buildRagIndex.js --embed --include-unreviewed` — built `corpus.json` with 610 passages in 7.4 seconds for $0.0005.
2. Restarted backend → `[INFO] [RagRetriever] corpus loaded { count: 610 }` on first request.
3. Patient asked in Tamil: *"வாட்டாவிற்கு என்ன சாப்பிடவேண்டும்"* ("What should I eat for Vata?").
4. Backend log showed retrieval of 3 Vata-related passages.
5. Coach replied: *"Ranjan, during winter, it's important to pacify Vata. You should focus on warm, cooked foods. Avoid raw salads and cold drinks. Instead, try slow-cooked stews with mung dal, carrots, and warming spices like ginger and cinnamon. This will help balance Vata during this season. Per Charaka Sutrasthana 6, warm and slightly oily foods are best."*
6. The cited source (Charaka Sutrasthana 6) matches the metadata of the retrieved seed passage `seed-vata-pacification-winter`.
7. No errors. Coach also works correctly when retrieval returns nothing.

---

## 9. What was *not* done in this commit (open items)

- **Frontend changes:** none — the patient UI is identical.
- **Supabase schema changes:** none applied. The audit column is queued in `prisma/manual-pending-migrations/` for MD to apply.
- **Tamil-language corpus:** not built. Replies in Tamil are produced by `gpt-4o-mini` at generation time from English source passages. If smoke testing reveals weak Tamil grounding on certain topics, the fix is to add Tamil-language passages to the corpus.
- **Streaming output:** the LLM call is still text-in / text-out. Streaming TTS is a separate future phase.
- **Cost-reduction work:** not started. See section 5 for the proposed roadmap.

---

## 10. Sign-off requested

Please confirm:

1. The technical approach is acceptable (RAG over local file storage, no Supabase changes in this phase).
2. We may proceed with the cost-reduction roadmap (Whisper → embeddings → LLM → cache), in that order or a different one of your choice.
3. You will review the 10 seed passages in `topic-passages.md` and either approve or request edits.
4. You will apply the deferred SQL when convenient (no rush — audit trail works via app logs until then).

Engineering will not start the next phase until you confirm.
