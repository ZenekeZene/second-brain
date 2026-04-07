#!/usr/bin/env node
/**
 * second-brain sync-x
 * Syncs X/Twitter bookmarks using the Field Theory CLI.
 *
 * Usage:
 *   node bin/sync-x.mjs              Incremental sync (new bookmarks only)
 *   node bin/sync-x.mjs --full       Full sync (entire history)
 *   node bin/sync-x.mjs --classify   Sync + classify with LLM
 *   node bin/sync-x.mjs --dry-run    Preview without writing anything
 *
 * Prerequisite: npm install -g fieldtheory + Chrome with active X session.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');
const X_STATE_PATH = join(ROOT, '.state', 'x-sync.json');
const X_RAW_DIR = join(ROOT, 'raw', 'x-bookmarks');

// ── helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function checkFtInstalled() {
  const result = spawnSync('ft', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    console.error('Error: fieldtheory CLI not found.');
    console.error('Install it with: npm install -g fieldtheory');
    process.exit(1);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage:
  node bin/sync-x.mjs              Incremental sync (new bookmarks only)
  node bin/sync-x.mjs --full       Full sync (entire history)
  node bin/sync-x.mjs --classify   Sync + LLM classification via Field Theory
  node bin/sync-x.mjs --dry-run    Preview without writing anything

Prerequisite: npm install -g fieldtheory + Chrome with an active X session.
`);
  process.exit(0);
}

const fullSync = args.includes('--full');
const classify = args.includes('--classify');
const dryRun = args.includes('--dry-run');

checkFtInstalled();

// 1. Read state from the last sync
const xState = readJSON(X_STATE_PATH, { lastSync: null, processedIds: [] });
const processedIds = new Set(xState.processedIds || []);

// 2. Run ft sync
if (!dryRun) {
  console.log('Syncing X bookmarks...');
  const syncArgs = ['sync', '--chrome-profile-directory', 'Profile 1'];
  if (fullSync) syncArgs.push('--full');
  if (classify) syncArgs.push('--classify');

  const syncResult = spawnSync('ft', syncArgs, { encoding: 'utf8', stdio: 'inherit' });
  if (syncResult.status !== 0) {
    console.error('Error during ft sync. Is Chrome open with X?');
    process.exit(1);
  }
} else {
  console.log('(dry-run: skipping ft sync)');
}

// 3. Fetch bookmarks via ft list --json with pagination
console.log('\nFetching bookmark list...');

const PAGE_SIZE = 500;

function parseFtJson(raw) {
  const clean = raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // ANSI escape sequences
    .replace(/\r/g, '')                          // carriage returns
    .replace(/[^\x20-\x7E\n\t{}[\]",:0-9.\-_]/g, ''); // non-ASCII (spinners, etc.)
  const start = clean.indexOf('[');
  const end   = clean.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  return JSON.parse(clean.slice(start, end + 1));
}

function buildListArgs(offset) {
  const args = ['list', '--json', '--limit', String(PAGE_SIZE), '--offset', String(offset)];
  if (xState.lastSync && !fullSync) {
    const safeDate = new Date(xState.lastSync);
    safeDate.setDate(safeDate.getDate() - 1);
    args.push('--after', safeDate.toISOString().slice(0, 10));
  }
  return args;
}

let bookmarks = [];
let offset = 0;
while (true) {
  const result = spawnSync('ft', buildListArgs(offset), { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) {
    if (offset === 0) {
      console.log('No bookmarks available or listing error. Have you run ft sync first?');
      process.exit(0);
    }
    break;
  }
  let page;
  try { page = parseFtJson(result.stdout); } catch (err) {
    console.error('Error parsing ft list output:', err.message);
    process.exit(1);
  }
  if (page.length === 0) break;
  bookmarks.push(...page);
  process.stdout.write(`  Fetched ${bookmarks.length}...\r`);
  if (page.length < PAGE_SIZE) break; // last page
  offset += PAGE_SIZE;
}
console.log(`  Total fetched: ${bookmarks.length}` + ' '.repeat(10));

// 4. Filter only the new ones (not yet processed)
const newBookmarks = bookmarks.filter(b => {
  const id = b.id || b.tweet_id || b.tweetId;
  return id && !processedIds.has(String(id));
});

if (newBookmarks.length === 0) {
  console.log(`✓ No new bookmarks. Total available: ${bookmarks.length}`);
  process.exit(0);
}

console.log(`  New: ${newBookmarks.length} of ${bookmarks.length} total`);

if (dryRun) {
  console.log('\n(dry-run) Bookmarks that would be processed:');
  newBookmarks.slice(0, 10).forEach(b => {
    const author = b.authorHandle || b.author_handle || b.author || 'unknown';
    const text = (b.full_text || b.text || '').slice(0, 80);
    console.log(`  @${author}: ${text}...`);
  });
  if (newBookmarks.length > 10) console.log(`  ... and ${newBookmarks.length - 10} more`);
  process.exit(0);
}

// 5. Write to raw/x-bookmarks/
mkdirSync(X_RAW_DIR, { recursive: true });
const filename = `${today()}-x-bookmarks.jsonl`;
const filepath = join(X_RAW_DIR, filename);

// If today's file already exists, append to it
const lines = newBookmarks.map(b => JSON.stringify(b)).join('\n') + '\n';
if (existsSync(filepath)) {
  const current = readFileSync(filepath, 'utf8');
  writeFileSync(filepath, current + lines);
} else {
  writeFileSync(filepath, lines);
}

// 6. Add to pending.json
const pending = readJSON(PENDING_PATH, { pending: [], lastCompile: null });
const alreadyPending = pending.pending.some(
  item => item.path === `raw/x-bookmarks/${filename}` && item.type === 'x-bookmarks'
);
if (!alreadyPending) {
  pending.pending.push({
    path: `raw/x-bookmarks/${filename}`,
    type: 'x-bookmarks',
    count: newBookmarks.length,
    ingested: nowISO()
  });
  writeJSON(PENDING_PATH, pending);
}

// 7. Update sync state
const newIds = newBookmarks.map(b => String(b.id || b.tweetId || b.tweet_id)).filter(Boolean);
writeJSON(X_STATE_PATH, {
  lastSync: nowISO(),
  processedIds: [...processedIds, ...newIds].slice(-10000) // keep last 10k
});

console.log(`\n✓ ${newBookmarks.length} bookmarks saved to raw/x-bookmarks/${filename}`);
console.log(`  ${pending.pending.length} item(s) pending compilation.`);
console.log('\n  To compile: npm run compile  or type "compile the brain" in Claude Code');
