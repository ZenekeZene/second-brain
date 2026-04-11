#!/usr/bin/env node
/**
 * second-brain local wiki viewer
 * Renders wiki articles as a navigable website with clickable [[wikilinks]].
 *
 * Usage:
 *   node bin/wiki-server.mjs           Start at http://localhost:4242
 *   node bin/wiki-server.mjs --port 8080
 *
 * No Obsidian required.
 */

import { createServer } from 'http';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import busboy from 'busboy';
import OpenAI from 'openai';
import { buildTimelineHtml } from './lib/timeline.mjs';
import { buildGraphHtml } from './lib/graph.mjs';
import {
  ingestUrl, ingestNote, ingestBookmark, ingestFile,
  ingestImage, ingestVoice, ingestPdf, detectType,
} from './lib/ingest-helpers.mjs';
import { readTasks, markDone, formatDue } from './lib/task-helpers.mjs';
import { searchSemantic } from './lib/embeddings.mjs';

// Load .env for INGEST_TOKEN
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [k, ...v] = line.split('=');
    if (k && v.length && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim();
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const WIKI_DIR  = join(ROOT, 'wiki');

// Lazy OpenAI client — only initialized if OPENAI_API_KEY is set
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set — cannot process images or audio');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

const portArg = process.argv.indexOf('--port');
const PORT    = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10)
              : parseInt(process.env.WIKI_PORT || '4321', 10);

// ── Wiki loader ───────────────────────────────────────────────────────────────

function slug(filename) { return filename.replace(/\.md$/, ''); }

function readArticle(slugName) {
  const path = join(WIKI_DIR, `${slugName}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const [k, ...v] = line.split(':');
    if (k && v.length) meta[k.trim()] = v.join(':').trim();
  }
  // Parse tags array: [tag1, tag2] or multiline
  const tagsMatch = m[1].match(/^tags:\s*\[([^\]]*)\]/m);
  if (tagsMatch) meta.tags = tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean);
  else meta.tags = [];
  return { meta, body: content.slice(m[0].length) };
}

function allArticles() {
  if (!existsSync(WIKI_DIR)) return [];
  // Root wiki files
  const entries = readdirSync(WIKI_DIR)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
    .map(f => ({ slug: slug(f), file: join(WIKI_DIR, f) }));
  // journal/ subdirectory
  const journalDir = join(WIKI_DIR, 'journal');
  if (existsSync(journalDir)) {
    readdirSync(journalDir)
      .filter(f => f.endsWith('.md'))
      .forEach(f => entries.push({ slug: `journal/${slug(f)}`, file: join(journalDir, f) }));
  }
  return entries.map(({ slug: s, file }) => {
      const content = readFileSync(file, 'utf8');
      const { meta } = parseFrontmatter(content);
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const summaryMatch = content.match(/^>\s+(.+)$/m);
      const mtime = statSync(file).mtime;
      return {
        slug: s,
        title: titleMatch ? titleMatch[1] : s,
        summary: summaryMatch ? summaryMatch[1] : '',
        tags: meta.tags || [],
        updated: meta.updated || '',
        mtime,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Build map: slug → [list of slugs that link to it] */
function buildBacklinks(articles) {
  const bl = {};
  const WIKILINK_RE = /\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g;
  for (const art of articles) {
    const content = readArticle(art.slug) || '';
    for (const m of content.matchAll(WIKILINK_RE)) {
      const target = m[1].trim().toLowerCase().replace(/\s+/g, '-');
      if (!bl[target]) bl[target] = [];
      if (!bl[target].includes(art.slug)) bl[target].push(art.slug);
    }
  }
  return bl;
}

// ── Markdown rendering ────────────────────────────────────────────────────────

const slugSet = new Set(); // populated per request

function processWikilinks(md, existingSlugSet) {
  return md.replace(/\[\[([^\]|#\n]+?)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const display  = alias || target;
    const href     = `/wiki/${encodeURIComponent(target.trim().toLowerCase().replace(/\s+/g, '-'))}`;
    const exists   = existingSlugSet.has(target.trim().toLowerCase().replace(/\s+/g, '-'));
    const cls      = exists ? 'wikilink' : 'wikilink missing';
    return `<a href="${href}" class="${cls}">${display}</a>`;
  });
}

function renderMarkdown(body, existingSlugSet) {
  const withLinks = processWikilinks(body, existingSlugSet);
  return marked.parse(withLinks);
}

// ── HTML templates ────────────────────────────────────────────────────────────

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: #f8f9fa; color: #1a1a1a; display: flex; min-height: 100vh; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }

/* Sidebar */
#sidebar { width: 260px; min-width: 260px; background: #fff; border-right: 1px solid #e5e7eb;
           display: flex; flex-direction: column; height: 100vh; position: sticky; top: 0;
           overflow-y: auto; }
#sidebar-header { padding: 14px 16px 12px; border-bottom: 1px solid #e5e7eb; }
#sidebar-header a { font-weight: 700; font-size: 15px; color: #1a1a1a; }
#sidebar-header small { display: block; color: #9ca3af; font-size: 11px; margin-top: 2px; }
#sidebar-nav { display: flex; border-bottom: 1px solid #e5e7eb; }
#sidebar-nav a { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
                 padding: 10px 4px; font-size: 10px; color: #6b7280; text-decoration: none;
                 border-bottom: 2px solid transparent; transition: color .15s; }
#sidebar-nav a:hover { color: #1a1a1a; background: #f9fafb; }
#sidebar-nav a.active { color: #2563eb; border-bottom-color: #2563eb; }
#sidebar-nav .nav-icon { font-size: 16px; line-height: 1; }
#search-wrap { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
#search { width: 100%; padding: 7px 10px; border: 1px solid #d1d5db; border-radius: 6px;
          font-size: 13px; outline: none; }
#search:focus { border-color: #2563eb; }
#article-list { padding: 8px 0; flex: 1; overflow-y: auto; }
.article-item { display: block; padding: 7px 16px; font-size: 13px; color: #374151;
                border-left: 3px solid transparent; }
.article-item:hover { background: #f3f4f6; text-decoration: none; color: #1a1a1a; }
.article-item.active { border-left-color: #2563eb; background: #eff6ff; color: #2563eb; font-weight: 500; }
.article-item .item-date { font-size: 11px; color: #9ca3af; display: block; margin-top: 1px; }

/* Content */
#content { flex: 1; max-width: 780px; padding: 40px 48px; overflow-y: auto; }
#content h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; line-height: 1.3; }
#content h2 { font-size: 18px; font-weight: 600; margin: 28px 0 10px; padding-bottom: 6px;
              border-bottom: 1px solid #e5e7eb; }
#content h3 { font-size: 15px; font-weight: 600; margin: 20px 0 8px; }
#content p  { line-height: 1.7; margin-bottom: 14px; font-size: 15px; }
#content ul, #content ol { margin: 0 0 14px 24px; }
#content li { line-height: 1.7; font-size: 15px; margin-bottom: 4px; }
#content blockquote { border-left: 4px solid #d1d5db; padding: 10px 16px; color: #4b5563;
                      background: #f9fafb; border-radius: 0 6px 6px 0; margin-bottom: 16px;
                      font-style: italic; }
#content code { background: #f1f5f9; padding: 2px 5px; border-radius: 4px;
                font-size: 13px; font-family: 'SF Mono', 'Fira Code', monospace; color: #be185d; }
#content pre  { background: #1e293b; color: #e2e8f0; padding: 16px; border-radius: 8px;
                overflow-x: auto; margin-bottom: 16px; }
#content pre code { background: none; color: inherit; padding: 0; font-size: 13px; }
#content table { border-collapse: collapse; width: 100%; margin-bottom: 16px; font-size: 14px; }
#content th, #content td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
#content th { background: #f9fafb; font-weight: 600; }
#content hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
#content img { max-width: 100%; border-radius: 6px; }

/* Wikilinks */
.wikilink { color: #2563eb; }
.wikilink.missing { color: #dc2626; border-bottom: 1px dashed #dc2626; }

/* Tags */
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 24px; }
.tag { background: #eff6ff; color: #1d4ed8; padding: 3px 10px; border-radius: 999px;
       font-size: 12px; font-weight: 500; }
.tag a { color: inherit; }

/* Backlinks */
#backlinks { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
#backlinks h4 { font-size: 13px; font-weight: 600; color: #6b7280; text-transform: uppercase;
                letter-spacing: 0.05em; margin-bottom: 10px; }
.backlink-list { display: flex; flex-wrap: wrap; gap: 8px; }
.backlink-pill { background: #f3f4f6; padding: 4px 12px; border-radius: 999px; font-size: 13px; }

/* Meta */
.article-meta { font-size: 13px; color: #6b7280; margin-bottom: 20px; }

/* Search results */
.search-result { padding: 16px 0; border-bottom: 1px solid #e5e7eb; }
.search-result h3 { margin-bottom: 4px; font-size: 16px; }
.search-result p  { font-size: 14px; color: #4b5563; margin: 0; }

/* Empty states */
.empty { color: #6b7280; font-size: 15px; margin-top: 40px; }

@media (max-width: 768px) {
  #sidebar { display: none; }
  #content { padding: 24px 20px; }
}
`;

function layout(content, articles, activeSlug = '', title = 'Second Brain') {
  const listItems = articles.map(a => `
    <a href="/wiki/${a.slug}" class="article-item${a.slug === activeSlug ? ' active' : ''}">
      ${escHtml(a.title)}
      ${a.updated ? `<span class="item-date">${a.updated}</span>` : ''}
    </a>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  <style>${CSS}</style>
</head>
<body>
  <nav id="sidebar">
    <div id="sidebar-header">
      <a href="/">Second Brain</a>
      <small>${articles.length} article${articles.length !== 1 ? 's' : ''}</small>
    </div>
    <nav id="sidebar-nav">
      <a href="/" class="${activeSlug === '' ? 'active' : ''}"><span class="nav-icon">📄</span>Articles</a>
      <a href="/graph" class="${activeSlug === '__graph' ? 'active' : ''}"><span class="nav-icon">🕸️</span>Graph</a>
      <a href="/timeline" class="${activeSlug === '__timeline' ? 'active' : ''}"><span class="nav-icon">📅</span>Timeline</a>
      <a href="/ingest" class="${activeSlug === '__ingest' ? 'active' : ''}"><span class="nav-icon">➕</span>Ingest</a>
      <a href="/tasks" class="${activeSlug === '__tasks' ? 'active' : ''}"><span class="nav-icon">✓</span>Tasks</a>
      <a href="/pending" class="${activeSlug === '__pending' ? 'active' : ''}"><span class="nav-icon">⏳</span>Pending</a>
    </nav>
    <div id="search-wrap">
      <input id="search" type="search" placeholder="Search articles..." autocomplete="off"
             value="" oninput="filterList(this.value)">
    </div>
    <div id="article-list">${listItems}</div>
  </nav>
  <main id="content">${content}</main>
  <script>
    let _searchTimer = null;
    let _semanticActive = false;

    function filterList(q) {
      q = q.toLowerCase();
      document.querySelectorAll('.article-item').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }

    function showSemanticResults(results) {
      _semanticActive = true;
      const list = document.getElementById('article-list');
      list.innerHTML = results.map(r => \`
        <a href="/wiki/\${r.slug}" class="article-item">
          \${escHtml(r.title)}
          \${r.summary ? \`<span class="item-date">\${escHtml(r.summary.slice(0, 60))}\${r.summary.length > 60 ? '…' : ''}</span>\` : ''}
        </a>\`).join('') +
        \`<div style="padding:8px 16px;font-size:11px;color:#9ca3af;">✦ semantic search</div>\`;
    }

    function clearSemanticResults() {
      if (!_semanticActive) return;
      _semanticActive = false;
      const list = document.getElementById('article-list');
      list.innerHTML = document.getElementById('_all-items').innerHTML;
    }

    function escHtml(s) {
      return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    async function semanticSearch(q) {
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(q));
        if (!res.ok) { clearSemanticResults(); filterList(q); return; }
        const { results } = await res.json();
        if (results?.length > 0) {
          showSemanticResults(results);
        } else {
          const list = document.getElementById('article-list');
          list.innerHTML = \`<div style="padding:12px 16px;font-size:12px;color:#6b7280;">No results for "\${escHtml(q)}"</div>\`;
          _semanticActive = true;
        }
      } catch { clearSemanticResults(); filterList(q); }
    }

    // Store original list for restore
    const _snap = document.createElement('template');
    _snap.id = '_all-items';
    _snap.innerHTML = document.getElementById('article-list').innerHTML;
    document.body.appendChild(_snap);

    const inp = document.getElementById('search');

    inp.addEventListener('input', e => {
      const q = e.target.value;
      sessionStorage.setItem('search', q);
      clearTimeout(_searchTimer);
      if (!q) { clearSemanticResults(); filterList(''); return; }
      // instant client-side filter
      clearSemanticResults();
      filterList(q);
      // debounced semantic search for longer queries
      if (q.length >= 3) {
        _searchTimer = setTimeout(() => semanticSearch(q), 400);
      }
    });

    // Restore search from sessionStorage
    const _q = sessionStorage.getItem('search') || '';
    if (_q) { inp.value = _q; filterList(_q); }
  </script>
</body>
</html>`;
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Ingest API ────────────────────────────────────────────────────────────────

function handleIngestPage(token) {
  const tokenScript = token ? `const INGEST_TOKEN = ${JSON.stringify(token)};` : `const INGEST_TOKEN = '';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ingest — Second Brain</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f172a; color: #e2e8f0; display: flex; justify-content: center;
           align-items: flex-start; min-height: 100vh; padding: 48px 16px; }
    a { color: #60a5fa; }

    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px;
            padding: 32px; width: 100%; max-width: 580px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; color: #f1f5f9; }
    .subtitle { color: #64748b; font-size: 13px; margin-bottom: 24px; }

    /* Drop zone */
    .drop-zone { border: 2px dashed #334155; border-radius: 12px; padding: 20px;
                 transition: border-color .2s, background .2s; }
    .drop-zone.drag-over { border-color: #3b82f6; background: rgba(59,130,246,.06); }
    textarea { width: 100%; background: transparent; border: none; outline: none;
               color: #e2e8f0; font-size: 14px; font-family: inherit; line-height: 1.6;
               resize: none; min-height: 90px; }
    textarea::placeholder { color: #475569; }

    .drop-hint { display: flex; align-items: center; gap: 8px; margin-top: 12px;
                 padding-top: 12px; border-top: 1px solid #334155; color: #475569; font-size: 12px; }
    .drop-hint > span:first-child { flex: 1; }
    .type-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
                  font-weight: 600; background: #0f172a; color: #60a5fa; }
    .type-badge.note    { color: #a78bfa; }
    .type-badge.image   { color: #34d399; }
    .type-badge.voice   { color: #f59e0b; }
    .type-badge.pdf     { color: #f87171; }
    .type-badge.file    { color: #94a3b8; }
    .type-badge.article { color: #60a5fa; }

    /* Actions */
    .actions { display: flex; gap: 10px; margin-top: 16px; }
    .btn-primary { flex: 1; padding: 10px 16px; background: #3b82f6; color: #fff; border: none;
                   border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background .15s; }
    .btn-primary:hover { background: #2563eb; }
    .btn-primary:disabled { background: #1e3a5f; color: #475569; cursor: not-allowed; }
    .btn-file { padding: 10px 14px; background: #0f172a; color: #94a3b8; border: 1px solid #334155;
                border-radius: 8px; font-size: 13px; cursor: pointer; white-space: nowrap; transition: all .15s; }
    .btn-file:hover { border-color: #475569; color: #e2e8f0; }
    #file-input { display: none; }

    /* Queue */
    #queue { margin-top: 24px; display: flex; flex-direction: column; gap: 8px; }
    .q-item { display: flex; align-items: center; gap: 10px; background: #0f172a;
               border: 1px solid #1e3a5f; border-radius: 8px; padding: 10px 12px; }
    .q-icon { font-size: 16px; flex-shrink: 0; width: 20px; text-align: center; }
    .q-name { flex: 1; font-size: 13px; color: #cbd5e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .q-status { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px; flex-shrink: 0; }
    .q-status.pending    { background: #1e293b; color: #475569; }
    .q-status.processing { background: #1e3a5f; color: #60a5fa; }
    .q-status.done       { background: #052e16; color: #4ade80; }
    .q-status.error      { background: #450a0a; color: #f87171; }
    .q-badge { font-size: 11px; color: #475569; flex-shrink: 0; }
    .spin { display: inline-block; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Nav */
    .back { margin-top: 24px; font-size: 12px; color: #475569; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Add to Brain</h1>
    <p class="subtitle">Drop, paste, or type anything — URLs, notes, images, PDFs, audio.</p>

    <div class="drop-zone" id="drop-zone">
      <textarea id="content" rows="4" placeholder="Paste a URL, type a note, or drop files here…"
                autocomplete="off" spellcheck="true"></textarea>
      <div class="drop-hint">
        <span>Drop files anywhere on this card · Cmd+Enter to save</span>
        <span id="type-preview" class="type-badge" style="display:none"></span>
      </div>
    </div>

    <div class="actions">
      <button class="btn-primary" id="save-btn" onclick="submitText()">Add to Brain</button>
      <label class="btn-file" for="file-input">Browse files</label>
      <input type="file" id="file-input" multiple accept="*/*">
    </div>

    <div id="queue"></div>
    <p class="back"><a href="/">← Back to wiki</a></p>
  </div>

  <script>
    ${tokenScript}

    // ── Type detection (client-side, cosmetic only) ─────────────────────────
    const URL_RE = /^https?:\\/\\/\\S+$/;
    function guessType(text, mime) {
      if (mime) {
        if (mime.startsWith('image/'))          return 'image';
        if (mime.startsWith('audio/'))          return 'voice';
        if (mime === 'application/pdf')         return 'pdf';
        if (mime !== 'text/plain')              return 'file';
      }
      if (URL_RE.test(text.trim()))             return 'article';
      return 'note';
    }
    const TYPE_ICONS = { article: '🔗', note: '📝', image: '🖼️', voice: '🎤', pdf: '📄', file: '📎' };

    // ── Queue ───────────────────────────────────────────────────────────────
    const queue = [];
    let isProcessing = false;

    function enqueueText(text) {
      if (!text.trim()) return;
      const id = crypto.randomUUID();
      const type = guessType(text, null);
      queue.push({ id, label: text.length > 60 ? text.slice(0, 58) + '…' : text, type, status: 'pending', send: () => sendJson(text) });
      renderQueue();
      processNext();
    }

    function enqueueFile(file) {
      const id = crypto.randomUUID();
      const type = guessType('', file.type);
      queue.push({ id, label: file.name, type, status: 'pending', send: () => sendFile(file) });
      renderQueue();
      processNext();
    }

    async function processNext() {
      if (isProcessing) return;
      const item = queue.find(i => i.status === 'pending');
      if (!item) return;
      isProcessing = true;
      item.status = 'processing';
      renderQueue();
      try {
        const result = await item.send();
        item.status = 'done';
        item.message = result.message || 'Saved';
        if (result.items?.[0]?.type) item.type = result.items[0].type;
      } catch (e) {
        item.status = 'error';
        item.message = e.message || 'Error';
      }
      renderQueue();
      isProcessing = false;
      processNext();
    }

    function renderQueue() {
      const el = document.getElementById('queue');
      if (!queue.length) { el.innerHTML = ''; return; }
      el.innerHTML = queue.map(item => {
        const icon = TYPE_ICONS[item.type] || '📎';
        const spin = item.status === 'processing' ? ' spin' : '';
        const statusLabels = { pending: 'Pending', processing: 'Uploading…', done: 'Saved', error: item.message || 'Error' };
        return \`<div class="q-item">
          <span class="q-icon\${spin}">\${icon}</span>
          <span class="q-name">\${escHtml(item.label)}</span>
          <span class="q-badge type-badge \${item.type}">\${item.type}</span>
          <span class="q-status \${item.status}">\${statusLabels[item.status]}</span>
        </div>\`;
      }).join('');
    }

    function escHtml(s) {
      return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ── API calls ───────────────────────────────────────────────────────────
    function authHeaders(extra) {
      const h = { ...extra };
      if (INGEST_TOKEN) h['Authorization'] = 'Bearer ' + INGEST_TOKEN;
      return h;
    }

    async function sendJson(content) {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      return data;
    }

    async function sendFile(file) {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: authHeaders({}),
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      return data;
    }

    // ── Interactions ────────────────────────────────────────────────────────

    function submitText() {
      const ta = document.getElementById('content');
      const text = ta.value.trim();
      if (!text) return;
      enqueueText(text);
      ta.value = '';
      updateTypePreview('');
    }

    // Textarea: live type preview + Cmd/Ctrl+Enter shortcut
    const ta = document.getElementById('content');
    ta.addEventListener('input', () => updateTypePreview(ta.value));
    ta.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitText(); }
    });

    function updateTypePreview(text) {
      const badge = document.getElementById('type-preview');
      if (!text.trim()) { badge.style.display = 'none'; return; }
      const type = guessType(text, null);
      badge.textContent = type;
      badge.className = 'type-badge ' + type;
      badge.style.display = '';
    }

    // File input
    document.getElementById('file-input').addEventListener('change', e => {
      for (const f of e.target.files) enqueueFile(f);
      e.target.value = '';
    });

    // Drag & drop — entire card
    const card = document.querySelector('.card');
    card.addEventListener('dragover', e => { e.preventDefault(); document.getElementById('drop-zone').classList.add('drag-over'); });
    card.addEventListener('dragleave', e => { if (!card.contains(e.relatedTarget)) document.getElementById('drop-zone').classList.remove('drag-over'); });
    card.addEventListener('drop', e => {
      e.preventDefault();
      document.getElementById('drop-zone').classList.remove('drag-over');
      // Files
      for (const f of e.dataTransfer.files) enqueueFile(f);
      // Text/URL dragged from browser
      const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
      if (text && !e.dataTransfer.files.length) enqueueText(text);
    });

    // Paste: intercept image pastes; let text fall through to textarea naturally
    document.addEventListener('paste', e => {
      const items = [...(e.clipboardData?.items || [])];
      const imageItem = items.find(i => i.type.startsWith('image/'));
      if (imageItem) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (file) enqueueFile(file);
      }
      // Text paste: let browser handle it into the textarea
    });
  </script>
</body>
</html>`;
}

/** Route a single text/url item to the correct ingest function */
async function processTextItem(content) {
  const type = detectType(content, null, null);
  let result;
  if (type === 'url')       result = await ingestUrl(ROOT, content);
  else if (type === 'note') result = await ingestNote(ROOT, content, 'web');
  else                      result = await ingestBookmark(ROOT, content, 'web');
  return { type, ...result };
}

/** Route a binary file item to the correct ingest function */
async function processFileItem(buffer, filename, mimeType) {
  const type = detectType('', mimeType, filename);
  let result;
  if (type === 'image')     result = await ingestImage(ROOT, getOpenAI(), buffer, filename, mimeType, '');
  else if (type === 'voice') result = await ingestVoice(ROOT, getOpenAI(), buffer, filename);
  else if (type === 'pdf')  result = await ingestPdf(ROOT, buffer, filename);
  else                      result = await ingestFile(ROOT, buffer, filename, mimeType);
  return { type, ...result };
}

async function handleIngestApi(req, res) {
  // Auth
  const token = process.env.INGEST_TOKEN;
  if (token) {
    const auth = req.headers['authorization'] || req.headers['x-ingest-token'] || '';
    if (auth.replace(/^Bearer\s+/i, '') !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // File size guard
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_UPLOAD_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` }));
    return;
  }

  const contentType = req.headers['content-type'] || '';

  // ── multipart/form-data ───────────────────────────────────────────────────
  if (contentType.includes('multipart/form-data')) {
    const items = [];
    let parseError = null;

    await new Promise((resolve, reject) => {
      let bb;
      try {
        bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES } });
      } catch (e) { return reject(e); }

      const filePromises = [];

      bb.on('file', (fieldname, stream, info) => {
        const { filename, mimeType } = info;
        const chunks = [];
        stream.on('data', d => chunks.push(d));
        stream.on('limit', () => { stream.resume(); parseError = `File ${filename} exceeds size limit`; });
        stream.on('end', () => {
          if (parseError) return;
          const buffer = Buffer.concat(chunks);
          filePromises.push(
            processFileItem(buffer, filename, mimeType)
              .then(r => items.push(r))
              .catch(e => items.push({ type: 'error', message: e.message, filename }))
          );
        });
      });

      bb.on('field', (name, value) => {
        if (name === 'content' && value.trim()) {
          filePromises.push(
            processTextItem(value.trim())
              .then(r => items.push(r))
              .catch(e => items.push({ type: 'error', message: e.message }))
          );
        }
      });

      bb.on('finish', () => Promise.all(filePromises).then(resolve).catch(reject));
      bb.on('error', reject);
      req.pipe(bb);
    });

    if (parseError) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: parseError }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
    return;
  }

  // ── application/json ──────────────────────────────────────────────────────
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { content, type: explicitType } = parsed;
    if (!content) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'content is required' }));
      return;
    }

    try {
      let result;
      if (explicitType === 'url')        result = await ingestUrl(ROOT, content);
      else if (explicitType === 'note')  result = await ingestNote(ROOT, content, 'web');
      else if (explicitType === 'bookmark') result = await ingestBookmark(ROOT, content, 'web');
      else                               result = await processTextItem(content);

      const type = explicitType || result.type;
      const labels = { url: 'Article saved', note: 'Note saved', bookmark: 'Bookmark saved' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: `${labels[type] || 'Saved'} — pending compilation.`,
        type,
        items: [result],
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// ── Request handlers ──────────────────────────────────────────────────────────

function handleHome(articles) {
  if (articles.length === 0) {
    return layout(`<p class="empty">No wiki articles yet. Compile some content first.</p>`, [], '');
  }
  const rows = articles.map(a => `
    <div class="search-result">
      <h3><a href="/wiki/${a.slug}">${escHtml(a.title)}</a></h3>
      ${a.summary ? `<p>${escHtml(a.summary)}</p>` : ''}
      ${a.tags.length ? `<div class="tags" style="margin-top:6px">${a.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
    </div>`).join('');
  return layout(`<h1>All Articles</h1>${rows}`, articles, '', 'Second Brain');
}

/** Returns rendered article body without page chrome — used by handleArticle and /api/article/:slug */
function getArticleContent(slugName, articles, backlinks) {
  const content = readArticle(slugName);
  if (!content) return null;

  const { meta, body } = parseFrontmatter(content);
  const existingSlugSet = new Set(articles.map(a => a.slug.toLowerCase()));
  const bodyHtml = renderMarkdown(body, existingSlugSet);

  const tags = (meta.tags || []).map(t =>
    `<span class="tag">${escHtml(t)}</span>`
  ).join('');

  const meta_line = [meta.updated ? `Updated ${meta.updated}` : '', meta.created ? `Created ${meta.created}` : '']
    .filter(Boolean).join(' · ');

  const bl = backlinks[slugName.toLowerCase()] || [];
  const blHtml = bl.length ? `
    <div id="backlinks">
      <h4>Linked from</h4>
      <div class="backlink-list">
        ${bl.map(s => {
          const art = articles.find(a => a.slug === s);
          return `<span class="backlink-pill"><a href="/wiki/${s}">${escHtml(art?.title || s)}</a></span>`;
        }).join('')}
      </div>
    </div>` : '';

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : slugName;

  return {
    title,
    html: `
      ${meta_line ? `<div class="article-meta">${meta_line}</div>` : ''}
      ${tags ? `<div class="tags">${tags}</div>` : ''}
      ${bodyHtml}
      ${blHtml}
    `,
  };
}

function handleArticle(slugName, articles, backlinks) {
  const result = getArticleContent(slugName, articles, backlinks);
  if (!result) return null;
  return layout(result.html, articles, slugName, `${result.title} — Second Brain`);
}

function handleSearch(query, articles) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return null;
  const results = articles.filter(a => {
    const content = readArticle(a.slug) || '';
    return a.title.toLowerCase().includes(q) || content.toLowerCase().includes(q);
  });
  const rows = results.length
    ? results.map(a => `
        <div class="search-result">
          <h3><a href="/wiki/${a.slug}">${escHtml(a.title)}</a></h3>
          ${a.summary ? `<p>${escHtml(a.summary)}</p>` : ''}
        </div>`).join('')
    : `<p class="empty">No results for "${escHtml(q)}".</p>`;
  return layout(`<h1>Search: "${escHtml(q)}"</h1>${rows}`, articles, '', 'Search — Second Brain');
}

// ── Tasks page ────────────────────────────────────────────────────────────────

function handleTasksPage() {
  const tasks = readTasks(ROOT);
  const now   = new Date();

  // Group tasks
  const overdue  = tasks.filter(t => !t.done && t.due < now);
  const today    = tasks.filter(t => !t.done && t.due >= now && t.due.toDateString() === now.toDateString());
  const upcoming = tasks.filter(t => !t.done && t.due >= now && t.due.toDateString() !== now.toDateString());
  const done     = tasks.filter(t => t.done).slice(-5).reverse(); // last 5 completed

  function taskCard(t, badge) {
    const dueStr = t.due.toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="task-card" id="task-${encodeURIComponent(t.path)}">
      <div class="task-main">
        <span class="task-text">${escHtml(t.text)}</span>
        <span class="task-due ${badge}">${dueStr}</span>
      </div>
      ${!t.done ? `<button class="btn-done" data-path="${escHtml(t.path)}" onclick="markDone(this.dataset.path, this)">Hecho ✓</button>` : `<span class="task-done-label">✓</span>`}
    </div>`;
  }

  function section(emoji, label, badge, list) {
    if (!list.length) return '';
    return `<div class="task-section">
      <h2 class="section-title">${emoji} ${label} <span class="count">${list.length}</span></h2>
      ${list.map(t => taskCard(t, badge)).join('')}
    </div>`;
  }

  const totalPending = overdue.length + today.length + upcoming.length;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tasks — Second Brain</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f172a; color: #e2e8f0; min-height: 100vh;
           display: flex; justify-content: center; padding: 16px 16px 48px; }
    a { color: #60a5fa; }

    .container { width: 100%; max-width: 600px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; color: #f1f5f9; }
    .subtitle { color: #64748b; font-size: 13px; margin-bottom: 32px; }

    .task-section { margin-bottom: 28px; }
    .section-title { font-size: 14px; font-weight: 600; color: #94a3b8;
                     text-transform: uppercase; letter-spacing: .06em; margin-bottom: 12px;
                     display: flex; align-items: center; gap: 8px; }
    .count { background: #1e293b; border: 1px solid #334155; border-radius: 999px;
             font-size: 11px; padding: 1px 8px; color: #64748b; font-weight: 500; }

    .task-card { background: #1e293b; border: 1px solid #334155; border-radius: 10px;
                 padding: 14px 16px; margin-bottom: 8px;
                 display: flex; align-items: center; gap: 12px;
                 transition: opacity .3s; }
    .task-card.fading { opacity: 0; }
    .task-main { flex: 1; min-width: 0; }
    .task-text { display: block; font-size: 14px; color: #e2e8f0; margin-bottom: 4px;
                 white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .task-due { font-size: 12px; font-weight: 500; padding: 2px 8px; border-radius: 999px; }
    .task-due.overdue  { background: #450a0a; color: #fca5a5; }
    .task-due.today    { background: #422006; color: #fcd34d; }
    .task-due.upcoming { background: #172554; color: #93c5fd; }
    .task-due.done-badge { background: #052e16; color: #4ade80; }

    .btn-done { background: #0f172a; border: 1px solid #334155; color: #4ade80;
                border-radius: 7px; font-size: 12px; font-weight: 600; padding: 6px 12px;
                cursor: pointer; white-space: nowrap; transition: all .15s; flex-shrink: 0; }
    .btn-done:hover { background: #052e16; border-color: #4ade80; }
    .btn-done:disabled { opacity: .4; cursor: not-allowed; }
    .task-done-label { font-size: 14px; color: #4ade80; flex-shrink: 0; }

    .empty { color: #475569; font-size: 14px; padding: 20px 0; text-align: center; }

    #toast { position: fixed; bottom: 24px; right: 24px; background: #052e16; color: #4ade80;
             border: 1px solid #166534; border-radius: 8px; padding: 10px 16px; font-size: 13px;
             opacity: 0; transition: opacity .3s; pointer-events: none; z-index: 100; }
    #toast.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Tasks &amp; Reminders</h1>
    <p class="subtitle">${totalPending} pending${totalPending !== tasks.length ? ` · ${tasks.length} total` : ''}</p>

    ${overdue.length || today.length || upcoming.length
      ? section('🔴', 'Vencidos', 'overdue', overdue) +
        section('🟡', 'Hoy', 'today', today) +
        section('🔵', 'Próximos', 'upcoming', upcoming)
      : `<p class="empty">No hay tareas pendientes.</p>`}

    ${done.length ? section('✅', 'Completados recientemente', 'done-badge', done) : ''}
  </div>

  <div id="toast"></div>

  <script>
    async function markDone(path, btn) {
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const res = await fetch('/api/tasks/done', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        if (!res.ok) throw new Error('Error');
        const card = btn.closest('.task-card');
        card.classList.add('fading');
        setTimeout(() => card.remove(), 300);
        showToast('Tarea completada');
      } catch {
        btn.disabled = false;
        btn.textContent = 'Hecho ✓';
        showToast('Error al marcar como hecho', true);
      }
    }

    function showToast(msg, isError) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.background = isError ? '#450a0a' : '#052e16';
      t.style.color = isError ? '#fca5a5' : '#4ade80';
      t.style.borderColor = isError ? '#7f1d1d' : '#166534';
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }
  </script>
</body>
</html>`;
}

/** Inject a persistent top nav bar into standalone (dark) HTML pages */
// ── Pending page ──────────────────────────────────────────────────────────────

function handlePendingPage() {
  let state = { pending: [], lastCompile: null };
  try { state = JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8')); } catch {}

  const pending = state.pending || [];
  const lastCompile = state.lastCompile
    ? new Date(state.lastCompile).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'never';

  const typeIcons = { article: '📰', note: '📝', bookmark: '🔖', file: '📄', image: '🖼️', 'x-bookmarks': '𝕏', task: '✓' };
  const byType = {};
  for (const item of pending) {
    const t = item.type || 'other';
    if (!byType[t]) byType[t] = [];
    byType[t].push(item);
  }

  const groups = Object.entries(byType).map(([type, items]) => {
    const icon = typeIcons[type] || '📄';
    const rows = items.map(item => {
      const name = item.path.split('/').pop().replace(/\.md$/, '');
      let preview = '';
      try {
        const raw = readFileSync(join(ROOT, item.path), 'utf8');
        preview = raw
          .replace(/^---\n[\s\S]*?\n---\n/, '')  // strip frontmatter
          .replace(/^#+\s.*$/gm, '')              // strip headings
          .replace(/\n{2,}/g, '\n')               // collapse blank lines
          .trim()
          .slice(0, 600);
      } catch { preview = ''; }
      const hasPreview = preview.length > 0;
      return `<div class="pending-item${hasPreview ? ' has-preview' : ''}" ${hasPreview ? 'onclick="togglePreview(this)"' : ''}>
        <div class="pending-header">
          <span class="pending-icon">${icon}</span>
          <span class="pending-name">${escHtml(name)}</span>
          <span class="pending-path">${escHtml(item.path)}</span>
          ${hasPreview ? '<span class="pending-toggle">▶</span>' : ''}
        </div>
        ${hasPreview ? `<div class="pending-preview"><pre>${escHtml(preview)}${preview.length >= 600 ? '\n…' : ''}</pre></div>` : ''}
      </div>`;
    }).join('');
    return `<div class="pending-group">
      <h3>${icon} ${escHtml(type)} <span class="count">${items.length}</span></h3>
      ${rows}
    </div>`;
  }).join('');

  const emptyMsg = pending.length === 0
    ? `<div class="pending-empty">✓ Nothing pending — the wiki is up to date.</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pending — Second Brain</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#1e1e2e;color:#cdd6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:60px 32px 40px;max-width:800px;margin:0 auto}
  h1{font-size:1.4rem;font-weight:600;margin-bottom:4px;color:#cdd6f4}
  .meta{font-size:12px;color:#6c7086;margin-bottom:32px}
  .pending-group{margin-bottom:28px}
  .pending-group h3{font-size:13px;font-weight:600;color:#a6adc8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;display:flex;align-items:center;gap:8px}
  .count{background:#313244;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:500}
  .pending-item{padding:7px 12px;border-radius:6px;margin-bottom:4px;background:#181825}
  .pending-item.has-preview{cursor:pointer}
  .pending-item.has-preview:hover{background:#1e1e2e}
  .pending-header{display:flex;align-items:baseline;gap:10px}
  .pending-icon{font-size:14px;flex-shrink:0}
  .pending-name{font-size:13px;color:#cdd6f4;flex-shrink:0}
  .pending-path{font-size:11px;color:#45475a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .pending-toggle{font-size:10px;color:#45475a;margin-left:auto;flex-shrink:0;transition:transform .15s}
  .pending-item.open .pending-toggle{transform:rotate(90deg)}
  .pending-preview{display:none;padding:8px 0 2px 24px}
  .pending-item.open .pending-preview{display:block}
  .pending-preview pre{font-size:11px;color:#a6adc8;white-space:pre-wrap;word-break:break-word;line-height:1.5;font-family:ui-monospace,'SF Mono',monospace;max-height:200px;overflow-y:auto;background:#11111b;padding:8px 10px;border-radius:4px;border-left:2px solid #313244}
  .pending-empty{color:#6c7086;font-size:14px;padding:20px 0}
  .compile-bar{position:fixed;bottom:0;left:0;right:0;background:#181825;border-top:1px solid #313244;padding:14px 32px;display:flex;align-items:center;gap:16px}
  #compile-btn{background:#cba6f7;color:#1e1e2e;border:none;border-radius:6px;padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}
  #compile-btn:hover{opacity:.85}
  #compile-btn:disabled{opacity:.5;cursor:not-allowed}
  #compile-status{font-size:12px;color:#a6adc8}
</style>
</head>
<body>
<h1>Pending Items</h1>
<div class="meta">Last compiled: ${escHtml(lastCompile)} · ${pending.length} item${pending.length !== 1 ? 's' : ''} waiting</div>
${emptyMsg}
${groups}
<div class="compile-bar">
  <button id="compile-btn" ${pending.length === 0 ? 'disabled' : ''}>⚡ Compile now</button>
  <span id="compile-status">${pending.length === 0 ? 'Nothing to compile.' : `${pending.length} item${pending.length !== 1 ? 's' : ''} will be processed.`}</span>
</div>
<script>
  function togglePreview(el) {
    el.classList.toggle('open');
  }
  document.getElementById('compile-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('compile-btn');
    const status = document.getElementById('compile-status');
    btn.disabled = true;
    btn.textContent = '⏳ Starting...';
    status.textContent = 'Launching compilation...';
    try {
      const res = await fetch('/api/compile', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        btn.textContent = '✓ Compiling';
        status.textContent = 'Running in background — this may take a few minutes. Refresh when done.';
      } else {
        btn.disabled = false;
        btn.textContent = '⚡ Compile now';
        status.textContent = 'Error: ' + (data.error || 'unknown');
      }
    } catch(e) {
      btn.disabled = false;
      btn.textContent = '⚡ Compile now';
      status.textContent = 'Error: ' + e.message;
    }
  });
</script>
</body>
</html>`;
}

function injectTopNav(html, activePage) {
  const link = (href, label, page) => {
    const active = activePage === page;
    return `<a href="${href}" style="color:${active?'#cba6f7':'#6c7086'};text-decoration:none;` +
      `padding:0 12px;line-height:40px;font-weight:${active?'600':'400'};` +
      `${active?'border-bottom:2px solid #cba6f7;':''}">${label}</a>`;
  };

  const inject = `<style>body{padding-top:40px!important}` +
    `#wiki-topnav a:hover{color:#cdd6f4!important}</style>` +
    `<div id="wiki-topnav" style="position:fixed;top:0;left:0;right:0;z-index:9999;` +
    `background:#1e1e2e;border-bottom:1px solid #313244;` +
    `display:flex;align-items:center;padding:0 16px;height:40px;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;">` +
    `<a href="/" style="color:#cdd6f4;text-decoration:none;margin-right:12px;font-weight:700;">Second Brain</a>` +
    `<span style="color:#313244;margin-right:4px;">|</span>` +
    link('/', 'Articles', 'articles') +
    link('/graph', 'Graph', 'graph') +
    link('/timeline', 'Timeline', 'timeline') +
    link('/ingest', '+ Ingest', 'ingest') +
    link('/tasks', 'Tasks', 'tasks') +
    link('/pending', 'Pending', 'pending') +
    `</div>`;

  return html.replace(/<body\b[^>]*>/, m => m + inject);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url   = new URL(req.url, `http://localhost:${PORT}`);
  const path  = decodeURIComponent(url.pathname);

  const articles  = allArticles();
  const backlinks = buildBacklinks(articles);

  let html = null;
  let status = 200;

  if (path === '/' || path === '') {
    html = handleHome(articles);

  } else if (path.startsWith('/wiki/')) {
    const slugName = path.slice(6).replace(/\/$/, '');
    html = handleArticle(slugName, articles, backlinks);
    if (!html) {
      html = layout(`<p class="empty">Article <strong>${escHtml(slugName)}</strong> not found yet.</p>`, articles, '');
      status = 404;
    }

  } else if (path === '/timeline') {
    html = injectTopNav(buildTimelineHtml(ROOT), 'timeline');

  } else if (path === '/graph') {
    html = injectTopNav(buildGraphHtml(ROOT, { wikiBase: '/wiki' }), 'graph');

  } else if (path === '/search') {
    const q = url.searchParams.get('q');
    html = handleSearch(q, articles) || handleHome(articles);

  } else if (path === '/ingest' && req.method === 'GET') {
    html = handleIngestPage(process.env.INGEST_TOKEN || '');

  } else if (path === '/tasks' && req.method === 'GET') {
    html = injectTopNav(handleTasksPage(), 'tasks');

  } else if (path === '/pending' && req.method === 'GET') {
    html = injectTopNav(handlePendingPage(), 'pending');

  } else if (path === '/api/compile' && req.method === 'POST') {
    const compilePath = join(ROOT, 'bin', 'compile-lite.mjs');
    if (!existsSync(compilePath)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'compile-lite.mjs not found' }));
      return;
    }
    const child = spawn(process.execPath, [compilePath], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: child.pid }));
    return;

  } else if (path === '/api/tasks/done' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { path: taskPath } = JSON.parse(body);
        if (!taskPath || !taskPath.startsWith('raw/tasks/')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid task path' }));
          return;
        }
        markDone(ROOT, taskPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;

  } else if (path === '/api/ingest' && req.method === 'POST') {
    handleIngestApi(req, res);
    return;

  } else if (path === '/api/search' && req.method === 'GET') {
    const q = url.searchParams.get('q')?.trim() || '';
    if (!q || q.length < 3 || !process.env.OPENAI_API_KEY) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'query too short or OPENAI_API_KEY not set' }));
      return;
    }
    searchSemantic(ROOT, q, process.env.OPENAI_API_KEY, 8)
      .then(results => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;

  } else if (path.startsWith('/api/article/') && req.method === 'GET') {
    const slugName = path.slice(13).replace(/\/$/, '');
    const result = getArticleContent(slugName, articles, backlinks);
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(result ? 200 : 404);
    res.end(JSON.stringify(result ?? { error: 'not found' }));
    return;

  } else {
    html = layout(`<p class="empty">Page not found.</p>`, articles, '');
    status = 404;
  }

  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`\nSecond Brain wiki running at http://localhost:${PORT}\n`);
  console.log(`  ${allArticles().length} articles available`);
  console.log(`  Ctrl+C to stop\n`);
});
