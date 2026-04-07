#!/usr/bin/env node
/**
 * second-brain ingest
 * Usage:
 *   node bin/ingest.mjs url <url> [--title "Title"]
 *   node bin/ingest.mjs note "Note text"
 *   node bin/ingest.mjs bookmark <url>
 *   node bin/ingest.mjs file <path>
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname, basename, extname, relative } from 'path';
import { fileURLToPath } from 'url';
import TurndownService from 'turndown';
import { autoTag } from './lib/autotag.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');

const HELP = `
Usage:
  node bin/ingest.mjs url <url> [--title "Title"]   Fetch and save a web article
  node bin/ingest.mjs note "Note text"               Save a quick note
  node bin/ingest.mjs bookmark <url>                 Save a URL for later
  node bin/ingest.mjs file <path>                    Ingest a local file
`;

// ── helpers ──────────────────────────────────────────────────────────────────

function toSlug(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function readPending() {
  try {
    return JSON.parse(readFileSync(PENDING_PATH, 'utf8'));
  } catch {
    return { pending: [], lastCompile: null };
  }
}

function writePending(state) {
  writeFileSync(PENDING_PATH, JSON.stringify(state, null, 2) + '\n');
}

function addToPending(state, item) {
  state.pending.push(item);
  writePending(state);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

// ── commands ──────────────────────────────────────────────────────────────────

async function ingestUrl(url, customTitle) {
  console.log(`Fetching ${url}...`);

  let html;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SecondBrain/1.0)' }
    });
    html = await res.text();
  } catch (err) {
    console.error(`Error fetching URL: ${err.message}`);
    process.exit(1);
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = customTitle || (titleMatch ? titleMatch[1].trim() : url);

  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const cleanHtml = html
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const markdown = td.turndown(cleanHtml);
  const slug = toSlug(title);
  const filename = `${today()}-${slug}.md`;
  const dir = join(ROOT, 'raw', 'articles');
  ensureDir(dir);
  const filepath = join(dir, filename);

  const tags = await autoTag(`${title} ${markdown.slice(0, 500)}`);
  const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';

  const content = `---
source: ${url}
title: "${title.replace(/"/g, '\\"')}"
ingested: ${nowISO()}
type: article
status: pending
${tagsStr}---

# ${title}

${markdown}
`;

  writeFileSync(filepath, content);

  const state = readPending();
  addToPending(state, { path: `raw/articles/${filename}`, ingested: nowISO(), type: 'article' });

  console.log(`✓ Saved to raw/articles/${filename}`);
  console.log(`  ${state.pending.length} item(s) pending compilation.`);
}

async function ingestNote(text) {
  const slug = toSlug(text.split(' ').slice(0, 6).join(' '));
  const filename = `${today()}-${slug}.md`;
  const dir = join(ROOT, 'raw', 'notes');
  ensureDir(dir);
  const filepath = join(dir, filename);

  const tags = await autoTag(text);
  const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';

  const content = `---
ingested: ${nowISO()}
type: note
status: pending
${tagsStr}---

${text}
`;

  writeFileSync(filepath, content);

  const state = readPending();
  addToPending(state, { path: `raw/notes/${filename}`, ingested: nowISO(), type: 'note' });

  console.log(`✓ Note saved to raw/notes/${filename}`);
  console.log(`  ${state.pending.length} item(s) pending compilation.`);
}

function ingestBookmark(url) {
  const filename = `${today()}-bookmarks.md`;
  const dir = join(ROOT, 'raw', 'bookmarks');
  ensureDir(dir);
  const filepath = join(dir, filename);

  const line = `- [ ] ${url} — (process)\n`;

  if (!existsSync(filepath)) {
    const header = `---
ingested: ${nowISO()}
type: bookmark
status: pending
---

# Bookmarks ${today()}

`;
    writeFileSync(filepath, header + line);
    const state = readPending();
    addToPending(state, { path: `raw/bookmarks/${filename}`, ingested: nowISO(), type: 'bookmark' });
  } else {
    const current = readFileSync(filepath, 'utf8');
    writeFileSync(filepath, current + line);
  }

  const state = readPending();
  console.log(`✓ Bookmark saved to raw/bookmarks/${filename}`);
  console.log(`  ${state.pending.length} item(s) pending compilation.`);
}

async function ingestFile(filePath) {
  if (!existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  const name = basename(filePath, extname(filePath));
  const slug = toSlug(name);
  const ext = extname(filePath).toLowerCase();
  const filename = `${today()}-${slug}.md`;
  const dir = join(ROOT, 'raw', 'files');
  ensureDir(dir);
  const destPath = join(dir, filename);

  let content;
  if (ext === '.md' || ext === '.txt') {
    const fileContent = readFileSync(filePath, 'utf8');
    const tags = await autoTag(`${name} ${fileContent.slice(0, 500)}`);
    const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';
    content = `---
source_file: ${relative(ROOT, filePath)}
original_name: ${basename(filePath)}
ingested: ${nowISO()}
type: file
status: pending
${tagsStr}---

${fileContent}
`;
  } else {
    const tags = await autoTag(name);
    const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';
    const originalDest = join(dir, basename(filePath));
    copyFileSync(filePath, originalDest);
    content = `---
source_file: ${relative(ROOT, filePath)}
original_name: ${basename(filePath)}
ingested: ${nowISO()}
type: file
status: pending
${tagsStr}---

# ${name}

> Original file: raw/files/${basename(filePath)}
> Format: ${ext.slice(1).toUpperCase()}

<!-- The LLM will process this file during compilation -->
`;
    writeFileSync(join(dir, basename(filePath)), readFileSync(filePath));
  }

  writeFileSync(destPath, content);

  const state = readPending();
  addToPending(state, { path: `raw/files/${filename}`, ingested: nowISO(), type: 'file' });

  console.log(`✓ File saved to raw/files/${filename}`);
  console.log(`  ${state.pending.length} item(s) pending compilation.`);
}

// ── main ──────────────────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv;

if (!command || command === '--help' || command === '-h') {
  console.log(HELP);
  process.exit(0);
}

switch (command) {
  case 'url': {
    const url = args[0];
    const titleIdx = args.indexOf('--title');
    const title = titleIdx !== -1 ? args[titleIdx + 1] : null;
    if (!url) { console.error('Missing URL'); process.exit(1); }
    await ingestUrl(url, title);
    break;
  }
  case 'note': {
    const text = args.join(' ');
    if (!text) { console.error('Missing note text'); process.exit(1); }
    await ingestNote(text);
    break;
  }
  case 'bookmark': {
    const url = args[0];
    if (!url) { console.error('Missing URL'); process.exit(1); }
    await ingestBookmark(url);
    break;
  }
  case 'file': {
    const filePath = args[0];
    if (!filePath) { console.error('Missing file path'); process.exit(1); }
    ingestFile(filePath);
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.log(HELP);
    process.exit(1);
}
