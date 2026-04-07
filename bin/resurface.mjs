#!/usr/bin/env node
/**
 * second-brain spaced repetition — resurface articles due for review.
 *
 * Picks wiki articles you haven't seen in a while, prioritizing the most
 * connected ones (most backlinks). Sends them to Telegram.
 *
 * Review state is tracked in .state/review-log.json.
 * Articles never surfaced are treated as overdue from their creation date.
 *
 * Usage:
 *   node bin/resurface.mjs               Surface overdue articles + send to Telegram
 *   node bin/resurface.mjs --dry-run     Preview without sending or updating log
 *   node bin/resurface.mjs --count 5     Surface 5 articles (default: 3)
 *   node bin/resurface.mjs --days 14     Change review interval (default: 7 days)
 *   node bin/resurface.mjs --all         Show all articles with their scores
 *   node bin/resurface.mjs --help
 *
 * Schedule (system cron — every Sunday at 9:00):
 *   0 9 * * 0 cd /path/to/second-brain && node bin/resurface.mjs >> .state/resurface.log 2>&1
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './lib/logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Config from args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const SHOW_ALL  = args.includes('--all');
const countArg  = args.indexOf('--count');
const daysArg   = args.indexOf('--days');
const COUNT     = countArg !== -1 ? parseInt(args[countArg + 1], 10) : 3;
const THRESHOLD = daysArg  !== -1 ? parseInt(args[daysArg  + 1], 10) : 7;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage:
  node bin/resurface.mjs               Surface overdue articles + send to Telegram
  node bin/resurface.mjs --dry-run     Preview without sending or updating log
  node bin/resurface.mjs --count N     Surface N articles (default: 3)
  node bin/resurface.mjs --days N      Review interval in days (default: 7)
  node bin/resurface.mjs --all         Show all articles with scores
`);
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) process.env[key.trim()] = rest.join('=').trim();
  }
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return (Date.now() - new Date(dateStr).getTime()) / 86_400_000;
}

function today() { return new Date().toISOString().slice(0, 10); }
function nowISO() { return new Date().toISOString(); }

/** Extract a frontmatter field from article content. */
function fmField(content, field) {
  const m = content.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/** Extract the > summary line from an article. */
function extractSummary(content) {
  const m = content.match(/^>\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Extract the # Title line. */
function extractTitle(content) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

// ── Load wiki articles ────────────────────────────────────────────────────────
const wikiDir = join(ROOT, 'wiki');

if (!existsSync(wikiDir)) {
  console.log('No wiki directory found. Compile some articles first.');
  process.exit(0);
}

const files = readdirSync(wikiDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');

if (files.length === 0) {
  console.log('No wiki articles found.');
  process.exit(0);
}

// ── Build backlink map ────────────────────────────────────────────────────────
// backlinks[slug] = number of OTHER articles that link to it
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

// ── Load review log ───────────────────────────────────────────────────────────
const reviewLogPath = join(ROOT, '.state', 'review-log.json');
const reviewLog = readJson(reviewLogPath, { articles: {} });
if (!reviewLog.articles) reviewLog.articles = {};

// ── Score articles ────────────────────────────────────────────────────────────
// Score = daysSinceLastSeen × (1 + backlinks × 0.4)
// Higher score = more urgent to resurface.

const scored = files.map(file => {
  const slug = file.replace(/\.md$/, '');
  const content = readFileSync(join(wikiDir, file), 'utf8');
  const entry = reviewLog.articles[slug] || {};

  // Last seen: either from review log or article creation date
  const lastSeen = entry.lastSurfaced || fmField(content, 'created') || null;
  const days = daysSince(lastSeen);
  const bl = backlinks[slug.toLowerCase()] || 0;
  const score = days * (1 + bl * 0.4);

  return {
    slug,
    title:   extractTitle(content) || slug,
    summary: extractSummary(content),
    days:    Math.floor(days),
    backlinks: bl,
    score,
    surfaceCount: entry.surfaceCount || 0,
    lastSeen,
  };
}).sort((a, b) => b.score - a.score);

// ── Show all (debug) ──────────────────────────────────────────────────────────
if (SHOW_ALL) {
  console.log(`\nAll articles by review priority (threshold: ${THRESHOLD} days)\n`);
  const slugW = Math.max(...scored.map(s => s.slug.length), 4);
  console.log(`  ${'Slug'.padEnd(slugW)}  Days  BL  Score`);
  console.log(`  ${'─'.repeat(slugW)}  ────  ──  ─────`);
  for (const s of scored) {
    const due = s.days >= THRESHOLD ? ' ← due' : '';
    console.log(`  ${s.slug.padEnd(slugW)}  ${String(s.days).padEnd(4)}  ${String(s.backlinks).padEnd(2)}  ${s.score.toFixed(1)}${due}`);
  }
  console.log('');
  process.exit(0);
}

// ── Pick overdue articles ─────────────────────────────────────────────────────
const overdue = scored.filter(s => s.days >= THRESHOLD);
const toSurface = overdue.slice(0, COUNT);

if (toSurface.length === 0) {
  console.log(`No articles overdue for review (threshold: ${THRESHOLD} days, ${files.length} articles tracked).`);
  log('info', 'resurface:none', { threshold: THRESHOLD, articles: files.length });
  process.exit(0);
}

// ── Console output ────────────────────────────────────────────────────────────
console.log(`\nResurfacing ${toSurface.length} article${toSurface.length !== 1 ? 's' : ''} (${overdue.length} overdue)\n`);
for (const s of toSurface) {
  console.log(`  [[${s.slug}]]  (${s.days}d ago, ${s.backlinks} backlinks)`);
  if (s.summary) console.log(`  ${s.summary.slice(0, 80)}${s.summary.length > 80 ? '...' : ''}`);
  console.log('');
}

if (DRY_RUN) {
  console.log('(dry-run: Telegram not sent, log not updated)');
  process.exit(0);
}

// ── Update review log ─────────────────────────────────────────────────────────
for (const s of toSurface) {
  reviewLog.articles[s.slug] = {
    lastSurfaced: today(),
    surfaceCount: (reviewLog.articles[s.slug]?.surfaceCount || 0) + 1,
  };
}
reviewLog.lastRun = nowISO();
writeFileSync(reviewLogPath, JSON.stringify(reviewLog, null, 2) + '\n');

// ── Send to Telegram ──────────────────────────────────────────────────────────
loadEnv();
const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALLOWED_USER_ID;

if (!TOKEN || !CHAT_ID) {
  console.error('Telegram credentials not found in .env — log updated but message not sent.');
  process.exit(1);
}

const lines = [
  `*Time to revisit your wiki*`,
  `_${toSurface.length} article${toSurface.length !== 1 ? 's' : ''} due for review_`,
  '',
];

for (const s of toSurface) {
  lines.push(`*${s.title}*`);
  if (s.summary) lines.push(`_${s.summary.slice(0, 120)}${s.summary.length > 120 ? '...' : ''}_`);
  const meta = [`${s.days}d ago`, s.backlinks > 0 ? `${s.backlinks} backlink${s.backlinks !== 1 ? 's' : ''}` : null]
    .filter(Boolean).join(' · ');
  lines.push(`\`[[${s.slug}]]\` — ${meta}`);
  lines.push('');
}

if (overdue.length > COUNT) {
  lines.push(`_${overdue.length - COUNT} more articles also overdue._`);
}

const message = lines.join('\n').trimEnd();

try {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram API error');
  log('info', 'resurface:sent', { count: toSurface.length, overdue: overdue.length });
  console.log(`Sent ${toSurface.length} article${toSurface.length !== 1 ? 's' : ''} to Telegram.`);
} catch (err) {
  log('error', 'resurface:failed', { error: err.message });
  console.error(`Telegram error: ${err.message}`);
  process.exit(1);
}
