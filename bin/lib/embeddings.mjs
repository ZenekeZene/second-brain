/**
 * embeddings — semantic search index for the wiki.
 *
 * Generates OpenAI embeddings for all wiki articles and stores them in
 * .state/embeddings.json. At query time, embeds the query and ranks
 * articles by cosine similarity.
 *
 * Exported functions:
 *   buildIndex(root, apiKey)                       → { indexed, skipped }
 *   searchSemantic(root, query, apiKey, topK = 7)  → { slug, title, summary, score }[]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import OpenAI from 'openai';

const INDEX_PATH  = (root) => join(root, '.state', 'embeddings.json');
const MODEL       = 'text-embedding-3-small';
const MIN_SCORE   = 0.30; // minimum cosine similarity to surface a result

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  catch { return { model: MODEL, generated: null, articles: {} }; }
}

/** Extract title, summary, and text content from a wiki article. */
function extractContent(raw) {
  // Strip frontmatter
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  const title   = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
  const summary = body.match(/^>\s+(.+)$/m)?.[1]?.trim() ?? '';
  // Full body text, stripped of markdown syntax, capped at 6000 chars
  const text = body
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .slice(0, 6000);
  return { title, summary, text: `${title}\n${summary}\n${text}`.trim() };
}

// ── buildIndex ────────────────────────────────────────────────────────────────

/**
 * Generate (or refresh) the embeddings index for all wiki articles.
 * Only re-embeds articles whose `updated` frontmatter field changed.
 *
 * @param {string} root
 * @param {string} apiKey  - OpenAI API key
 * @returns {Promise<{ indexed: number, skipped: number }>}
 */
export async function buildIndex(root, apiKey) {
  const wikiDir = join(root, 'wiki');
  if (!existsSync(wikiDir)) return { indexed: 0, skipped: 0 };

  const files = readdirSync(wikiDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
  if (files.length === 0) return { indexed: 0, skipped: 0 };

  const openai = new OpenAI({ apiKey });
  const index  = readIndex(root);

  let indexed = 0, skipped = 0;

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const raw  = readFileSync(join(wikiDir, file), 'utf8');
    const updated = raw.match(/^updated:\s*(.+)$/m)?.[1]?.trim() ?? null;

    // Skip if embedding is current
    const cached = index.articles[slug];
    if (cached && cached.updated === updated && cached.embedding?.length > 0) {
      skipped++;
      continue;
    }

    const { title, summary, text } = extractContent(raw);
    const response = await openai.embeddings.create({ model: MODEL, input: text });
    const embedding = response.data[0].embedding;

    index.articles[slug] = { embedding, title, summary, updated };
    indexed++;
  }

  // Remove entries for deleted articles
  const currentSlugs = new Set(files.map(f => f.replace(/\.md$/, '')));
  for (const slug of Object.keys(index.articles)) {
    if (!currentSlugs.has(slug)) delete index.articles[slug];
  }

  index.model     = MODEL;
  index.generated = new Date().toISOString();
  writeFileSync(INDEX_PATH(root), JSON.stringify(index));

  return { indexed, skipped };
}

// ── searchSemantic ────────────────────────────────────────────────────────────

/**
 * Embed a query and return wiki articles ranked by cosine similarity.
 *
 * @param {string} root
 * @param {string} query
 * @param {string} apiKey  - OpenAI API key
 * @param {number} topK
 * @returns {Promise<{ slug: string, title: string, summary: string, score: number }[]>}
 */
export async function searchSemantic(root, query, apiKey, topK = 7) {
  const index = readIndex(root);
  const articles = index.articles || {};
  if (Object.keys(articles).length === 0) return [];

  const openai = new OpenAI({ apiKey });
  const response = await openai.embeddings.create({ model: MODEL, input: query.trim() });
  const qEmbed   = response.data[0].embedding;

  return Object.entries(articles)
    .map(([slug, data]) => ({
      slug,
      title:   data.title   || slug,
      summary: data.summary || '',
      score:   cosineSim(qEmbed, data.embedding),
    }))
    .filter(r => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
