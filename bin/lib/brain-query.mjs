/**
 * brain-query — Search the wiki and synthesize answers via Claude.
 *
 * Exported functions:
 *   searchWiki(root, query)   → ranked array of { file, slug, score }
 *   queryBrain(root, question) → { answer, sources, outputPath }
 *
 * Used by: telegram-bot.mjs (and future wiki-server chat endpoint)
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { spawnSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

// ── Stopwords to ignore when tokenizing queries ───────────────────────────────

const STOPWORDS = new Set([
  // Spanish
  'qué', 'que', 'sé', 'se', 'sobre', 'cómo', 'como', 'cuál', 'cual', 'cuáles',
  'cuales', 'dónde', 'donde', 'quién', 'quien', 'cuándo', 'cuando', 'por', 'qué',
  'tengo', 'hay', 'es', 'son', 'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'al', 'en', 'y', 'o', 'a', 'con', 'para', 'mi', 'mis', 'me', 'más',
  'muy', 'pero', 'si', 'no', 'ya', 'lo', 'le', 'su', 'sus', 'sus',
  // English
  'what', 'know', 'about', 'how', 'where', 'who', 'when', 'which', 'why',
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is',
  'are', 'do', 'does', 'i', 'my', 'me', 'have', 'has', 'tell', 'search', 'find',
  'show', 'give', 'get', 'can', 'could', 'would', 'with', 'from', 'that',
]);

// ── searchWiki ────────────────────────────────────────────────────────────────

/**
 * Search wiki articles for a query.
 * Returns up to 7 results ranked by number of matching lines.
 *
 * @param {string} root  - repo root path
 * @param {string} query - natural language query
 * @returns {{ file: string, slug: string, score: number }[]}
 */
export function searchWiki(root, query) {
  const wikiDir = join(root, 'wiki');
  if (!existsSync(wikiDir)) return [];

  // Tokenize: split on non-alphanumeric, lowercase, remove stopwords, keep ≥3 chars
  const keywords = query
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));

  if (keywords.length === 0) return [];

  // Count matches per file across all keywords
  const scores = {};

  for (const kw of keywords) {
    const result = spawnSync('grep', ['-ril', kw, wikiDir], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout.trim()) continue;

    for (const filePath of result.stdout.trim().split('\n').filter(Boolean)) {
      if (!filePath.endsWith('.md')) continue;
      // Count occurrences to boost more relevant articles
      const countResult = spawnSync('grep', ['-ci', kw, filePath], { encoding: 'utf8' });
      const count = parseInt(countResult.stdout.trim()) || 1;
      scores[filePath] = (scores[filePath] || 0) + count;
    }
  }

  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([file, score]) => ({
      file,
      slug: basename(file, '.md'),
      score,
    }));
}

// ── queryBrain ────────────────────────────────────────────────────────────────

/**
 * Answer a question by searching the wiki and synthesizing with Claude.
 *
 * @param {string} root     - repo root path
 * @param {string} question - natural language question
 * @returns {{ answer: string, sources: string[], outputPath: string | null }}
 */
export async function queryBrain(root, question) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const results = searchWiki(root, question);

  if (results.length === 0) {
    return {
      answer: "No tengo artículos en el wiki que traten sobre ese tema. Puedes ingesta más material con `brain: save <url>` o enviando una nota.",
      sources: [],
      outputPath: null,
    };
  }

  // Read top 5 articles
  const topResults = results.slice(0, 5);
  const articleBlocks = topResults.map(({ file, slug }) => {
    try {
      const content = readFileSync(file, 'utf8');
      return `=== [[${slug}]] ===\n${content}`;
    } catch {
      return null;
    }
  }).filter(Boolean);

  // Build Claude prompt
  const systemPrompt = `Eres el asistente de un second brain personal. Tu único conocimiento son los artículos del wiki proporcionados.

Reglas:
- Responde SOLO basándote en los artículos proporcionados.
- Cita las fuentes usando el formato [[slug-del-artículo]].
- Si la información no está en los artículos, dilo claramente.
- Responde en el mismo idioma que la pregunta.
- Sé conciso pero completo. Máximo 1200 caracteres.
- No inventes información que no esté en los artículos.`;

  const userPrompt = `Pregunta: ${question}

Artículos del wiki disponibles:

${articleBlocks.join('\n\n')}`;

  const client = new Anthropic({ apiKey });
  const model = process.env.QUERY_MODEL || 'claude-sonnet-4-6';

  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const answer = response.content[0]?.text?.trim() || 'No se pudo generar una respuesta.';
  const sources = topResults.map(r => r.slug);

  // Save output to outputs/
  const outputPath = saveQueryOutput(root, question, answer, sources);

  return { answer, sources, outputPath };
}

// ── saveQueryOutput ───────────────────────────────────────────────────────────

function saveQueryOutput(root, question, answer, sources) {
  try {
    const outputsDir = join(root, 'outputs');
    mkdirSync(outputsDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const slug = question
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50);

    const filename = `${date}-query-${slug}.md`;
    const filePath = join(outputsDir, filename);

    const sourcesList = sources.map(s => `- [[${s}]]`).join('\n');
    const content = `---
query: "${question.replace(/"/g, '\\"')}"
date: ${date}
sources: [${sources.join(', ')}]
type: query-response
---

# Query: ${question}

> **Date:** ${date}
> **Sources used:** ${sources.map(s => `[[${s}]]`).join(', ')}

---

## Response

${answer}

---

## Sources

${sourcesList}
`;

    writeFileSync(filePath, content, 'utf8');
    return filePath;
  } catch {
    return null;
  }
}
