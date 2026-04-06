#!/usr/bin/env node
/**
 * second-brain status
 * Uso:
 *   node bin/status.mjs          → one-liner para hooks
 *   node bin/status.mjs --full   → informe detallado
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

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
  if (!isoString) return 'nunca';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `hace ${days}d`;
  if (hours > 0) return `hace ${hours}h`;
  if (mins > 0) return `hace ${mins}m`;
  return 'ahora mismo';
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

const [,, flag] = process.argv;

if (flag === '--full') {
  console.log(`\n🧠 Second Brain — Estado\n`);
  console.log(`  Artículos wiki : ${articles}`);
  console.log(`  Pendientes     : ${pending}`);
  console.log(`  Última compilación: ${lastCompile}`);
  if (pending > 0) {
    console.log(`\n  Pendientes de compilar:`);
    state.pending.forEach(item => {
      console.log(`  - [${item.type}] ${item.path || item.file}`);
    });
  }
  const recent = recentArticles();
  if (recent.length > 0) {
    console.log(`\n  Artículos recientes:`);
    recent.forEach(r => console.log(r));
  }
  console.log('');
} else {
  // One-liner para el hook de SessionStart
  const pendingStr = pending > 0 ? ` | ⏳ ${pending} pendientes` : '';
  console.log(`🧠 Second Brain: ${articles} artículos${pendingStr} | compilado ${lastCompile}`);
}
