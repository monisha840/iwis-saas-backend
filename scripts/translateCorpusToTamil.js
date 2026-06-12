// One-time bootstrap: translate the English RAG corpus to Tamil via gpt-4o.
//
//   node scripts/translateCorpusToTamil.js              # dry-run (no API calls)
//   node scripts/translateCorpusToTamil.js --do-translate
//   node scripts/translateCorpusToTamil.js --do-translate --only-topic-passages
//   node scripts/translateCorpusToTamil.js --do-translate --only-tips
//
// Output:
//   data/ragCorpus/topic-passages-ta.md  — Tamil mirror of topic-passages.md
//   data/ragCorpus/seed-tips-ta.json     — Tamil mirror of AYURVEDIC_TIPS
//
// Resume safety: re-running skips entries already present in the output files.
// You can interrupt with Ctrl+C and pick up where you left off.
//
// AFTER this script: MD reviews the 10 long passages line-by-line and spot-checks
// the 600 short tips. Then run scripts/buildRagIndex.js to embed everything.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { AYURVEDIC_TIPS } from '../data/ayurvedicTips.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CORPUS_DIR = path.join(REPO_ROOT, 'data', 'ragCorpus');
const EN_TOPIC_FILE = path.join(CORPUS_DIR, 'topic-passages.md');
const TA_TOPIC_FILE = path.join(CORPUS_DIR, 'topic-passages-ta.md');
const TA_TIPS_FILE = path.join(CORPUS_DIR, 'seed-tips-ta.json');

const MODEL = 'gpt-4o';
const CONCURRENCY = 5;

const args = new Set(process.argv.slice(2));
const DO_TRANSLATE = args.has('--do-translate');
const ONLY_TOPIC = args.has('--only-topic-passages');
const ONLY_TIPS = args.has('--only-tips');

const SYSTEM_PROMPT = `You are translating Ayurvedic medical content from English into clinical Tamil for an Ayurvedic clinic's patient-facing voice coach.

Rules (NEVER break these):
1. PRESERVE all Sanskrit medical and lineage terms in transliterated English form: Vata, Pitta, Kapha, Agni, Prakriti, Vikriti, Dosha, Dhatu, Ojas, Tejas, Prana, Charaka, Sushruta, Ashtanga Hridaya, Bhavaprakasha, Samhita, Sutrasthana, Chikitsa, Sandhigata, Adathodai (or Vasaka), Triphala, Haritaki, Bibhitaki, Amalaki, Brahmi, Ashwagandha, Yashtimadhu, Ghee, Hemanta, Shishira, Vasanta, Grishma, Varsha, Sharad, Ritu, Ritucharya, Abhyanga, Nidra, Ajirna, Ama. Do NOT translate these terms to native Tamil words.
2. PRESERVE all classical citations exactly as written (e.g., "Charaka Samhita Sutrasthana 6:11-14", "Bhavaprakasha Nighantu Guduchyadi Varga"). Do not translate or restructure these.
3. Use clinical, formal, respectful Tamil suitable for an adult patient reading. Avoid overly colloquial register.
4. Translate everyday terms (foods like "rice", "milk", "ginger"; times of day; body parts; weather) into natural Tamil where Tamil words exist.
5. Translate ONLY the body text. Do not add interpretation, do not omit any information present in the source.
6. Output ONLY the Tamil translation. No English commentary, no quotes around the output, no preamble like "Tamil translation:".

If a passage cannot be translated faithfully, output the literal English text unchanged — better than a wrong Tamil translation.`;

let _client = null;
function client() {
    if (_client) return _client;
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set in .env');
    }
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _client;
}

async function translateOne(text) {
    const res = await client().chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
        ],
    });
    return (res.choices?.[0]?.message?.content ?? '').trim();
}

// ── Topic passages ─────────────────────────────────────────────────────────

function parseEnglishTopicPassages(raw) {
    // Mirror the parser in scripts/buildRagIndex.js — keep behaviour identical.
    const passages = [];
    const blocks = raw.split(/^---id:\s*/m).slice(1);
    for (const block of blocks) {
        const lines = block.split('\n');
        const id = lines.shift().trim();
        const meta = { id };
        const metaLines = [];
        let bodyStart = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === '') { bodyStart = i + 1; break; }
            const m = line.match(/^(\w+):\s*(.*)$/);
            if (!m) { bodyStart = i; break; }
            metaLines.push(line);
            const [, key, val] = m;
            meta[key] = val;
        }
        const body = lines.slice(bodyStart).join('\n').trim();
        if (!body) continue;
        passages.push({ id, metaLines, body });
    }
    return passages;
}

function readExistingTaTopicIds() {
    if (!fs.existsSync(TA_TOPIC_FILE)) return new Set();
    const raw = fs.readFileSync(TA_TOPIC_FILE, 'utf8');
    const ids = new Set();
    for (const block of raw.split(/^---id:\s*/m).slice(1)) {
        const id = block.split('\n')[0].trim();
        if (id) ids.add(id);
    }
    return ids;
}

function appendTaTopicBlock({ id, metaLines, taBody }) {
    const block = [
        `---id: ${id}`,
        ...metaLines,
        '',
        taBody,
        '',
    ].join('\n');
    fs.appendFileSync(TA_TOPIC_FILE, block + '\n');
}

async function translateTopicPassages() {
    const raw = fs.readFileSync(EN_TOPIC_FILE, 'utf8');
    const all = parseEnglishTopicPassages(raw);
    const existing = readExistingTaTopicIds();
    const todo = all.filter(p => !existing.has(p.id));

    if (!fs.existsSync(TA_TOPIC_FILE)) {
        const header = [
            '# Topic Passages — Tamil corpus (generated by translateCorpusToTamil.js)',
            '',
            'Auto-translated from `topic-passages.md` via gpt-4o on a one-time pass.',
            'MD: please review each passage below for clinical accuracy. Sanskrit terms',
            'and classical citations were preserved in transliterated English form.',
            '',
            'After review: flip each passage\'s `unreviewed: true` to `false` and re-run',
            '`node scripts/buildRagIndex.js --embed`.',
            '',
            '',
        ].join('\n');
        fs.writeFileSync(TA_TOPIC_FILE, header);
    }

    console.log(`\n[translateCorpusToTamil] topic passages: ${all.length} total, ${existing.size} already translated, ${todo.length} to translate.`);
    if (!DO_TRANSLATE) {
        console.log('  Dry-run — no API calls. Re-run with --do-translate to actually translate.');
        return;
    }

    for (let i = 0; i < todo.length; i++) {
        const p = todo[i];
        process.stdout.write(`  [${i + 1}/${todo.length}] translating ${p.id}... `);
        try {
            const ta = await translateOne(p.body);
            appendTaTopicBlock({ id: p.id, metaLines: p.metaLines, taBody: ta });
            process.stdout.write('OK\n');
        } catch (err) {
            process.stdout.write(`FAILED: ${err.message}\n`);
            throw err;
        }
    }
}

// ── Daily tips ─────────────────────────────────────────────────────────────

function flattenEnglishTips() {
    // Mirror flattenTipsAsPassages() in scripts/buildRagIndex.js but only the
    // metadata we need to round-trip.
    const out = [];
    for (const [dosha, seasons] of Object.entries(AYURVEDIC_TIPS)) {
        if (dosha === 'GENERAL') {
            seasons.forEach((tip, i) => {
                out.push({
                    id: `tip-general-${String(i + 1).padStart(3, '0')}`,
                    topic: 'General Ayurvedic daily-life guidance',
                    tags: ['general', 'dinacharya', 'tip'],
                    text_en: tip,
                });
            });
            continue;
        }
        for (const [ritu, tips] of Object.entries(seasons)) {
            tips.forEach((tip, i) => {
                out.push({
                    id: `tip-${dosha.toLowerCase()}-${ritu.toLowerCase()}-${String(i + 1).padStart(2, '0')}`,
                    topic: `${dosha} guidance in ${ritu}`,
                    tags: [dosha.toLowerCase(), ritu.toLowerCase(), 'ritucharya', 'tip'],
                    text_en: tip,
                });
            });
        }
    }
    return out;
}

function readExistingTaTipsMap() {
    if (!fs.existsSync(TA_TIPS_FILE)) return new Map();
    try {
        const arr = JSON.parse(fs.readFileSync(TA_TIPS_FILE, 'utf8'));
        return new Map(arr.map(p => [p.id, p]));
    } catch (err) {
        console.warn(`[translateCorpusToTamil] could not parse existing ${TA_TIPS_FILE}, starting fresh: ${err.message}`);
        return new Map();
    }
}

function writeTaTipsMap(map) {
    const arr = [...map.values()];
    fs.writeFileSync(TA_TIPS_FILE, JSON.stringify(arr, null, 2));
}

async function runWithConcurrency(items, fn, concurrency) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

async function translateTips() {
    const all = flattenEnglishTips();
    const existing = readExistingTaTipsMap();
    const todo = all.filter(p => !existing.has(p.id));

    console.log(`\n[translateCorpusToTamil] tips: ${all.length} total, ${existing.size} already translated, ${todo.length} to translate.`);
    if (!DO_TRANSLATE) {
        console.log('  Dry-run — no API calls. Re-run with --do-translate to actually translate.');
        return;
    }

    let done = 0;
    const checkpointEvery = 20;

    await runWithConcurrency(todo, async (p) => {
        const text_ta = await translateOne(p.text_en);
        existing.set(p.id, {
            id: p.id,
            topic: p.topic,
            tags: p.tags,
            text: text_ta,
        });
        done++;
        if (done % checkpointEvery === 0) {
            writeTaTipsMap(existing);
            process.stdout.write(`  [${done}/${todo.length}] checkpoint saved.\r`);
        }
    }, CONCURRENCY);

    writeTaTipsMap(existing);
    process.stdout.write(`\n  [translateCorpusToTamil] tips done.\n`);
}

// ── Main ───────────────────────────────────────────────────────────────────

function estimateCost() {
    // Rough: ~280 tokens in (system + body avg), ~100 tokens out per tip;
    //        ~600 tokens in,                       ~600 tokens out per long passage.
    // gpt-4o: $2.50 / 1M input, $10 / 1M output.
    const tipsCount = Object.entries(AYURVEDIC_TIPS).reduce((acc, [k, v]) => {
        if (k === 'GENERAL') return acc + v.length;
        return acc + Object.values(v).reduce((a, b) => a + b.length, 0);
    }, 0);
    const longPassagesCount = 10;
    const tipsCost = tipsCount * (280 * 2.5 + 100 * 10) / 1_000_000;
    const longCost  = longPassagesCount * (600 * 2.5 + 600 * 10) / 1_000_000;
    return { tipsCount, longPassagesCount, tipsCost, longCost, total: tipsCost + longCost };
}

async function main() {
    if (!fs.existsSync(CORPUS_DIR)) fs.mkdirSync(CORPUS_DIR, { recursive: true });

    const cost = estimateCost();
    console.log('[translateCorpusToTamil] cost estimate');
    console.log(`  Long passages: ${cost.longPassagesCount} (~$${cost.longCost.toFixed(3)})`);
    console.log(`  Short tips:    ${cost.tipsCount}    (~$${cost.tipsCost.toFixed(3)})`);
    console.log(`  TOTAL:         ~$${cost.total.toFixed(3)} (one-time)`);
    console.log(`  Model:         ${MODEL}`);

    if (!DO_TRANSLATE) {
        console.log('\n[translateCorpusToTamil] DRY-RUN mode. Re-run with --do-translate to actually translate.\n');
    }

    if (ONLY_TOPIC && ONLY_TIPS) throw new Error('--only-topic-passages and --only-tips are mutually exclusive');
    if (!ONLY_TIPS) await translateTopicPassages();
    if (!ONLY_TOPIC) await translateTips();

    if (DO_TRANSLATE) {
        console.log('\n[translateCorpusToTamil] DONE.');
        console.log(`  Long passages → ${TA_TOPIC_FILE}`);
        console.log(`  Short tips    → ${TA_TIPS_FILE}`);
        console.log('  Next: MD review the long passages, then run scripts/buildRagIndex.js --embed to embed both languages.');
    }
}

main().catch(err => {
    console.error('[translateCorpusToTamil] FATAL', err);
    process.exit(1);
});
