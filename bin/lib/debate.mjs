/**
 * debate — Devil's advocate mode for the second brain.
 *
 * Reads wiki articles related to a topic and uses Claude to generate
 * strong counterarguments, challenges, and uncomfortable questions
 * against the user's own positions. Supports multi-turn conversation.
 *
 * Exported functions:
 *   debateTopic(root, topic)              → { challenge, sources, outputPath, sessionMessages }
 *   continueDebate(root, session, reply)  → { challenge, sessionMessages }
 *   saveDebateSession(root, msgId, data)  → void
 *   loadDebateSession(root, msgId)        → session | null
 *   pruneDebateSessions(root)             → void
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { searchWiki } from './brain-query.mjs';

const MODEL          = process.env.DEBATE_MODEL || 'claude-sonnet-4-6';
const SESSIONS_PATH  = (root) => join(root, '.state', 'debate-sessions.json');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SYSTEM_PROMPT = `Eres un abogado del diablo riguroso para un segundo cerebro personal.
Tu misión: desafiar las posiciones e ideas que el usuario tiene sobre un tema,
basándote EXCLUSIVAMENTE en sus propios artículos del wiki.

Reglas:
- Genera 3-4 contraargumentos sólidos y específicos
- Señala contradicciones internas, suposiciones débiles, perspectivas ausentes
- Formula 2-3 preguntas incómodas que el usuario debería responderse
- Sé directo y provocador — no suavices los argumentos
- Cita los artículos del wiki cuando señales algo concreto
- Si encuentras contradicciones entre artículos del propio wiki, señálalas
- No inventes información que no esté en el wiki
- En turnos de continuación: responde directamente al argumento del usuario,
  mantén la presión, introduce nuevos ángulos si el usuario responde bien`;

// ── debateTopic ───────────────────────────────────────────────────────────────

/**
 * Start a devil's advocate debate on a topic using wiki articles.
 *
 * @param {string} root
 * @param {string} topic
 * @returns {Promise<{ challenge: string, sources: string[], outputPath: string|null, sessionMessages: object[] }>}
 */
export async function debateTopic(root, topic) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { challenge: 'Error: ANTHROPIC_API_KEY not set.', sources: [], outputPath: null, sessionMessages: [] };
  }

  const keywords = topic
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3);

  const results = searchWiki(root, keywords);

  if (results.length === 0) {
    return {
      challenge: `No tengo artículos sobre "${topic}" en el wiki. No puedo debatir lo que no sé.`,
      sources: [], outputPath: null, sessionMessages: [],
    };
  }

  const topArticles = results.slice(0, 5);
  const articleContents = topArticles.map(r => {
    try {
      const body = readFileSync(r.file, 'utf8')
        .replace(/^---\n[\s\S]*?\n---\n/, '')
        .slice(0, 5000);
      return `### ${r.slug}\n${body}`;
    } catch { return null; }
  }).filter(Boolean);

  const sources = topArticles.map(r => r.slug);

  const userPrompt = `Tema a debatir: "${topic}"

Esto es lo que tengo en mi wiki sobre el tema:

${articleContents.join('\n\n---\n\n')}

Genera el debate en formato estructurado:
1. Resume brevemente mi posición actual (1-2 frases)
2. Lanza 3-4 contraargumentos numerados con título y desarrollo
3. Termina con 2-3 preguntas incómodas

Responde en español. Máximo 600 palabras.`;

  const sessionMessages = [{ role: 'user', content: userPrompt }];

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let challenge;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: sessionMessages,
    });
    challenge = response.content[0]?.text?.trim() ?? 'No se pudo generar el debate.';
  } catch (err) {
    return { challenge: `Error al generar debate: ${err.message}`, sources, outputPath: null, sessionMessages: [] };
  }

  sessionMessages.push({ role: 'assistant', content: challenge });

  const outputPath = saveDebateOutput(root, topic, challenge, sources);

  return { challenge, sources, outputPath, sessionMessages };
}

// ── continueDebate ────────────────────────────────────────────────────────────

/**
 * Continue an ongoing debate with the user's reply.
 *
 * @param {string}   root
 * @param {{ topic: string, messages: object[], sources: string[] }} session
 * @param {string}   userReply
 * @returns {Promise<{ challenge: string, sessionMessages: object[] }>}
 */
export async function continueDebate(root, session, userReply) {
  const messages = [...session.messages, { role: 'user', content: userReply }];

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let challenge;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages,
    });
    challenge = response.content[0]?.text?.trim() ?? 'No se pudo continuar el debate.';
  } catch (err) {
    throw new Error(`Error continuing debate: ${err.message}`);
  }

  messages.push({ role: 'assistant', content: challenge });
  return { challenge, sessionMessages: messages };
}

// ── Session storage ───────────────────────────────────────────────────────────

function readSessions(root) {
  try { return JSON.parse(readFileSync(SESSIONS_PATH(root), 'utf8')); }
  catch { return {}; }
}

function writeSessions(root, sessions) {
  writeFileSync(SESSIONS_PATH(root), JSON.stringify(sessions), 'utf8');
}

/**
 * Save a debate session keyed by the bot's Telegram message ID.
 */
export function saveDebateSession(root, msgId, { topic, messages, sources }) {
  const sessions = readSessions(root);
  sessions[String(msgId)] = { topic, messages, sources, created: Date.now() };
  writeSessions(root, sessions);
}

/**
 * Load a debate session by message ID. Returns null if not found.
 */
export function loadDebateSession(root, msgId) {
  const sessions = readSessions(root);
  return sessions[String(msgId)] ?? null;
}

/**
 * Remove sessions older than SESSION_TTL_MS to keep the file small.
 */
export function pruneDebateSessions(root) {
  const sessions = readSessions(root);
  const cutoff = Date.now() - SESSION_TTL_MS;
  let pruned = false;
  for (const [id, s] of Object.entries(sessions)) {
    if (s.created < cutoff) { delete sessions[id]; pruned = true; }
  }
  if (pruned) writeSessions(root, sessions);
}

// ── saveDebateOutput ──────────────────────────────────────────────────────────

function saveDebateOutput(root, topic, challenge, sources) {
  try {
    const outputsDir = join(root, 'outputs');
    mkdirSync(outputsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const slug = topic
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 50);

    const filename = `${date}-debate-${slug}.md`;
    const filePath = join(outputsDir, filename);

    const content = `---
query: "debate: ${topic.replace(/"/g, '\\"')}"
date: ${date}
sources: [${sources.join(', ')}]
type: debate
---

# Debate — ${topic}

> **Tema:** ${topic}
> **Fecha:** ${date}
> **Artículos consultados:** ${sources.map(s => `[[${s}]]`).join(', ')}

---

${challenge}

---

## Artículos consultados

${sources.map(s => `- [[${s}]]`).join('\n')}
`;

    writeFileSync(filePath, content, 'utf8');
    return `outputs/${filename}`;
  } catch {
    return null;
  }
}
