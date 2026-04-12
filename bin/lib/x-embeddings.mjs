/**
 * Semantic search index for X/Twitter bookmarks.
 * Mirrors the pattern of bin/lib/embeddings.mjs for wiki articles.
 *
 * Index stored in .state/x-embeddings.json
 * Each entry keyed by tweet ID: { embedding, text, updated }
 *
 * Exported:
 *   buildXIndex(root, apiKey)                        → { indexed, skipped }
 *   searchXSemantic(root, query, apiKey, topK = 50)  → { id, score }[]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import OpenAI from 'openai';

const INDEX_PATH = (root) => join(root, '.state', 'x-embeddings.json');
const MODEL      = 'text-embedding-3-small';
const MIN_SCORE  = 0.30;

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function readIndex(root) {
  try { return JSON.parse(readFileSync(INDEX_PATH(root), 'utf8')); }
  catch { return { model: MODEL, generated: null, tweets: {} }; }
}

/** Text to embed for a tweet: strip t.co URLs, keep author + content. */
function tweetEmbedText(t) {
  const handle = t.authorHandle || t.author_handle || '';
  const text = (t.text || t.full_text || '')
    .replace(/https?:\/\/t\.co\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `@${handle}: ${text}`.trim().slice(0, 1000);
}

// ── buildXIndex ───────────────────────────────────────────────────────────────

/**
 * Generate (or refresh) the embeddings index for all X bookmarks.
 * Only embeds tweets not already in the index.
 *
 * @param {string} root
 * @param {string} apiKey  - OpenAI API key
 * @returns {Promise<{ indexed: number, skipped: number }>}
 */
export async function buildXIndex(root, apiKey) {
  const dir = join(root, 'raw', 'x-bookmarks');
  if (!existsSync(dir)) return { indexed: 0, skipped: 0 };

  const openai = new OpenAI({ apiKey });
  const index  = readIndex(root);

  // Collect all tweets from JSONL files
  const tweets = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { tweets.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }

  let indexed = 0, skipped = 0;

  // Batch embed in groups of 100 (OpenAI allows up to 2048 inputs per request)
  const toIndex = tweets.filter(t => {
    const id = String(t.id || t.tweetId || '');
    return id && !index.tweets[id];
  });

  const BATCH = 100;
  for (let i = 0; i < toIndex.length; i += BATCH) {
    const batch = toIndex.slice(i, i + BATCH);
    const inputs = batch.map(tweetEmbedText);
    const response = await openai.embeddings.create({ model: MODEL, input: inputs });
    for (let j = 0; j < batch.length; j++) {
      const id = String(batch[j].id || batch[j].tweetId || '');
      if (!id) continue;
      index.tweets[id] = {
        embedding: response.data[j].embedding,
        text: inputs[j],
      };
      indexed++;
    }
  }

  skipped = tweets.length - toIndex.length;

  // Remove entries for tweets that no longer exist in any JSONL
  const allIds = new Set(tweets.map(t => String(t.id || t.tweetId || '')).filter(Boolean));
  for (const id of Object.keys(index.tweets)) {
    if (!allIds.has(id)) delete index.tweets[id];
  }

  index.model     = MODEL;
  index.generated = new Date().toISOString();
  writeFileSync(INDEX_PATH(root), JSON.stringify(index));

  return { indexed, skipped };
}

// ── searchXSemantic ───────────────────────────────────────────────────────────

/**
 * Embed a query and return tweet IDs ranked by cosine similarity.
 * Returns empty array if index doesn't exist.
 *
 * @param {string} root
 * @param {string} query
 * @param {string} apiKey
 * @param {number} topK
 * @returns {Promise<{ id: string, score: number }[]>}
 */
export async function searchXSemantic(root, query, apiKey, topK = 100) {
  const index = readIndex(root);
  const tweets = index.tweets || {};
  if (Object.keys(tweets).length === 0) return [];

  const openai = new OpenAI({ apiKey });
  const response = await openai.embeddings.create({ model: MODEL, input: query.trim() });
  const qEmbed   = response.data[0].embedding;

  return Object.entries(tweets)
    .map(([id, data]) => ({ id, score: cosineSim(qEmbed, data.embedding) }))
    .filter(r => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** Returns true if the index exists and has entries. */
export function xIndexExists(root) {
  try {
    const idx = JSON.parse(readFileSync(INDEX_PATH(root), 'utf8'));
    return Object.keys(idx.tweets || {}).length > 0;
  } catch { return false; }
}
