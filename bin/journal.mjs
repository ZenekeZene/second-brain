#!/usr/bin/env node
/**
 * journal — Generate a daily journal entry from brain activity.
 *
 * Reads activity data from .state/compile-log.json, raw/, and outputs/,
 * synthesizes a narrative with Claude Haiku, and writes wiki/journal/YYYY-MM-DD.md.
 *
 * Usage:
 *   node bin/journal.mjs              Generate yesterday's journal
 *   node bin/journal.mjs 2026-04-10   Generate journal for a specific date
 *   node bin/journal.mjs --dry-run    Preview without writing
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

// Target date: specified date or yesterday
function targetDate() {
  if (dateArg) return dateArg;
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

const DATE = targetDate();

// ── Activity collection ───────────────────────────────────────────────────────

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function filesForDate(dir, date) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.startsWith(date) && f.endsWith('.md'))
    .map(f => join(dir, f));
}

function titleFromFile(path) {
  try {
    const content = readFileSync(path, 'utf8');
    const titleMatch = content.match(/^(?:title:|#\s+)(.+)$/m);
    return titleMatch?.[1]?.replace(/^["']|["']$/g, '').trim() ?? null;
  } catch { return null; }
}

function collectIngesta(date) {
  const types = ['articles', 'notes', 'bookmarks', 'x-bookmarks', 'files', 'images'];
  const result = {};
  for (const type of types) {
    const files = filesForDate(join(ROOT, 'raw', type), date);
    if (files.length > 0) {
      result[type] = files.map(f => titleFromFile(f) || f.split('/').pop().replace('.md', ''));
    }
  }
  return result;
}

function collectCompilation(date) {
  const log = readJsonSafe(join(ROOT, '.state', 'compile-log.json'));
  if (!Array.isArray(log)) return null;
  const entry = log.filter(e => e.date?.startsWith(date)).pop();
  if (!entry) return null;
  return {
    processed: entry.processed,
    written: entry.written || [],
    created: (entry.written || []).filter(f => f.startsWith('wiki/')),
  };
}

function collectQueries(date) {
  const dir = join(ROOT, 'outputs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.startsWith(date) && f.endsWith('.md') && !f.includes('health') && !f.includes('lint'))
    .map(f => {
      try {
        const content = readFileSync(join(dir, f), 'utf8');
        return content.match(/^query:\s*"?(.+?)"?\s*$/m)?.[1]?.trim() ?? f.replace('.md', '');
      } catch { return null; }
    })
    .filter(Boolean);
}

function collectTasks(date) {
  const dir = join(ROOT, 'raw', 'tasks');
  if (!existsSync(dir)) return { done: [], upcoming: [] };
  const done = [], upcoming = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
    try {
      const content = readFileSync(join(dir, f), 'utf8');
      const text        = content.match(/^text:\s*"?(.+?)"?\s*$/m)?.[1]?.trim();
      const due         = content.match(/^due:\s*(.+)$/m)?.[1]?.trim();
      const completedAt = content.match(/^completedAt:\s*(.+)$/m)?.[1]?.trim();
      const isDone      = content.match(/^done:\s*(.+)$/m)?.[1]?.trim() === 'true';
      if (!text || !due) continue;
      // Completed on this date (via completedAt field)
      if (isDone && completedAt?.startsWith(date)) { done.push(text); continue; }
      // Due on this date and still pending
      if (due.startsWith(date) && !isDone) upcoming.push(text);
    } catch { /* skip */ }
  }
  return { done, upcoming };
}

// ── Journal file check ────────────────────────────────────────────────────────

function journalExists(date) {
  return existsSync(join(ROOT, 'wiki', 'journal', `${date}.md`));
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(date, activity) {
  const { ingesta, compilation, queries, tasks } = activity;

  const dayName = new Date(date + 'T12:00:00').toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const lines = [`Genera una entrada de diario para un second brain personal.`];
  lines.push(`Fecha: ${dayName}\n`);

  lines.push(`## Actividad del día\n`);

  // Ingesta
  const ingestaTotal = Object.values(ingesta).flat().length;
  if (ingestaTotal > 0) {
    lines.push(`**Ingesta** (${ingestaTotal} items):`);
    for (const [type, items] of Object.entries(ingesta)) {
      lines.push(`- ${type}: ${items.slice(0, 5).join(', ')}${items.length > 5 ? ` (+${items.length - 5} más)` : ''}`);
    }
    lines.push('');
  }

  // Compilación
  if (compilation) {
    lines.push(`**Compilación:** ${compilation.processed} items procesados`);
    const wikiFiles = compilation.created.map(f => f.replace('wiki/', '').replace('.md', ''));
    if (wikiFiles.length) lines.push(`- Artículos: ${wikiFiles.join(', ')}`);
    lines.push('');
  }

  // Queries
  if (queries.length > 0) {
    lines.push(`**Consultas al brain:**`);
    queries.forEach(q => lines.push(`- "${q}"`));
    lines.push('');
  }

  // Tasks
  if (tasks.done.length > 0 || tasks.upcoming.length > 0) {
    lines.push(`**Tareas:**`);
    tasks.done.forEach(t => lines.push(`- ✅ ${t}`));
    tasks.upcoming.forEach(t => lines.push(`- 🔵 ${t} (pendiente)`));
    lines.push('');
  }

  lines.push(`## Tu tarea

Escribe 2-3 párrafos cortos en prosa (sin listas) para la sección "Reflexiones" del diario:
1. Un párrafo que narre brevemente los temas del día y lo que se trabajó
2. Un párrafo con patrones o conexiones interesantes que observes entre el contenido
3. Una pregunta o hilo emergente que vale la pena explorar

Tono: personal, reflexivo, conciso. Máximo 180 palabras. Solo el texto de los párrafos, sin encabezados.`);

  return lines.join('\n');
}

// ── Haiku narrative generation ────────────────────────────────────────────────

async function generateNarrative(activity) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model  = process.env.JOURNAL_MODEL || 'claude-haiku-4-5-20251001';
  const prompt = buildPrompt(DATE, activity);

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0]?.text?.trim() ?? null;
  } catch (err) {
    console.warn(`  Warning: narrative generation failed — ${err.message}`);
    return null;
  }
}

// ── Journal writer ────────────────────────────────────────────────────────────

function buildJournal(date, activity, narrative) {
  const { ingesta, compilation, queries, tasks } = activity;

  const dayName = new Date(date + 'T12:00:00').toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  // Capitalize first letter
  const dayTitle = dayName.charAt(0).toUpperCase() + dayName.slice(1);

  const ingestaTotal = Object.values(ingesta).flat().length;
  const lines = [];

  lines.push(`---`);
  lines.push(`date: ${date}`);
  lines.push(`created: ${date}`);
  lines.push(`updated: ${date}`);
  lines.push(`type: journal`);
  lines.push(`tags: [journal, diario]`);
  lines.push(`---\n`);

  lines.push(`# Diario — ${dayTitle}\n`);
  lines.push(`> Resumen automático de la actividad del día.\n`);

  lines.push(`## Actividad\n`);

  if (ingestaTotal > 0) {
    for (const [type, items] of Object.entries(ingesta)) {
      const label = { articles: 'Artículos', notes: 'Notas', bookmarks: 'Bookmarks',
        'x-bookmarks': 'X Bookmarks', files: 'Archivos', images: 'Imágenes' }[type] ?? type;
      lines.push(`**${label}** (${items.length}): ${items.slice(0, 4).join(', ')}${items.length > 4 ? ` y ${items.length - 4} más` : ''}`);
    }
    lines.push('');
  } else {
    lines.push(`*Sin ingesta este día.*\n`);
  }

  if (compilation) {
    const wikiFiles = compilation.created.map(f => `[[${f.replace('wiki/', '').replace('.md', '')}]]`);
    lines.push(`**Compilación:** ${compilation.processed} items → ${wikiFiles.join(', ') || 'sin artículos nuevos'}\n`);
  }

  if (queries.length > 0) {
    lines.push(`**Consultas:**`);
    queries.forEach(q => lines.push(`- "${q}"`));
    lines.push('');
  }

  if (tasks.done.length > 0 || tasks.upcoming.length > 0) {
    lines.push(`**Tareas:**`);
    tasks.done.forEach(t => lines.push(`- ✅ ${t}`));
    tasks.upcoming.forEach(t => lines.push(`- 🔵 ${t}`));
    lines.push('');
  }

  if (narrative) {
    lines.push(`## Reflexiones\n`);
    lines.push(narrative);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Telegram notification ─────────────────────────────────────────────────────

async function notify(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch { /* best-effort */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nJournal — ${DATE}`);

  if (journalExists(DATE) && !dryRun) {
    console.log(`  Already exists: wiki/journal/${DATE}.md`);
    return;
  }

  const ingesta     = collectIngesta(DATE);
  const compilation = collectCompilation(DATE);
  const queries     = collectQueries(DATE);
  const tasks       = collectTasks(DATE);
  const activity    = { ingesta, compilation, queries, tasks };

  const ingestaTotal = Object.values(ingesta).flat().length;
  const hasActivity  = ingestaTotal > 0 || compilation || queries.length > 0 || tasks.done.length > 0;

  if (!hasActivity) {
    console.log(`  No activity found for ${DATE} — skipping.`);
    return;
  }

  console.log(`  Ingesta: ${ingestaTotal} items | Compiled: ${compilation ? 'yes' : 'no'} | Queries: ${queries.length} | Tasks done: ${tasks.done.length}`);

  if (dryRun) {
    console.log(`\n(dry-run — would write wiki/journal/${DATE}.md)\n`);
    return;
  }

  const narrative = await generateNarrative(activity);

  const content = buildJournal(DATE, activity, narrative);
  const outDir  = join(ROOT, 'wiki', 'journal');
  const outPath = join(outDir, `${DATE}.md`);

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, content, 'utf8');

  console.log(`  ✓ wiki/journal/${DATE}.md`);

  await notify(`📓 *Journal — ${DATE}*\nActividad: ${ingestaTotal} ingestas, ${queries.length} consultas, ${tasks.done.length} tareas completadas.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
