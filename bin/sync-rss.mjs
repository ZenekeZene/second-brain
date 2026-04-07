#!/usr/bin/env node
/**
 * second-brain RSS/Atom feed sync
 * Fetches feeds defined in feeds.json and ingests new articles into raw/articles/.
 *
 * Usage:
 *   node bin/sync-rss.mjs             Sync all feeds (incremental)
 *   node bin/sync-rss.mjs --dry-run   Preview new items without writing
 *   node bin/sync-rss.mjs --force     Re-ingest already-seen items
 *   node bin/sync-rss.mjs --help
 *
 * Configure feeds in feeds.json at the project root:
 *   [{ "url": "https://example.com/feed.rss", "label": "Example Blog" }]
 *
 * Schedule (system cron — every 6 hours):
 *   0 *\/6 * * * cd /path/to/second-brain && node bin/sync-rss.mjs >> .state/rss.log 2>&1
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import TurndownService from 'turndown';
import { autoTag } from './lib/autotag.mjs';
import { log } from './lib/logger.mjs';
import { shouldCompile, triggerMessage } from './lib/reactive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '..');
const FEEDS_PATH = join(ROOT, 'feeds.json');
const SEEN_PATH  = join(ROOT, '.state', 'rss-seen.json');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE   = process.argv.includes('--force');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node bin/sync-rss.mjs             Sync all feeds (incremental)
  node bin/sync-rss.mjs --dry-run   Preview new items without writing
  node bin/sync-rss.mjs --force     Re-ingest already-seen items

Configure feeds in feeds.json at the project root.
`);
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function today() { return new Date().toISOString().slice(0, 10); }
function nowISO() { return new Date().toISOString(); }

function toSlug(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-')
    .slice(0, 60);
}

function unescapeHtml(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractCdata(str) {
  const m = (str || '').match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/s);
  return m ? m[1] : str;
}

function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── RSS / Atom parser (no external deps) ─────────────────────────────────────

function parseRss(xml) {
  const items = [];
  const matches = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)];
  for (const m of matches) {
    const raw = m[1];
    const get = (tag) => {
      const r = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return r ? unescapeHtml(extractCdata(r[1].trim())) : null;
    };
    const link = get('link') ||
      (raw.match(/<link[^>]+href="([^"]+)"/i)?.[1]) || null;
    items.push({
      title:   get('title'),
      link,
      guid:    get('guid') || link,
      date:    get('pubDate') || get('dc:date'),
      content: get('content:encoded') || get('description'),
    });
  }
  return items;
}

function parseAtom(xml) {
  const items = [];
  const matches = [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)];
  for (const m of matches) {
    const raw = m[1];
    const get = (tag) => {
      const r = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return r ? unescapeHtml(extractCdata(r[1].trim())) : null;
    };
    const link = raw.match(/<link[^>]+rel="alternate"[^>]+href="([^"]+)"/i)?.[1]
      || raw.match(/<link[^>]+href="([^"]+)"(?![^>]*rel="self")/i)?.[1]
      || null;
    items.push({
      title:   get('title'),
      link,
      guid:    get('id') || link,
      date:    get('updated') || get('published'),
      content: get('content') || get('summary'),
    });
  }
  return items;
}

function parseFeed(xml) {
  if (/<feed[\s>]/i.test(xml)) return parseAtom(xml);
  return parseRss(xml);
}

// ── Core ──────────────────────────────────────────────────────────────────────

function readPending() {
  try { return JSON.parse(readFileSync(PENDING_PATH, 'utf8')); }
  catch { return { pending: [], lastCompile: null }; }
}

async function syncFeed(feedConfig, seen) {
  const { url, label } = feedConfig;
  log('info', 'rss:fetch', { url });

  let xml;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SecondBrain/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    log('error', 'rss:fetch failed', { url, error: err.message });
    console.error(`  Error fetching ${label}: ${err.message}`);
    return 0;
  }

  const items = parseFeed(xml).filter(i => i.link && i.title);
  const newItems = FORCE ? items : items.filter(i => !seen.has(i.guid || i.link));

  if (newItems.length === 0) {
    console.log(`  ${label}: no new items`);
    return 0;
  }

  const dir = join(ROOT, 'raw', 'articles');
  mkdirSync(dir, { recursive: true });

  let saved = 0;
  for (const item of newItems) {
    const slug = toSlug(item.title);
    const filename = `${today()}-${slug}.md`;
    const filepath = join(dir, filename);

    // Convert HTML content to markdown (use excerpt if full content unavailable)
    const rawContent = item.content || '';
    const markdown = rawContent.trim().startsWith('<')
      ? td.turndown(rawContent)
      : rawContent;
    const excerpt = stripTags(rawContent).slice(0, 300);

    const tags = DRY_RUN ? [] : await autoTag(`${item.title} ${excerpt}`);
    const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';

    const content = `---
source: ${item.link}
title: "${(item.title || '').replace(/"/g, '\\"')}"
ingested: ${nowISO()}
type: article
status: pending
feed: "${label}"
${tagsStr}---

# ${item.title}

${markdown || `> Full content will be fetched during compilation.\n>\n> Source: ${item.link}`}
`;

    if (DRY_RUN) {
      console.log(`  [dry-run] ${label}: "${item.title}"`);
      console.log(`            ${item.link}`);
    } else {
      // Skip if file already exists (e.g. same slug different day)
      if (!existsSync(filepath)) {
        writeFileSync(filepath, content);
      }

      const state = readPending();
      state.pending.push({ path: `raw/articles/${filename}`, ingested: nowISO(), type: 'article' });
      writeJson(PENDING_PATH, state);

      seen.add(item.guid || item.link);
      log('info', 'rss:saved', { file: filename, feed: label });
      console.log(`  ${label}: saved "${item.title}"`);
    }
    saved++;
  }

  return saved;
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!existsSync(FEEDS_PATH)) {
  console.error(`No feeds.json found. Create one at ${FEEDS_PATH}:`);
  console.error(`  [{ "url": "https://example.com/feed.rss", "label": "Example" }]`);
  process.exit(1);
}

const feeds = readJson(FEEDS_PATH, []);
if (feeds.length === 0) {
  console.log('No feeds configured in feeds.json.');
  process.exit(0);
}

const seenData = readJson(SEEN_PATH, []);
const seen = new Set(seenData);

console.log(`\nSecond Brain — RSS Sync${DRY_RUN ? ' (dry-run)' : ''}`);
console.log(`  Feeds: ${feeds.length} | Seen: ${seen.size} items\n`);

let totalNew = 0;
for (const feed of feeds) {
  totalNew += await syncFeed(feed, seen);
}

if (!DRY_RUN) {
  writeJson(SEEN_PATH, [...seen]);
}

console.log(`\n${totalNew} new item${totalNew !== 1 ? 's' : ''} ingested.`);
log('info', 'rss:done', { feeds: feeds.length, new: totalNew });

// Reactive compilation check
if (!DRY_RUN && totalNew > 0) {
  const state = readPending();
  const trigger = shouldCompile(state);
  if (trigger) {
    console.log(`\nReactive compilation triggered: ${triggerMessage(trigger)}`);
    try {
      execFileSync(process.execPath, [join(ROOT, 'bin', 'compile.mjs')], { cwd: ROOT, stdio: 'inherit' });
    } catch { /* compile prints its own error */ }
  }
}
