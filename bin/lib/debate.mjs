/**
 * debate — Devil's advocate mode for the second brain.
 *
 * Reads wiki articles related to a topic and uses Claude to generate
 * strong counterarguments, challenges, and uncomfortable questions
 * against the user's own positions.
 *
 * Exported functions:
 *   debateTopic(root, topic) → { challenge, sources, outputPath }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { searchWiki } from './brain-query.mjs';

const MODEL = process.env.DEBATE_MODEL || 'claude-sonnet-4-6';

// ── debateTopic ───────────────────────────────────────────────────────────────

/**
 * Generate devil's advocate counterarguments for a topic based on the wiki.
 *
 * @param {string} root    - repo root path
 * @param {string} topic   - topic or position to challenge
 * @returns {Promise<{ challenge: string, sources: string[], outputPath: string | null }>}
 */
export async function debateTopic(root, topic) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { challenge: 'Error: ANTHROPIC_API_KEY not set.', sources: [], outputPath: null };
  }

  // Expand topic into keywords for wiki search
  const keywords = topic
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3);

  const results = searchWiki(root, keywords);

  if (results.length === 0) {
    return {
      challenge: `No tengo artículos sobre "${topic}" en el wiki. No puedo debatir lo que no sé.`,
      sources: [],
      outputPath: null,
    };
  }

  // Read top 5 articles
  const topArticles = results.slice(0, 5);
  const articleContents = topArticles.map(r => {
    try {
      const content = readFileSync(r.file, 'utf8');
      // Strip frontmatter, keep content (capped at 5000 chars per article)
      const body = content.replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, 5000);
      return `### ${r.slug}\n${body}`;
    } catch { return null; }
  }).filter(Boolean);

  const sources = topArticles.map(r => r.slug);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `Eres un abogado del diablo riguroso para un segundo cerebro personal.
Tu misión: desafiar las posiciones e ideas que el usuario tiene sobre un tema,
basándote EXCLUSIVAMENTE en sus propios artículos del wiki.

Reglas:
- Genera 3-4 contraargumentos sólidos y específicos
- Señala contradicciones internas, suposiciones débiles, perspectivas ausentes
- Formula 2-3 preguntas incómodas que el usuario debería responderse
- Sé directo y provocador — no suavices los argumentos
- Cita los artículos del wiki cuando señales algo concreto
- Si encuentras contradicciones entre artículos del propio wiki, señálalas
- No inventes información que no esté en el wiki`;

  const userPrompt = `Tema a debatir: "${topic}"

Esto es lo que tengo en mi wiki sobre el tema:

${articleContents.join('\n\n---\n\n')}

Genera el debate en formato estructurado:
1. Resume brevemente mi posición actual (1-2 frases)
2. Lanza 3-4 contraargumentos numerados con título y desarrollo
3. Termina con 2-3 preguntas incómodas

Responde en español. Máximo 600 palabras.`;

  let challenge;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    challenge = response.content[0]?.text?.trim() ?? 'No se pudo generar el debate.';
  } catch (err) {
    return { challenge: `Error al generar debate: ${err.message}`, sources, outputPath: null };
  }

  // Save output
  const outputPath = saveDebateOutput(root, topic, challenge, sources);

  return { challenge, sources, outputPath };
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
