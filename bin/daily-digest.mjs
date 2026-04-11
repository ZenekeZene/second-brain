#!/usr/bin/env node
/**
 * second-brain morning briefing
 * Sends a unified daily summary to Telegram:
 *   1. Yesterday's compilation (created/updated articles)
 *   2. Pending items + stale bookmark warning
 *   3. Time to revisit (spaced repetition — top 1-2 overdue articles)
 *   4. Stale bookmarks (pending >3 days)
 *
 * Usage:
 *   node bin/daily-digest.mjs          Send briefing
 *   node bin/daily-digest.mjs --dry-run Print message without sending
 *
 * Schedule (system cron, runs after compilation at 8:00 every day):
 *   0 8 * * * cd /path/to/second-brain && node bin/daily-digest.mjs >> .state/digest.log 2>&1
 *
 * Required in .env:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_ALLOWED_USER_ID
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './lib/logger.mjs';
import { readTasks, formatDue } from './lib/task-helpers.mjs';
import { getOpenDebates } from './lib/debate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load .env ─────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}
loadEnv();

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALLOWED_USER_ID;
const DRY_RUN = process.argv[2] === '--dry-run';

if (!TOKEN || !CHAT_ID) {
  console.error('Error: TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID must be set in .env');
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────
const RESURFACE_COUNT    = 2;   // max articles to resurface in briefing
const RESURFACE_DAYS     = 7;   // days before an article is overdue
const STALE_BOOKMARK_DAYS = 3;  // days before a bookmark is considered stale

// ── Utilities ─────────────────────────────────────────────────────────────────

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return (Date.now() - new Date(dateStr).getTime()) / 86_400_000;
}

function todayStr()  { return new Date().toISOString().slice(0, 10); }
function nowISO()    { return new Date().toISOString(); }
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
function todayLabel() {
  return new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}

/** Format file paths as wiki slugs. */
function toSlugs(paths) {
  return (paths || [])
    .map(p => p.replace(/^wiki\//, '').replace(/\.md$/, ''))
    .filter(s => s !== 'INDEX');
}

// ── Section: Open debates ─────────────────────────────────────────────────────

function buildOpenDebatesSection() {
  try {
    const debates = getOpenDebates(ROOT);
    if (debates.length === 0) return [];
    const lines = ['💬 *Debates sin cerrar*'];
    for (const d of debates) {
      const turns = Math.floor((d.messages?.length - 1) / 2);
      const age   = Math.round((Date.now() - d.created) / 86_400_000);
      lines.push(`• *${d.topic}* — ${turns} turno${turns !== 1 ? 's' : ''}, hace ${age} día${age !== 1 ? 's' : ''}`);
    }
    lines.push(`_Usa /challenge\\_end para cerrar y extraer insights._`);
    return lines;
  } catch { return []; }
}

// ── Section 0: Tasks due today / overdue ─────────────────────────────────────

function buildTasksSection() {
  const tasks = readTasks(ROOT);
  const now   = new Date();
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);

  const overdue = tasks.filter(t => !t.done && t.due < now);
  const today   = tasks.filter(t => !t.done && t.due >= now && t.due <= todayEnd);

  if (overdue.length === 0 && today.length === 0) return [];

  const lines = ['*Tareas*'];

  for (const t of overdue.slice(0, 3)) {
    lines.push(`🔴 ${t.text} _(vencida: ${formatDue(t.due)})_`);
  }
  if (overdue.length > 3) lines.push(`_…y ${overdue.length - 3} más vencidas_`);

  for (const t of today.slice(0, 3)) {
    lines.push(`🟡 ${t.text} _(${formatDue(t.due)})_`);
  }
  if (today.length > 3) lines.push(`_…y ${today.length - 3} más hoy_`);

  return lines;
}

// ── Section 1: Yesterday's compilation ───────────────────────────────────────

function buildCompileSection(compileLog) {
  const yd = yesterday();
  const entries = Array.isArray(compileLog) ? compileLog : [];
  const fromYesterday = entries.filter(e => e.date === yd);
  const entry = fromYesterday.length > 0
    ? fromYesterday[fromYesterday.length - 1]
    : null;

  const lines = ['*Compilación de ayer*'];

  if (entry) {
    const created = toSlugs(entry.created);
    const updated = toSlugs(entry.updated);
    const count = Array.isArray(entry.processed)
      ? entry.processed.length
      : (entry.processed || 0);
    if (created.length > 0) lines.push(`Creados: ${created.map(s => `\`${s}\``).join(', ')}`);
    if (updated.length > 0) lines.push(`Actualizados: ${updated.map(s => `\`${s}\``).join(', ')}`);
    if (created.length === 0 && updated.length === 0) lines.push('Sin cambios en artículos.');
    lines.push(`${count} item${count !== 1 ? 's' : ''} procesados`);
  } else {
    lines.push('Sin compilación ayer.');
  }

  return lines;
}

// ── Section 2: Pending + stale bookmarks ─────────────────────────────────────

function buildPendingSection(state) {
  const pending = state.pending || [];
  const total = pending.length;

  const staleBookmarks = pending.filter(item =>
    item.type === 'bookmark' && daysSince(item.ingested) >= STALE_BOOKMARK_DAYS
  );

  const lines = ['*Pendientes*'];

  if (total === 0) {
    lines.push('Todo al día ✓');
  } else {
    lines.push(`${total} item${total !== 1 ? 's' : ''} sin compilar`);
    if (staleBookmarks.length > 0) {
      lines.push(`⚠️ ${staleBookmarks.length} bookmark${staleBookmarks.length !== 1 ? 's' : ''} lleva${staleBookmarks.length !== 1 ? 'n' : ''} más de ${STALE_BOOKMARK_DAYS} días sin procesar`);
    }
  }

  return { lines, staleBookmarks };
}

// ── Section 3: Resurface (spaced repetition) ─────────────────────────────────

function buildResurfaceSection(reviewLogPath) {
  const wikiDir = join(ROOT, 'wiki');
  if (!existsSync(wikiDir)) return { lines: [], updated: null };

  const files = readdirSync(wikiDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
  if (files.length === 0) return { lines: [], updated: null };

  // Build backlink map
  const WIKILINK_RE = /\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g;
  const existingSlugs = new Set(files.map(f => f.replace(/\.md$/, '').toLowerCase()));
  const backlinks = {};
  for (const file of files) {
    const sourceSlug = file.replace(/\.md$/, '').toLowerCase();
    const content = readFileSync(join(wikiDir, file), 'utf8');
    for (const m of content.matchAll(WIKILINK_RE)) {
      const linked = m[1].trim().toLowerCase().replace(/\s+/g, '-');
      if (linked !== sourceSlug && existingSlugs.has(linked)) {
        backlinks[linked] = (backlinks[linked] || 0) + 1;
      }
    }
  }

  const reviewLog = readJson(reviewLogPath, { articles: {} });
  if (!reviewLog.articles) reviewLog.articles = {};

  // Score: daysSince × (1 + backlinks × 0.4) — higher = more urgent
  const scored = files.map(file => {
    const slug = file.replace(/\.md$/, '');
    const content = readFileSync(join(wikiDir, file), 'utf8');
    const entry = reviewLog.articles[slug] || {};
    const fmCreated = content.match(/^created:\s*(.+)$/m)?.[1]?.trim() || null;
    const lastSeen = entry.lastSurfaced || fmCreated || null;
    const days = daysSince(lastSeen);
    const bl = backlinks[slug.toLowerCase()] || 0;

    const titleMatch = content.match(/^#\s+(.+)$/m);
    const summaryMatch = content.match(/^>\s+(.+)$/m);

    return {
      slug,
      title:   titleMatch ? titleMatch[1].trim() : slug,
      summary: summaryMatch ? summaryMatch[1].trim() : null,
      days:    Math.floor(days),
      backlinks: bl,
      score:   days * (1 + bl * 0.4),
    };
  }).sort((a, b) => b.score - a.score);

  const overdue = scored.filter(s => s.days >= RESURFACE_DAYS);
  const toSurface = overdue.slice(0, RESURFACE_COUNT);

  if (toSurface.length === 0) return { lines: [], updated: null };

  const lines = [`*Tiempo de repasar* _(${overdue.length} pendiente${overdue.length !== 1 ? 's' : ''})\\_`];

  for (const s of toSurface) {
    lines.push(`*${s.title}*`);
    if (s.summary) lines.push(`_${s.summary.slice(0, 100)}${s.summary.length > 100 ? '...' : ''}_`);
    const meta = [`${s.days}d sin ver`, s.backlinks > 0 ? `${s.backlinks} backlink${s.backlinks !== 1 ? 's' : ''}` : null]
      .filter(Boolean).join(' · ');
    lines.push(`\`[[${s.slug}]]\` — ${meta}`);
    lines.push('');
  }

  // Prepare updated review log (to be written after dry-run check)
  const updatedLog = { ...reviewLog };
  for (const s of toSurface) {
    updatedLog.articles[s.slug] = {
      lastSurfaced: todayStr(),
      surfaceCount: (reviewLog.articles[s.slug]?.surfaceCount || 0) + 1,
    };
  }
  updatedLog.lastRun = nowISO();

  return { lines, updated: updatedLog };
}

// ── Section 4: Stale bookmarks detail ────────────────────────────────────────

function buildStaleBookmarksSection(staleBookmarks) {
  if (staleBookmarks.length === 0) return [];

  const lines = [`*Bookmarks sin procesar (>${STALE_BOOKMARK_DAYS} días)*`];

  // Try to read actual URLs from the bookmark files
  const shown = staleBookmarks.slice(0, 5);
  for (const item of shown) {
    const filePath = join(ROOT, item.path);
    let label = item.path.split('/').pop().replace(/\.md$/, '');
    try {
      const content = readFileSync(filePath, 'utf8');
      const urls = [...content.matchAll(/^- \[.\] (https?:\/\/\S+)/gm)].map(m => m[1]);
      const days = Math.floor(daysSince(item.ingested));
      if (urls.length > 0) {
        lines.push(`${urls.slice(0, 2).map(u => `• ${u.length > 60 ? u.slice(0, 57) + '...' : u}`).join('\n')}`);
        if (urls.length > 2) lines.push(`  _…y ${urls.length - 2} más en ${label}_`);
      } else {
        lines.push(`• ${label} (${days}d)`);
      }
    } catch {
      lines.push(`• ${label}`);
    }
  }

  if (staleBookmarks.length > 5) {
    lines.push(`_…y ${staleBookmarks.length - 5} más_`);
  }

  return lines;
}

// ── Assemble message ──────────────────────────────────────────────────────────

const compileLog  = readJson(join(ROOT, '.state', 'compile-log.json'), []);
const state       = readJson(join(ROOT, '.state', 'pending.json'), { pending: [], lastCompile: null });
const reviewLogPath = join(ROOT, '.state', 'review-log.json');

const taskLines                 = buildTasksSection();
const openDebateLines           = buildOpenDebatesSection();
const compileLines              = buildCompileSection(compileLog);
const { lines: pendingLines, staleBookmarks } = buildPendingSection(state);
const { lines: resurfaceLines, updated: updatedReviewLog } = buildResurfaceSection(reviewLogPath);
const staleLines                = buildStaleBookmarksSection(staleBookmarks);

const sections = [
  [`*Second Brain — Morning Briefing*`, `_${todayLabel()}_`, ''],
  ...(taskLines.length > 0        ? [[...taskLines, '']]        : []),
  ...(openDebateLines.length > 0  ? [[...openDebateLines, '']]  : []),
  [...compileLines, ''],
  [...pendingLines, ''],
  ...(resurfaceLines.length > 0   ? [[...resurfaceLines]]       : []),
  ...(staleLines.length > 0       ? [[...staleLines]]           : []),
].flat();

const message = sections.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();

// ── Send ──────────────────────────────────────────────────────────────────────

if (DRY_RUN) {
  console.log('\n--- DRY RUN ---\n');
  console.log(message.replace(/[*_`\\]/g, ''));
  console.log('\n--- END ---\n');
  process.exit(0);
}

try {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram API error');

  // Update review log only after successful send
  if (updatedReviewLog) {
    writeFileSync(reviewLogPath, JSON.stringify(updatedReviewLog, null, 2) + '\n');
  }

  log('info', 'digest:sent', { date: todayStr(), pending: (state.pending || []).length });
  console.log(`Morning briefing sent (${todayLabel()})`);
} catch (err) {
  log('error', 'digest:failed', { error: err.message });
  console.error(`Error sending briefing: ${err.message}`);
  process.exit(1);
}
