/**
 * brain-query — Search the wiki and synthesize answers via Claude.
 *
 * Exported functions:
 *   searchWiki(root, keywords[]) → ranked array of { file, slug, score }
 *   queryBrain(root, question)   → { answer, sources, outputPath }
 *
 * Used by: telegram-bot.mjs (and future wiki-server chat endpoint)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { spawnSync, spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

// ── expandQueryKeywords ───────────────────────────────────────────────────────

/**
 * Use Claude Haiku to expand a natural-language question into search keywords.
 * Handles bilingual queries (es/en) and synonyms — e.g. "relojes inteligentes"
 * becomes ["smartwatch", "wearable", "reloj", "relojes", "fitness tracker", "band"].
 *
 * Falls back to naive tokenization if the API call fails.
 *
 * @param {string} question
 * @param {string} apiKey
 * @returns {Promise<string[]>}
 */
async function expandQueryKeywords(question, apiKey) {
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Extract 6-8 search keywords from this question. Include synonyms and both Spanish and English variants. Output ONLY a comma-separated list, no explanations, no punctuation.

Question: ${question}`,
      }],
    });
    const raw = response.content[0]?.text?.trim() || '';
    const keywords = raw
      .split(',')
      .map(k => k.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
      .filter(k => k.length >= 3);
    if (keywords.length > 0) return keywords;
  } catch {
    // fall through to naive tokenization
  }

  return naiveKeywords(question);
}

// ── searchWiki ────────────────────────────────────────────────────────────────

/**
 * Search wiki articles by a list of keywords.
 * Returns up to 7 results ranked by total match count across all keywords.
 *
 * @param {string}   root     - repo root path
 * @param {string[]} keywords - search terms (already lowercased, normalized)
 * @returns {{ file: string, slug: string, score: number }[]}
 */
export function searchWiki(root, keywords) {
  const wikiDir = join(root, 'wiki');
  if (!existsSync(wikiDir) || keywords.length === 0) return [];

  const scores = {};

  for (const kw of keywords) {
    const result = spawnSync('grep', ['-ril', kw, wikiDir], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout.trim()) continue;

    for (const filePath of result.stdout.trim().split('\n').filter(Boolean)) {
      if (!filePath.endsWith('.md')) continue;
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
 * @param {string} [mode]   - 'api' (Anthropic SDK) | 'claude' (claude -p subprocess, free with Team)
 * @returns {{ answer: string, sources: string[], outputPath: string | null }}
 */
export async function queryBrain(root, question, mode = 'api') {
  // Step 1: expand keywords — use SDK when available, naive fallback otherwise
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const keywords = (mode === 'api' && apiKey)
    ? await expandQueryKeywords(question, apiKey)
    : naiveKeywords(question);

  const results = searchWiki(root, keywords);

  if (results.length === 0) {
    return {
      answer: "No tengo artículos en el wiki que traten sobre ese tema. Puedes ingestar más material con `brain: save <url>` o enviando una nota.",
      sources: [],
      outputPath: null,
    };
  }

  // Read top 5 articles
  const topResults = results.slice(0, 5);
  const articleBlocks = topResults.map(({ file, slug }) => {
    try { return `=== [[${slug}]] ===\n${readFileSync(file, 'utf8')}`; }
    catch { return null; }
  }).filter(Boolean);

  const sources = topResults.map(r => r.slug);

  const systemPrompt = `Eres el asistente de un second brain personal. Tu único conocimiento son los artículos del wiki proporcionados.

Reglas:
- Responde SOLO basándote en los artículos proporcionados.
- Cita las fuentes usando el formato [[slug-del-artículo]].
- Si la información no está en los artículos, dilo claramente.
- Responde en el mismo idioma que la pregunta.
- Sé conciso pero completo. Máximo 1200 caracteres.
- No inventes información que no esté en los artículos.

Formato (la respuesta se enviará por Telegram):
- NO uses # ni ## para títulos. Para destacar una sección usa *Título:* (asterisco simple).
- Para negrita usa *texto* (asterisco simple, no doble).
- Para listas usa guión o bullet: - ítem.
- No uses --- ni líneas divisorias.
- No uses > para citas.`;

  const userPrompt = `Pregunta: ${question}

Artículos del wiki disponibles:

${articleBlocks.join('\n\n')}`;

  let answer;

  if (mode === 'claude') {
    answer = await synthesizeWithClaude(root, systemPrompt, userPrompt);
  } else {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in .env');
    const client = new Anthropic({ apiKey });
    const model = process.env.QUERY_MODEL || 'claude-sonnet-4-6';
    const response = await client.messages.create({
      model,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    answer = response.content[0]?.text?.trim() || 'No se pudo generar una respuesta.';
  }

  const outputPath = saveQueryOutput(root, question, answer, sources);
  return { answer, sources, outputPath };
}

// ── claude -p subprocess synthesis (free with Team/Max subscription) ──────────

function synthesizeWithClaude(root, systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--dangerously-skip-permissions'], {
      cwd: root,
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const prompt = `${systemPrompt}\n\n${userPrompt}`;
    let output = '';
    let errOutput = '';

    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { errOutput += d; });
    child.stdin.write(prompt);
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude -p timeout (90s)'));
    }, 90_000);

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !output.trim()) {
        return reject(new Error(`claude -p exited ${code}: ${errOutput.slice(0, 200)}`));
      }
      resolve(output.trim() || 'No se pudo generar una respuesta.');
    });
  });
}

// ── naive keyword extraction (no API needed) ──────────────────────────────────

function naiveKeywords(question) {
  const STOPWORDS = new Set([
    'que', 'se', 'sobre', 'como', 'cual', 'donde', 'quien', 'cuando', 'por',
    'tengo', 'hay', 'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'al',
    'en', 'y', 'o', 'a', 'con', 'para', 'mi', 'me', 'mas', 'muy', 'pero',
    'si', 'no', 'ya', 'lo', 'le', 'su', 'sus', 'what', 'know', 'about', 'how',
    'where', 'who', 'when', 'which', 'why', 'the', 'an', 'in', 'on', 'at',
    'to', 'for', 'of', 'and', 'or', 'is', 'are', 'do', 'does', 'have', 'has',
  ]);
  return question
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
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
