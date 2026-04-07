#!/usr/bin/env node
/**
 * second-brain status
 * Usage:
 *   node bin/status.mjs          One-liner for hooks
 *   node bin/status.mjs --full   Detailed report
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const [,, flag] = process.argv;

if (flag === '--help' || flag === '-h') {
  console.log(`
Usage:
  node bin/status.mjs           One-liner status (used by SessionStart hook)
  node bin/status.mjs --full    Detailed report with pending items and recent articles
`);
  process.exit(0);
}

function readPending() {
  try {
    return JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8'));
  } catch {
    return { pending: [], lastCompile: null };
  }
}

function countWikiArticles() {
  const wikiDir = join(ROOT, 'wiki');
  if (!existsSync(wikiDir)) return 0;
  try {
    return readdirSync(wikiDir).filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

function timeAgo(isoString) {
  if (!isoString) return 'never';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'just now';
}

function recentArticles(n = 5) {
  const wikiDir = join(ROOT, 'wiki');
  if (!existsSync(wikiDir)) return [];
  try {
    return readdirSync(wikiDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f, mtime: statSync(join(wikiDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, n)
      .map(f => `  - ${f.name.replace('.md', '')} (${timeAgo(f.mtime.toISOString())})`);
  } catch {
    return [];
  }
}

const state = readPending();
const articles = countWikiArticles();
const pending = state.pending.length;
const lastCompile = timeAgo(state.lastCompile);

if (flag === '--full') {
  console.log(`\n🧠 Second Brain\n`);
  console.log(`  Wiki articles : ${articles}`);
  console.log(`  Pending       : ${pending}`);
  console.log(`  Last compile  : ${lastCompile}`);
  if (pending > 0) {
    console.log(`\n  Pending items:`);
    state.pending.forEach(item => {
      console.log(`  - [${item.type}] ${item.path || item.file}`);
    });
  }
  const recent = recentArticles();
  if (recent.length > 0) {
    console.log(`\n  Recent articles:`);
    recent.forEach(r => console.log(r));
  }
  console.log('');
} else {
  const pendingStr = pending > 0 ? ` | ⏳ ${pending} pending` : '';
  console.log(`🧠 Second Brain: ${articles} articles${pendingStr} | compiled ${lastCompile}`);
}
