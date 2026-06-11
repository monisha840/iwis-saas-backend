// One-off ingestion script for the voice-coach RAG corpus.
//
//   node scripts/buildRagIndex.js              # dry-run (no API calls)
//   node scripts/buildRagIndex.js --embed      # actually call OpenAI + write corpus.json
//   node scripts/buildRagIndex.js --embed --include-unreviewed  # include the MD-unreviewed seed passages
//
// Output: alshifa-backend/data/ragCorpus/corpus.json
//   Schema: { builtAt: ISO, model: string, dim: number, passages: Passage[] }
//   Passage: { id, source, topic, sources?, tags?, unreviewed?, text, embedding: number[1536] }

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { AYURVEDIC_TIPS } from '../data/ayurvedicTips.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CORPUS_DIR = path.join(REPO_ROOT, 'data', 'ragCorpus');
const TOPIC_FILE = path.join(CORPUS_DIR, 'topic-passages.md');
const OUTPUT_FILE = path.join(CORPUS_DIR, 'corpus.json');

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;
const BATCH_SIZE = 100;

const args = new Set(process.argv.slice(2));
const DO_EMBED = args.has('--embed');
const INCLUDE_UNREVIEWED = args.has('--include-unreviewed');

function flattenTipsAsPassages() {
  const out = [];
  for (const [dosha, seasons] of Object.entries(AYURVEDIC_TIPS)) {
    if (dosha === 'GENERAL') {
      seasons.forEach((tip, i) => {
        out.push({
          id: `tip-general-${String(i + 1).padStart(3, '0')}`,
          source: 'AYURVEDIC_TIPS',
          topic: 'General Ayurvedic daily-life guidance',
          tags: ['general', 'dinacharya', 'tip'],
          text: tip,
        });
      });
      continue;
    }
    for (const [ritu, tips] of Object.entries(seasons)) {
      tips.forEach((tip, i) => {
        out.push({
          id: `tip-${dosha.toLowerCase()}-${ritu.toLowerCase()}-${String(i + 1).padStart(2, '0')}`,
          source: 'AYURVEDIC_TIPS',
          topic: `${dosha} guidance in ${ritu}`,
          tags: [dosha.toLowerCase(), ritu.toLowerCase(), 'ritucharya', 'tip'],
          text: tip,
        });
      });
    }
  }
  return out;
}

function parseTopicPassages(rawMd) {
  const passages = [];
  const blocks = rawMd.split(/^---id:\s*/m).slice(1);
  for (const block of blocks) {
    const lines = block.split('\n');
    const id = lines.shift().trim();
    const meta = { id, source: 'TOPIC_PASSAGES' };
    let bodyStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') { bodyStart = i + 1; break; }
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (!m) { bodyStart = i; break; }
      const [, key, val] = m;
      if (key === 'tags' || key === 'sources') {
        meta[key] = val.split(',').map(s => s.trim()).filter(Boolean);
      } else if (key === 'unreviewed') {
        meta.unreviewed = val.trim() === 'true';
      } else {
        meta[key] = val.trim();
      }
    }
    const body = lines.slice(bodyStart).join('\n').trim();
    if (!body) continue;
    passages.push({ ...meta, text: body });
  }
  return passages;
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

async function embedBatch(openai, inputs) {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: inputs });
  return res.data.map(d => d.embedding);
}

async function main() {
  if (!fs.existsSync(CORPUS_DIR)) fs.mkdirSync(CORPUS_DIR, { recursive: true });

  const tipPassages = flattenTipsAsPassages();

  let topicPassages = [];
  if (fs.existsSync(TOPIC_FILE)) {
    const raw = fs.readFileSync(TOPIC_FILE, 'utf8');
    topicPassages = parseTopicPassages(raw);
  } else {
    console.warn(`[buildRagIndex] No topic-passages.md found at ${TOPIC_FILE} — proceeding with tips only.`);
  }

  if (!INCLUDE_UNREVIEWED) {
    const before = topicPassages.length;
    topicPassages = topicPassages.filter(p => !p.unreviewed);
    const skipped = before - topicPassages.length;
    if (skipped > 0) {
      console.log(`[buildRagIndex] Skipping ${skipped} unreviewed topic passages (re-run with --include-unreviewed to embed them).`);
    }
  }

  const all = [...tipPassages, ...topicPassages];
  const totalTokens = all.reduce((sum, p) => sum + estimateTokens(p.text), 0);
  const costUsd = (totalTokens / 1_000_000) * 0.02;

  console.log('\n[buildRagIndex] Corpus summary');
  console.log(`  Seed tips:        ${tipPassages.length}`);
  console.log(`  Topic passages:   ${topicPassages.length}`);
  console.log(`  Total passages:   ${all.length}`);
  console.log(`  Estimated tokens: ${totalTokens.toLocaleString()}`);
  console.log(`  Embed model:      ${EMBED_MODEL}`);
  console.log(`  Estimated cost:   $${costUsd.toFixed(4)} (one-time)`);

  if (!DO_EMBED) {
    console.log('\n[buildRagIndex] Dry-run mode. Re-run with --embed to call OpenAI and write corpus.json.');
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('\n[buildRagIndex] OPENAI_API_KEY not set. Aborting.');
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log(`\n[buildRagIndex] Embedding ${all.length} passages in batches of ${BATCH_SIZE}...`);
  const startedAt = Date.now();
  const embedded = [];
  for (let i = 0; i < all.length; i += BATCH_SIZE) {
    const batch = all.slice(i, i + BATCH_SIZE);
    const inputs = batch.map(p => p.text);
    const vectors = await embedBatch(openai, inputs);
    batch.forEach((p, j) => embedded.push({ ...p, embedding: vectors[j] }));
    process.stdout.write(`  embedded ${Math.min(i + BATCH_SIZE, all.length)}/${all.length}\r`);
  }
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[buildRagIndex] Done in ${elapsedSec}s.`);

  const payload = {
    builtAt: new Date().toISOString(),
    model: EMBED_MODEL,
    dim: EMBED_DIM,
    passages: embedded,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload));
  const sizeMb = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2);
  console.log(`[buildRagIndex] Wrote ${OUTPUT_FILE} (${sizeMb} MB)`);
}

main().catch(err => {
  console.error('[buildRagIndex] FATAL', err);
  process.exit(1);
});
