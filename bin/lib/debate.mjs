/**
 * debate — Devil's advocate mode for the second brain.
 *
 * Exported functions:
 *   debateTopic(root, topic)              → { challenge, sources, outputPath, sessionMessages }
 *   continueDebate(root, session, reply)  → { challenge, sessionMessages }
 *   endDebate(root, session)              → { insightsPath, summary }
 *   saveDebateSession(root, msgId, data)  → void
 *   loadDebateSession(root, msgId)        → session | null
 *   getMostRecentSession(root)            → session | null
 *   pruneDebateSessions(root)             → void
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { searchWiki } from './brain-query.mjs';

const MODEL          = process.env.DEBATE_MODEL || 'claude-sonnet-4-6';
const SESSIONS_PATH  = (root) => join(root, '.state', 'debate-sessions.json');
const PENDING_PATH   = (root) => join(root, '.state', 'pending.json');
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
      model: MODEL, max_tokens: 1200, system: SYSTEM_PROMPT, messages: sessionMessages,
    });
    challenge = response.content[0]?.text?.trim() ?? 'No se pudo generar el debate.';
  } catch (err) {
    return { challenge: `Error: ${err.message}`, sources, outputPath: null, sessionMessages: [] };
  }

  sessionMessages.push({ role: 'assistant', content: challenge });

  const outputPath = writeDebateOutput(root, topic, sources, sessionMessages);
  return { challenge, sources, outputPath, sessionMessages };
}

// ── continueDebate ────────────────────────────────────────────────────────────

export async function continueDebate(root, session, userReply) {
  const messages = [...session.messages, { role: 'user', content: userReply }];

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let challenge;
  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 1200, system: SYSTEM_PROMPT, messages,
    });
    challenge = response.content[0]?.text?.trim() ?? 'No se pudo continuar el debate.';
  } catch (err) {
    throw new Error(`Error continuing debate: ${err.message}`);
  }

  messages.push({ role: 'assistant', content: challenge });

  // Update the output file with the full transcript so far
  if (session.outputPath) {
    writeDebateOutput(root, session.topic, session.sources, messages, session.outputPath);
  }

  return { challenge, sessionMessages: messages };
}

// ── endDebate ─────────────────────────────────────────────────────────────────

/**
 * Close a debate, extract insights with Haiku, save to raw/notes/ and add to pending.
 *
 * @param {string} root
 * @param {{ topic: string, messages: object[], sources: string[], outputPath: string }} session
 * @returns {Promise<{ insightsPath: string, summary: string }>}
 */
export async function endDebate(root, session) {
  // Build readable transcript (skip the initial wiki context — too long)
  const turns = [];
  const msgs = session.messages;
  // msgs[0] = user prompt with wiki context (internal, skip)
  // msgs[1] = assistant first response
  // msgs[2,4,6...] = user replies; msgs[3,5,7...] = assistant responses
  for (let i = 1; i < msgs.length; i++) {
    const role = msgs[i].role === 'assistant' ? '🔥 Abogado del diablo' : '👤 Tú';
    // For user turns after the first (i > 1, even indices), use content directly
    // For the first assistant turn (i === 1), it's the initial challenge
    const content = typeof msgs[i].content === 'string' ? msgs[i].content : '';
    turns.push(`**${role}:**\n${content}`);
  }
  const transcript = turns.join('\n\n---\n\n');

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const insightPrompt = `Analiza este debate sobre "${session.topic}" y extrae los aprendizajes clave.

TRANSCRIPCIÓN DEL DEBATE:
${transcript.slice(0, 8000)}

Genera una nota de aprendizaje concisa con estas secciones:
1. **Posiciones debilitadas**: qué argumentos propios no resistieron el escrutinio (1-2 puntos)
2. **Nuevas perspectivas**: ángulos o matices descubiertos durante el debate (1-2 puntos)
3. **Actualización de posición**: cómo debería actualizarse el wiki sobre "${session.topic}" (1 párrafo)
4. **Conexiones emergentes**: otros temas del wiki que este debate ilumina (si los hay)

Máximo 300 palabras. Responde en español. Sé específico y concreto, no genérico.`;

  let insights;
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: insightPrompt }],
    });
    insights = response.content[0]?.text?.trim() ?? '';
  } catch (err) {
    throw new Error(`Error extracting insights: ${err.message}`);
  }

  // Save to raw/notes/
  const date      = new Date().toISOString().split('T')[0];
  const slug      = session.topic
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 45);
  const filename  = `${date}-debate-insights-${slug}.md`;
  const notesDir  = join(root, 'raw', 'notes');
  const notePath  = join(notesDir, filename);
  const relPath   = `raw/notes/${filename}`;

  mkdirSync(notesDir, { recursive: true });

  const noteContent = `---
ingested: ${new Date().toISOString()}
type: note
status: pending
tags: [debate, insights, ${slug}]
debate_topic: "${session.topic}"
debate_sources: [${(session.sources || []).join(', ')}]
---

# Debate: ${session.topic}

_${date} · ${Math.floor((session.messages.length - 1) / 2)} turnos_

## Transcripción

${transcript}

---

## Insights

${insights}
`;

  writeFileSync(notePath, noteContent, 'utf8');

  // Add to pending.json
  addToPending(root, relPath, 'note');

  const summary = `${Math.floor((session.messages.length - 1) / 2)} turnos → insights guardados en \`${relPath}\``;
  return { insightsPath: relPath, summary };
}

// ── Output file (full transcript) ─────────────────────────────────────────────

/**
 * Write or overwrite the debate output file with the full transcript.
 * Returns the relative path to the file.
 */
function writeDebateOutput(root, topic, sources, messages, existingPath = null) {
  try {
    const outputsDir = join(root, 'outputs');
    mkdirSync(outputsDir, { recursive: true });

    let filePath;
    if (existingPath) {
      filePath = join(root, existingPath);
    } else {
      const date = new Date().toISOString().split('T')[0];
      const slug = topic
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 50);
      filePath = join(outputsDir, `${date}-debate-${slug}.md`);
    }

    // Build transcript — skip messages[0] (wiki context prompt, too long)
    const turns = [];
    for (let i = 1; i < messages.length; i++) {
      const isBot  = messages[i].role === 'assistant';
      const header = isBot
        ? `## Turno ${Math.ceil(i / 2)} — Abogado del diablo`
        : `### Respuesta del usuario`;
      turns.push(`${header}\n\n${messages[i].content}`);
    }

    const date      = new Date().toISOString().split('T')[0];
    const turnCount = Math.floor((messages.length - 1) / 2);

    const content = `---
query: "debate: ${topic.replace(/"/g, '\\"')}"
date: ${date}
sources: [${(sources || []).join(', ')}]
type: debate
turns: ${turnCount}
---

# Debate — ${topic}

> **Artículos consultados:** ${(sources || []).map(s => `[[${s}]]`).join(', ')}
> **Turnos:** ${turnCount}

---

${turns.join('\n\n---\n\n')}

---

## Artículos consultados

${(sources || []).map(s => `- [[${s}]]`).join('\n')}
`;

    writeFileSync(filePath, content, 'utf8');
    const rel = filePath.replace(root + '/', '');
    return rel;
  } catch {
    return null;
  }
}

// ── Session storage ───────────────────────────────────────────────────────────

function readSessions(root) {
  try { return JSON.parse(readFileSync(SESSIONS_PATH(root), 'utf8')); }
  catch { return {}; }
}

function writeSessions(root, sessions) {
  writeFileSync(SESSIONS_PATH(root), JSON.stringify(sessions), 'utf8');
}

export function saveDebateSession(root, msgId, { topic, messages, sources, outputPath }) {
  const sessions = readSessions(root);
  sessions[String(msgId)] = { topic, messages, sources, outputPath, created: Date.now() };
  writeSessions(root, sessions);
}

export function loadDebateSession(root, msgId) {
  return readSessions(root)[String(msgId)] ?? null;
}

export function getMostRecentSession(root) {
  const sessions = readSessions(root);
  const entries  = Object.values(sessions);
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b.created - a.created)[0];
}

/**
 * Prune expired sessions. If an expired session has >1 turn, extract insights
 * before deleting so the brain learns even if the user never ran /challenge_end.
 */
export async function pruneDebateSessions(root) {
  const sessions = readSessions(root);
  const cutoff   = Date.now() - SESSION_TTL_MS;
  let pruned = false;
  for (const [id, s] of Object.entries(sessions)) {
    if (s.created < cutoff) {
      const turns = Math.floor((s.messages?.length - 1) / 2);
      if (turns >= 1 && process.env.ANTHROPIC_API_KEY) {
        try { await endDebate(root, s); } catch { /* best-effort */ }
      }
      delete sessions[id];
      pruned = true;
    }
  }
  if (pruned) writeSessions(root, sessions);
}

/**
 * Return open debate sessions older than minAgeMs (default 24h) for briefing reminders.
 */
export function getOpenDebates(root, minAgeMs = 24 * 60 * 60 * 1000) {
  const sessions = readSessions(root);
  const cutoff   = Date.now() - SESSION_TTL_MS;
  const threshold = Date.now() - minAgeMs;
  return Object.values(sessions).filter(s =>
    s.created > cutoff &&          // not yet expired
    s.created < threshold &&       // older than minAgeMs
    s.messages?.length > 1         // has at least one bot turn
  );
}

// ── pending.json helper ───────────────────────────────────────────────────────

function addToPending(root, path, type) {
  let state = { pending: [], lastCompile: null };
  try { state = JSON.parse(readFileSync(PENDING_PATH(root), 'utf8')); } catch (e) {
    console.error('[debate] addToPending: failed to read pending.json —', e.message);
  }
  if (!state.pending.some(p => p.path === path)) {
    state.pending.push({ path, type, addedAt: new Date().toISOString() });
    try {
      writeFileSync(PENDING_PATH(root), JSON.stringify(state, null, 2));
      console.log('[debate] addToPending: added', path);
    } catch (e) {
      console.error('[debate] addToPending: failed to write pending.json —', e.message);
    }
  } else {
    console.log('[debate] addToPending: already present', path);
  }
}
