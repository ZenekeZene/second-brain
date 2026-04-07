#!/usr/bin/env node
/**
 * second-brain daily digest
 * Sends a morning summary to Telegram:
 *   - What was compiled yesterday (or most recently)
 *   - Pending items count
 *   - A random wiki article to revisit
 *
 * Usage:
 *   node bin/daily-digest.mjs          Send digest
 *   node bin/daily-digest.mjs --dry-run Print message without sending
 *
 * Schedule (system cron, runs at 8:00 every day):
 *   0 8 * * * cd /path/to/second-brain && node bin/daily-digest.mjs >> .state/digest.log 2>&1
 *
 * Required in .env:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_ALLOWED_USER_ID
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './lib/logger.mjs';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

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

/** Find the most recent compile-log entry from yesterday (or the latest overall). */
function getRecentCompile(log) {
  if (!Array.isArray(log) || log.length === 0) return null;
  const yd = yesterday();
  const fromYesterday = log.filter(e => e.date === yd);
  return fromYesterday.length > 0 ? fromYesterday[fromYesterday.length - 1] : null;
}

/** Pick a random .md file from wiki/ and extract its title and summary line. */
function randomWikiArticle() {
  const wikiDir = join(ROOT, 'wiki');
  if (!existsSync(wikiDir)) return null;
  const files = readdirSync(wikiDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
  if (files.length === 0) return null;
  const file = files[Math.floor(Math.random() * files.length)];
  const content = readFileSync(join(wikiDir, file), 'utf8');
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const summaryMatch = content.match(/^>\s+(.+)$/m);
  const slug = file.replace(/\.md$/, '');
  return {
    slug,
    title: titleMatch ? titleMatch[1].trim() : slug,
    summary: summaryMatch ? summaryMatch[1].trim() : null,
  };
}

/** Format a list of file paths as wiki slugs: wiki/foo.md → foo */
function toSlugs(paths) {
  return (paths || [])
    .map(p => p.replace(/^wiki\//, '').replace(/\.md$/, ''))
    .filter(s => s !== 'INDEX');
}

// ── Build message ─────────────────────────────────────────────────────────────

const compileLog = readJson(join(ROOT, '.state', 'compile-log.json'), []);
const state      = readJson(join(ROOT, '.state', 'pending.json'), { pending: [], lastCompile: null });
const entry      = getRecentCompile(compileLog);
const article    = randomWikiArticle();
const pending    = (state.pending || []).length;

const lines = [];
lines.push(`*Second Brain — Morning Digest*`);
lines.push(`_${todayLabel()}_`);
lines.push('');

// Yesterday's compilation
lines.push(`*Yesterday's compilation*`);
if (entry) {
  const created = toSlugs(entry.created);
  const updated = toSlugs(entry.updated);
  const processed = Array.isArray(entry.processed) ? entry.processed.length : (entry.processed || 0);
  if (created.length > 0) lines.push(`Created: ${created.map(s => `\`${s}\``).join(', ')}`);
  if (updated.length > 0) lines.push(`Updated: ${updated.map(s => `\`${s}\``).join(', ')}`);
  lines.push(`${processed} item${processed !== 1 ? 's' : ''} processed`);
} else {
  lines.push(`No compilation yesterday.`);
  if (state.lastCompile) {
    const d = new Date(state.lastCompile).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    lines.push(`_Last compile: ${d}_`);
  }
}
lines.push('');

// Pending
lines.push(`*Pending now*`);
if (pending > 0) {
  lines.push(`${pending} item${pending !== 1 ? 's' : ''} waiting to compile`);
} else {
  lines.push(`All up to date.`);
}
lines.push('');

// Article of the day
lines.push(`*Article of the day*`);
if (article) {
  lines.push(`\`[[${article.slug}]]\``);
  if (article.summary) lines.push(`_${article.summary}_`);
} else {
  lines.push(`No wiki articles yet.`);
}

const message = lines.join('\n');

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
  log('info', 'digest:sent', { date: yesterday(), pending });
  console.log(`Digest sent (${todayLabel()})`);
} catch (err) {
  log('error', 'digest:failed', { error: err.message });
  console.error(`Error sending digest: ${err.message}`);
  process.exit(1);
}
