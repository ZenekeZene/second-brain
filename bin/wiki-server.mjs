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
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, unlinkSync } from 'fs';
import { spawn, execFileSync as execFileSyncDetect } from 'child_process';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import busboy from 'busboy';
import OpenAI from 'openai';
import { buildTimelineHtml } from './lib/timeline.mjs';
import { buildGraphHtml } from './lib/graph.mjs';
import { loadXBookmarks, buildXPageHtml } from './lib/xbookmarks.mjs';
import {
  ingestUrl, ingestNote, ingestBookmark, ingestFile,
  ingestImage, ingestVoice, ingestPdf, detectType, transcribeAudio,
  ingestIdea, toSlug, today, readPending, addToPending, writePending,
} from './lib/ingest-helpers.mjs';
import {
  getTodayWithCarryover, saveTodayData, postponeTask,
  getUpcoming, pullToToday, markTaskDone, saveTask, formatDue, removeTaskById
} from './lib/task-helpers.mjs';
import { searchSemantic } from './lib/embeddings.mjs';
import { buildXIndex, searchXSemantic, xIndexExists } from './lib/x-embeddings.mjs';
import { ICONS } from './lib/icons.mjs';
import { readConfig, writeConfig } from './lib/config.mjs';

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

// Detect if Claude Code CLI is available on this machine (cached at startup)
let claudeAvailable = false;
try { execFileSyncDetect('which', ['claude'], { stdio: 'pipe' }); claudeAvailable = true; } catch {}

// ── Compile streaming state ──────────────────────────────────────────────────
const compileState = { running: false, pid: null, mode: null, startedAt: null, recentLines: [] };
const MAX_RECENT_LINES = 100;
const sseClients = new Set();

// ── Scheduled compile ─────────────────────────────────────────────────────────
const SCHEDULE_PATH = join(ROOT, '.state', 'scheduled-compile.json');
let scheduleTimer = null;

function loadSchedule() {
  try { return JSON.parse(readFileSync(SCHEDULE_PATH, 'utf8')); } catch { return null; }
}

function saveSchedule(scheduledAt) {
  writeFileSync(SCHEDULE_PATH, JSON.stringify({ scheduledAt }));
}

function clearSchedule() {
  try { unlinkSync(SCHEDULE_PATH); } catch {}
  if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
  compileState.scheduledAt = null;
}

function armSchedule(scheduledAt) {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  compileState.scheduledAt = scheduledAt;
  const delay = new Date(scheduledAt).getTime() - Date.now();
  if (delay <= 0) { triggerScheduledCompile(); return; }
  scheduleTimer = setTimeout(triggerScheduledCompile, delay);
}

async function triggerScheduledCompile() {
  clearSchedule();
  if (compileState.running) return; // already running, skip
  try {
    await fetch(`http://localhost:${PORT}/api/compile`, { method: 'POST' });
  } catch {}
}

// Compute next occurrence of HH:MM — today if still in the future, else tomorrow
function nextOccurrence(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(hh, mm, 0, 0);
  if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
  return candidate.toISOString();
}

function sseBroadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(msg); } catch { sseClients.delete(c); }
  }
}

function snapshotWikiSizes() {
  const snap = {};
  const wikiDir = join(ROOT, 'wiki');
  if (existsSync(wikiDir)) {
    for (const f of readdirSync(wikiDir).filter(f => f.endsWith('.md'))) {
      try { snap['wiki/' + f] = statSync(join(wikiDir, f)).size; } catch {}
    }
  }
  return snap;
}

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

// X bookmarks cache — loaded once at startup
let _xBookmarks = null;
function getXBookmarks() {
  if (!_xBookmarks) _xBookmarks = loadXBookmarks(ROOT);
  return _xBookmarks;
}

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

// ── INDEX.md category parser ──────────────────────────────────────────────────

function parseIndexCategories() {
  const indexPath = join(ROOT, 'INDEX.md');
  if (!existsSync(indexPath)) return {};
  const content = readFileSync(indexPath, 'utf8');
  const map = {};
  let currentCat = null;
  for (const line of content.split('\n')) {
    const catMatch = line.match(/^###\s+(.+)$/);
    if (catMatch) { currentCat = catMatch[1].trim(); continue; }
    const linkMatch = line.match(/\[\[([^\]|]+)\]\]/);
    if (linkMatch && currentCat) {
      map[linkMatch[1].trim().toLowerCase()] = currentCat;
    }
  }
  return map;
}

// ── HTML templates ────────────────────────────────────────────────────────────

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">`;

function navLink(href, iconKey, label, activeSlug, activeKey, extraClass = '') {
  const active = activeSlug === activeKey ? ' active' : '';
  const cls = [active, extraClass].filter(Boolean).join(' ');
  return `<a href="${href}" class="${cls}"><span class="nav-icon">${ICONS[iconKey]}</span><span class="nav-label">${label}</span></a>`;
}

function topNav(activePage) {
  const link = (href, label, key) =>
    `<a href="${href}" class="${activePage === key ? 'active' : ''}">${label}</a>`;
  return `<nav class="top-nav">
    <a href="/" class="top-nav-brand">Second Brain</a>
    <span class="top-nav-sep">|</span>
    ${link('/', 'Library', 'articles')}
    ${link('/graph', 'Graph', 'graph')}
    ${link('/timeline', 'Feed', 'timeline')}
    ${link('/x', 'X Bookmarks', 'x')}
    ${link('/inbox', 'Inbox', 'inbox')}
    ${link('/tasks', 'Tasks', 'tasks')}
  </nav>`;
}

function layout(content, articles, activeSlug = '', title = 'Second Brain', { contentClass = '' } = {}) {
  // Categorized sidebar list
  const catMap = parseIndexCategories();
  const grouped = {};
  const catOrder = [];
  for (const a of articles) {
    const cat = catMap[a.slug.toLowerCase()] || 'Other';
    if (!grouped[cat]) { grouped[cat] = []; catOrder.push(cat); }
    grouped[cat].push(a);
  }
  // Ensure "Other" is last
  if (catOrder.includes('Other') && catOrder[catOrder.length - 1] !== 'Other') {
    catOrder.splice(catOrder.indexOf('Other'), 1); catOrder.push('Other');
  }
  const categorizedList = catOrder.length > 0
    ? catOrder.map(cat => {
        const items = grouped[cat].map(a => `
          <a href="/wiki/${a.slug}" class="article-item${a.slug === activeSlug ? ' active' : ''}">
            ${escHtml(a.title)}
            ${a.updated ? `<span class="item-date">${a.updated}</span>` : ''}
          </a>`).join('');
        return `<div class="sidebar-category-group" data-cat="${escHtml(cat)}">
          <div class="sidebar-cat-header" onclick="toggleCat(this)">
            <span class="sidebar-cat-name">${escHtml(cat)}</span>
            <span class="sidebar-cat-count">${grouped[cat].length}</span>
            <svg class="sidebar-cat-toggle" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="sidebar-cat-items">${items}</div>
        </div>`;
      }).join('')
    : articles.map(a => `
        <a href="/wiki/${a.slug}" class="article-item${a.slug === activeSlug ? ' active' : ''}">
          ${escHtml(a.title)}
          ${a.updated ? `<span class="item-date">${a.updated}</span>` : ''}
        </a>`).join('');

  // Status bar
  let pendingCount = 0, lastCompile = null;
  try {
    const ps = JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8'));
    pendingCount = (ps.pending || []).length;
    lastCompile = ps.lastCompile;
  } catch {}
  const dotClass = pendingCount > 0 ? 'pending' : (lastCompile ? 'fresh' : '');
  const statusText = pendingCount > 0
    ? `${pendingCount} pending`
    : (lastCompile
        ? `Compiled ${new Date(lastCompile).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}`
        : 'Never compiled');

  const qcToken = process.env.INGEST_TOKEN || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  ${FONTS}
  <link rel="stylesheet" href="/static/style.css">
</head>
<body class="app-shell">
  <nav id="sidebar">
    <div class="sidebar-brand">
      <div class="brand-mark">${ICONS.brand}</div>
      <div class="brand-text">
        <div class="brand-name">Second Brain</div>
        <div class="brand-count">${articles.length} article${articles.length !== 1 ? 's' : ''}</div>
      </div>
      <button class="nav-collapse-btn" id="nav-collapse-btn" title="Toggle sidebar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
    </div>
    <nav id="sidebar-nav">
      ${navLink('/', 'articles', 'Library', activeSlug, '')}
      ${navLink('/graph', 'graph', 'Graph', activeSlug, '__graph')}
      ${navLink('/x', 'xbookmark', 'X Bookmarks', activeSlug, '__x')}
      <div class="nav-divider"></div>
      ${navLink('/inbox', 'ingest', 'Inbox', activeSlug, '__inbox')}
      ${navLink('/tasks', 'tasks', 'Tasks', activeSlug, '__tasks')}
      ${navLink('/config', 'settings', 'Settings', activeSlug, '__config')}
    </nav>
    <div id="search-wrap">
      <input id="search" type="search" placeholder="Search articles..." autocomplete="off"
             value="" oninput="filterList(this.value)">
    </div>
    <div id="sidebar-scroll">
      <div id="article-list">${categorizedList}</div>
    </div>
    <a href="/inbox" id="sidebar-status">
      <div class="status-row">
        <span class="status-dot ${dotClass}" id="status-dot"></span>
        <span id="status-text">${escHtml(statusText)}</span>
      </div>
    </a>
    <div id="sidebar-footer-links">
      <a href="/timeline" class="${activeSlug === '__timeline' ? 'active' : ''}">Feed</a>
      <a href="/config" class="${activeSlug === '__config' ? 'active' : ''}">Settings</a>
    </div>
  </nav>
  <div id="nav-resize-handle"></div>
  <main id="content"${contentClass ? ` class="${contentClass}"` : ''}>${content}</main>

  <!-- Quick Capture Modal (Cmd+K) -->
  <div id="qc-overlay" role="dialog" aria-modal="true">
    <div id="qc-box">
      <div id="qc-header">
        <span id="qc-title">Quick Capture</span>
        <span id="qc-type-badge" class="type-badge" style="display:none"></span>
      </div>
      <textarea id="qc-ta" rows="4" placeholder="Paste a URL, write a note, or describe a task…" autocomplete="off" spellcheck="true"></textarea>
      <div id="qc-footer">
        <span id="qc-hint">⌘K · ⌘↵ to save · Esc to close</span>
        <button id="qc-submit">Save</button>
      </div>
      <div id="qc-feedback"></div>
    </div>
  </div>

  <!-- Mobile bottom nav -->
  <nav id="mobile-nav">
    <a href="/" class="mob-link${activeSlug === '' ? ' active' : ''}">
      <span class="mob-icon">${ICONS.articles}</span>
      <span class="mob-label">Library</span>
    </a>
    <a href="/graph" class="mob-link${activeSlug === '__graph' ? ' active' : ''}">
      <span class="mob-icon">${ICONS.graph}</span>
      <span class="mob-label">Graph</span>
    </a>
    <a href="/inbox" class="mob-link${activeSlug === '__inbox' ? ' active' : ''}">
      <span class="mob-icon">${ICONS.ingest}</span>
      <span class="mob-label">Inbox</span>
    </a>
    <a href="/tasks" class="mob-link${activeSlug === '__tasks' ? ' active' : ''}">
      <span class="mob-icon">${ICONS.tasks}</span>
      <span class="mob-label">Tasks</span>
    </a>
  </nav>

  <script>
    // ── Quick Capture (Cmd+K) ─────────────────────────────────────────────────
    (function() {
      const QC_TOKEN = ${JSON.stringify(qcToken)};
      const URL_RE = /^https?:\\/\\/\\S+$/;
      function qcGuessType(text) { return URL_RE.test(text.trim()) ? 'article' : 'note'; }
      function authHdrs(extra) { const h={...extra}; if(QC_TOKEN) h['Authorization']='Bearer '+QC_TOKEN; return h; }

      const overlay = document.getElementById('qc-overlay');
      const ta = document.getElementById('qc-ta');
      const submit = document.getElementById('qc-submit');
      const badge = document.getElementById('qc-type-badge');
      const feedback = document.getElementById('qc-feedback');

      function openQC() { overlay.classList.add('open'); ta.focus(); feedback.style.display='none'; }
      function closeQC() { overlay.classList.remove('open'); ta.value=''; badge.style.display='none'; submit.disabled=false; }

      document.addEventListener('keydown', e => {
        if ((e.metaKey||e.ctrlKey) && e.key==='k') { e.preventDefault(); openQC(); }
        if (e.key==='Escape' && overlay.classList.contains('open')) closeQC();
      });
      overlay.addEventListener('click', e => { if(e.target===overlay) closeQC(); });

      ta.addEventListener('input', () => {
        const v = ta.value;
        if (!v.trim()) { badge.style.display='none'; return; }
        const t = qcGuessType(v);
        badge.textContent=t; badge.className='type-badge '+t; badge.style.display='';
      });
      ta.addEventListener('keydown', e => {
        if ((e.metaKey||e.ctrlKey) && e.key==='Enter') { e.preventDefault(); doSave(); }
      });
      submit.addEventListener('click', doSave);

      async function doSave() {
        const text = ta.value.trim();
        if (!text) return;
        submit.disabled = true;
        try {
          const res = await fetch('/api/ingest', { method:'POST', headers:authHdrs({'Content-Type':'application/json'}), body:JSON.stringify({content:text}) });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error||'Error');
          // Update status bar
          try {
            const st = await fetch('/api/status').then(r=>r.json());
            const dot=document.getElementById('status-dot'), stxt=document.getElementById('status-text');
            if (dot&&stxt) { stxt.textContent=st.pending>0?st.pending+' pending':'Up to date'; dot.className='status-dot'+(st.pending>0?' pending':' fresh'); }
          } catch {}
          feedback.textContent = data.message||'Saved';
          feedback.style.display='block'; feedback.style.color='var(--green)';
          ta.value=''; badge.style.display='none';
          setTimeout(closeQC, 1500);
        } catch(e) {
          feedback.textContent=e.message||'Error';
          feedback.style.display='block'; feedback.style.color='var(--red)';
          submit.disabled=false;
        }
      }
    })();

    // ── Search & filter ───────────────────────────────────────────────────────
    let _searchTimer = null;
    let _semanticActive = false;

    function filterList(q) {
      q = q.toLowerCase();
      document.querySelectorAll('.article-item').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
      // Show/hide category groups
      document.querySelectorAll('.sidebar-category-group').forEach(grp => {
        const hasVisible = [...grp.querySelectorAll('.article-item')].some(el => el.style.display !== 'none');
        grp.style.display = q ? (hasVisible ? '' : 'none') : '';
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

    // ── Sidebar categories ────────────────────────────────────────────────────
    function toggleCat(header) {
      const grp = header.closest('.sidebar-category-group');
      const key = 'cat:' + grp.dataset.cat;
      const collapsed = grp.classList.toggle('collapsed');
      try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch {}
    }
    document.querySelectorAll('.sidebar-category-group').forEach(grp => {
      try { if (localStorage.getItem('cat:' + grp.dataset.cat) === '1') grp.classList.add('collapsed'); } catch {}
    });

    // ── Sidebar resize + collapse ─────────────────────────────────────────────
    (function() {
      const STORAGE_KEY = 'sb:navWidth';
      const MIN = 44, MAX = 360, DEFAULT = 224;
      const sidebar  = document.getElementById('sidebar');
      const handle   = document.getElementById('nav-resize-handle');
      const colBtn   = document.getElementById('nav-collapse-btn');

      function setWidth(w, animate) {
        if (animate) sidebar.classList.add('nav-animating');
        document.documentElement.style.setProperty('--sidebar-w', w + 'px');
        sidebar.style.width = w + 'px';
        sidebar.style.minWidth = w + 'px';
        sidebar.classList.toggle('nav-icon-only', w <= 56);
        try { localStorage.setItem(STORAGE_KEY, w); } catch {}
        if (animate) setTimeout(() => sidebar.classList.remove('nav-animating'), 250);
      }

      // Restore saved width on load
      try {
        const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
        if (saved >= MIN && saved <= MAX) setWidth(saved, false);
      } catch {}

      // Drag to resize
      handle.addEventListener('mousedown', e => {
        const startX = e.clientX;
        const startW = sidebar.offsetWidth;
        handle.classList.add('dragging');
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        function onMove(ev) {
          setWidth(Math.min(MAX, Math.max(MIN, startW + (ev.clientX - startX))), false);
        }
        function onUp() {
          handle.classList.remove('dragging');
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          window.dispatchEvent(new Event('resize')); // reflow graph if present
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      });

      // Collapse/expand toggle (chevron button)
      colBtn.addEventListener('click', e => {
        e.stopPropagation(); // prevent bubble to sidebar-brand expand handler
        const w = sidebar.offsetWidth;
        setWidth(w > 56 ? MIN : DEFAULT, true);
        setTimeout(() => window.dispatchEvent(new Event('resize')), 260); // after animation
      });

      // Click brand area to expand when icon-only
      document.querySelector('.sidebar-brand').addEventListener('click', () => {
        if (sidebar.classList.contains('nav-icon-only')) {
          setWidth(DEFAULT, true);
          setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
        }
      });
    })();
  </script>
</body>
</html>`;
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Ingest API ────────────────────────────────────────────────────────────────

function handleIngestPage(token, articles) {
  const tokenScript = token ? `const INGEST_TOKEN = ${JSON.stringify(token)};` : `const INGEST_TOKEN = '';`;
  const content = `
    <h1 class="page-title">Add to Brain</h1>
    <p class="page-subtitle">Drop, paste, or type anything — URLs, notes, images, PDFs, audio.</p>
  <div class="card">
    <div class="drop-zone" id="drop-zone">
      <textarea id="ingest-input" rows="10" placeholder="Paste a URL, type a note, or drop files here…"
                autocomplete="off" spellcheck="true"></textarea>
      <div class="drop-hint">
        <span>Drop files anywhere on this card · Cmd+Enter to save</span>
        <span id="type-preview" class="type-badge" style="display:none"></span>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" id="save-btn" onclick="submitText()">Add to Brain</button>
      <label class="btn-file" for="file-input">Browse files</label>
      <input type="file" id="file-input" multiple accept="*/*">
    </div>

    <div id="queue"></div>
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
    const TYPE_ICONS = { article: \`${ICONS.article}\`, note: \`${ICONS.note}\`, image: \`${ICONS.image}\`, voice: \`${ICONS.file}\`, pdf: \`${ICONS.file}\`, file: \`${ICONS.file}\` };

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
        const icon = TYPE_ICONS[item.type] || \`${ICONS.file}\`;
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
      const ta = document.getElementById('ingest-input');
      const text = ta.value.trim();
      if (!text) return;
      enqueueText(text);
      ta.value = '';
      updateTypePreview('');
    }

    // Textarea: live type preview + Cmd/Ctrl+Enter shortcut
    const ta = document.getElementById('ingest-input');
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
  `;
  return layout(content, articles, '__ingest', 'Ingest — Second Brain');
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
      else if (explicitType === 'idea')  result = await ingestIdea(ROOT, content);
      else                               result = await processTextItem(content);

      const type = explicitType || result.type;
      const labels = { url: 'Article saved', note: 'Note saved', bookmark: 'Bookmark saved', idea: 'Idea saved (incubating)' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: type === 'idea' ? 'Idea guardada en incubación.' : `${labels[type] || 'Saved'} — pending compilation.`,
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

function handleHome(articles, backlinks = {}) {
  if (articles.length === 0) {
    return layout(`<p class="empty">No wiki articles yet. Compile some content first.</p>`, [], '');
  }

  // Tag frequency
  const tagFreq = {};
  for (const a of articles) for (const t of a.tags) tagFreq[t] = (tagFreq[t] || 0) + 1;
  const allTags = Object.entries(tagFreq).sort((a,b) => b[1]-a[1]).map(([t]) => t);

  // Category grouping
  const catMap = parseIndexCategories();
  const grouped = {}, catOrder = [];
  for (const a of articles) {
    const cat = catMap[a.slug.toLowerCase()] || 'Other';
    if (!grouped[cat]) { grouped[cat] = []; catOrder.push(cat); }
    grouped[cat].push(a);
  }
  if (catOrder.includes('Other') && catOrder[catOrder.length-1] !== 'Other') {
    catOrder.splice(catOrder.indexOf('Other'),1); catOrder.push('Other');
  }

  // Relative date helper
  function relDate(dateStr) {
    if (!dateStr) return '';
    const diff = Math.floor((Date.now() - new Date(dateStr + 'T00:00:00')) / 86400000);
    if (diff <= 0) return 'hoy';
    if (diff === 1) return 'ayer';
    if (diff < 7) return diff + 'd';
    if (diff < 30) return Math.floor(diff / 7) + 's';
    return Math.floor(diff / 30) + 'm';
  }

  // Most linked (by incoming backlink count)
  const mostLinked = articles
    .map(a => ({ ...a, inCount: (backlinks[a.slug] || []).length }))
    .filter(a => a.inCount > 0)
    .sort((a, b) => b.inCount - a.inCount)
    .slice(0, 5);

  // Recently updated
  const recentlyUpdated = articles
    .filter(a => a.updated)
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, 5);

  // Category slug helper for anchors
  function catId(cat) {
    return 'cat-' + cat.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  const tagFilterBar = allTags.length ? `
    <div class="tag-filter-bar">
      <button class="tag-filter active" onclick="filterByTag(this,'')">All</button>
      ${allTags.slice(0,24).map(t => `<button class="tag-filter" onclick="filterByTag(this,'${escHtml(t)}')">${escHtml(t)}</button>`).join('')}
    </div>` : '';

  const categoryHtml = catOrder.map(cat => {
    const id = catId(cat);
    const items = grouped[cat].map(a => `
      <div class="search-result" data-tags="${escHtml(a.tags.join(' '))}">
        <h3><a href="/wiki/${a.slug}">${escHtml(a.title)}</a></h3>
        ${a.summary ? `<p>${escHtml(a.summary)}</p>` : ''}
        ${a.tags.length ? `<div class="tags" style="margin-top:6px">${a.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
      </div>`).join('');
    return `<div class="home-category" id="${id}" data-cat="${escHtml(cat)}">
      <h2 class="home-category-title">${escHtml(cat)}</h2>
      ${items}
    </div>`;
  }).join('');

  const asideHtml = `
    <aside class="home-aside">
      ${mostLinked.length ? `
      <div class="home-aside-section">
        <div class="home-aside-title">Más enlazados</div>
        ${mostLinked.map(a => `
          <a href="/wiki/${a.slug}" class="home-aside-link">
            <span class="home-aside-label">${escHtml(a.title)}</span>
            <span class="home-aside-num">${a.inCount}</span>
          </a>`).join('')}
      </div>` : ''}
      ${recentlyUpdated.length ? `
      <div class="home-aside-section">
        <div class="home-aside-title">Recientes</div>
        ${recentlyUpdated.map(a => `
          <a href="/wiki/${a.slug}" class="home-aside-link">
            <span class="home-aside-label">${escHtml(a.title)}</span>
            <span class="home-aside-num">${relDate(a.updated)}</span>
          </a>`).join('')}
      </div>` : ''}
      <div class="home-aside-section">
        <div class="home-aside-title">Categorías</div>
        ${catOrder.map(cat => `
          <a href="#${catId(cat)}" class="home-aside-link home-cat-anchor" data-cat="${catId(cat)}">
            <span class="home-aside-label">${escHtml(cat)}</span>
            <span class="home-aside-num">${grouped[cat].length}</span>
          </a>`).join('')}
      </div>
    </aside>`;

  const content = `
    <h1>Library</h1>
    ${tagFilterBar}
    <div class="home-layout">
      <div class="home-main" id="library-articles">${categoryHtml}</div>
      ${asideHtml}
    </div>
    <script>
      function filterByTag(btn, tag) {
        document.querySelectorAll('.tag-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.search-result').forEach(el => {
          if (!tag) { el.style.display=''; return; }
          el.style.display = (el.dataset.tags||'').split(' ').includes(tag) ? '' : 'none';
        });
        document.querySelectorAll('.home-category').forEach(grp => {
          grp.style.display = [...grp.querySelectorAll('.search-result')].some(el=>el.style.display!=='none') ? '' : 'none';
        });
      }
      // Smooth scroll for category anchors
      document.querySelectorAll('.home-cat-anchor').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const el = document.getElementById(a.dataset.cat);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
      // Scrollspy
      const _spy = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          const link = document.querySelector('.home-cat-anchor[data-cat="' + entry.target.id + '"]');
          if (link) link.classList.toggle('active', entry.isIntersecting);
        });
      }, { rootMargin: '-10% 0px -60% 0px', threshold: 0 });
      document.querySelectorAll('.home-category[id]').forEach(el => _spy.observe(el));
    </script>`;
  return layout(content, articles, '', 'Second Brain', { contentClass: 'content-home' });
}

/** Returns rendered article body without page chrome — used by handleArticle and /api/article/:slug */
function getArticleContent(slugName, articles, backlinks) {
  const content = readArticle(slugName);
  if (!content) return null;

  const { meta, body } = parseFrontmatter(content);
  const existingSlugSet = new Set(articles.map(a => a.slug.toLowerCase()));
  const rawBodyHtml = renderMarkdown(body, existingSlugSet);

  // ── TOC generation ──────────────────────────────────────────────────────────
  const tocHeadings = [];
  const bodyHtml = rawBodyHtml.replace(/<h([23])([^>]*)>(.*?)<\/h\1>/gi, (_, level, attrs, text) => {
    const plain = text.replace(/<[^>]+>/g, '').trim();
    if (!plain) return _;
    const id = plain.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    tocHeadings.push({ level: parseInt(level), text: plain, id });
    return `<h${level}${attrs} id="${id}">${text}</h${level}>`;
  });
  const h2Count = tocHeadings.filter(h => h.level === 2).length;
  const tocHtml = h2Count >= 3 ? `
    <nav class="article-toc">
      <div class="toc-title">Contents</div>
      ${tocHeadings.map(h =>
        `<a href="#${h.id}" class="${h.level === 3 ? 'toc-h3' : ''}">${escHtml(h.text)}</a>`
      ).join('')}
    </nav>` : '';

  const tags = (meta.tags || []).map(t => `<span class="tag">${escHtml(t)}</span>`).join('');
  const meta_line = [meta.updated ? `Updated ${meta.updated}` : '', meta.created ? `Created ${meta.created}` : '']
    .filter(Boolean).join(' · ');

  // ── Backlinks (top) ─────────────────────────────────────────────────────────
  const bl = backlinks[slugName.toLowerCase()] || [];
  const blTopHtml = bl.length ? `
    <div class="backlinks-top">
      <span class="bl-label">Linked from</span>
      ${bl.map(s => {
        const art = articles.find(a => a.slug === s);
        return `<a href="/wiki/${s}" class="bl-chip">${escHtml(art?.title || s)}</a>`;
      }).join('')}
    </div>` : '';

  // ── Related articles (from ## Connections section) ──────────────────────────
  const connMatch = body.match(/^##\s+Connections\s*\n([\s\S]*?)(?=^##\s|\s*$)/m);
  const relatedHtml = (() => {
    if (!connMatch) return '';
    const links = [];
    const re = /\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]([^\n\[]*)/g;
    let m;
    while ((m = re.exec(connMatch[1])) !== null) {
      const s = m[1].trim().toLowerCase().replace(/\s+/g, '-');
      const art = articles.find(a => a.slug === s);
      if (art) {
        const reason = m[2].replace(/^[^a-zA-Z\u00c0-\u024f]+/, '').trim().slice(0, 80);
        links.push({ slug: s, title: art.title, reason });
      }
    }
    if (!links.length) return '';
    return `<div class="related-articles">
      <h4>Related</h4>
      <div class="related-grid">
        ${links.slice(0, 6).map(l => `
          <a href="/wiki/${l.slug}" class="related-card">
            <span class="related-card-title">${escHtml(l.title)}</span>
            ${l.reason ? `<span class="related-card-reason">${escHtml(l.reason)}</span>` : ''}
          </a>`).join('')}
      </div>
    </div>`;
  })();

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : slugName;

  // Scroll-spy script for TOC (only when TOC is present)
  const tocScript = h2Count >= 3 ? `
    <script>
      (function() {
        const links = document.querySelectorAll('.article-toc a');
        if (!links.length) return;
        const root = document.getElementById('content');
        const headings = [...links].map(l => {
          const id = l.getAttribute('href').slice(1);
          return { el: document.getElementById(id), link: l };
        }).filter(h => h.el);
        const obs = new IntersectionObserver(entries => {
          for (const e of entries) {
            if (e.isIntersecting) {
              links.forEach(l => l.classList.remove('active'));
              const h = headings.find(h => h.el === e.target);
              if (h) h.link.classList.add('active');
            }
          }
        }, { root, rootMargin: '-10% 0% -65% 0%', threshold: 0 });
        headings.forEach(h => obs.observe(h.el));
      })();
    </script>` : '';

  return {
    title,
    html: `
      ${meta_line ? `<div class="article-meta">${meta_line}</div>` : ''}
      ${tags ? `<div class="tags">${tags}</div>` : ''}
      ${blTopHtml}
      ${tocHtml}
      ${bodyHtml}
      ${relatedHtml}
      ${tocScript}
    `,
  };
}

function handleArticle(slugName, articles, backlinks) {
  const content = readArticle(slugName);
  if (!content) return null;

  const { meta, body } = parseFrontmatter(content);
  const existingSlugSet = new Set(articles.map(a => a.slug.toLowerCase()));
  const rawBodyHtml = renderMarkdown(body, existingSlugSet);

  // Inject heading IDs + collect TOC entries
  const tocHeadings = [];
  const bodyHtml = rawBodyHtml.replace(/<h([23])([^>]*)>(.*?)<\/h\1>/gi, (_, level, attrs, text) => {
    const plain = text.replace(/<[^>]+>/g, '').trim();
    if (!plain) return _;
    const id = plain.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    tocHeadings.push({ level: parseInt(level), text: plain, id });
    return `<h${level}${attrs} id="${id}">${text}</h${level}>`;
  });

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : slugName;
  const meta_line = [meta.updated ? `Updated ${meta.updated}` : '', meta.created ? `Created ${meta.created}` : '']
    .filter(Boolean).join(' · ');

  // ── Aside: Tags ─────────────────────────────────────────────────────────────
  const tags = (meta.tags || []).map(t => `<span class="tag">${escHtml(t)}</span>`).join('');
  const asideTags = tags ? `
    <div class="aside-section">
      <div class="aside-label">Tags</div>
      <div class="tags">${tags}</div>
    </div>` : '';

  // ── Aside: TOC ───────────────────────────────────────────────────────────────
  const asideToc = tocHeadings.length >= 2 ? `
    <div class="aside-section">
      <div class="aside-label">Contents</div>
      <nav class="aside-toc">
        ${tocHeadings.map(h =>
          `<a href="#${h.id}" class="${h.level === 3 ? 'toc-h3' : ''}">${escHtml(h.text)}</a>`
        ).join('')}
      </nav>
    </div>` : '';

  // ── Aside: Linked from (backlinks) ─────────────────────────────────────────
  const bl = backlinks[slugName.toLowerCase()] || [];
  const asideBacklinks = bl.length ? `
    <div class="aside-section">
      <div class="aside-label">Linked from</div>
      <div class="aside-links">
        ${bl.map(s => {
          const art = articles.find(a => a.slug === s);
          return `<a href="/wiki/${s}" class="aside-link">${escHtml(art?.title || s)}</a>`;
        }).join('')}
      </div>
    </div>` : '';

  // ── Aside: Connections (from ## Connections section) ────────────────────────
  const connMatch = body.match(/^##\s+Connections\s*\n([\s\S]*?)(?=^##\s|\s*$)/m);
  let asideConnections = '';
  if (connMatch) {
    const links = [];
    const re = /\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]/g;
    let m;
    while ((m = re.exec(connMatch[1])) !== null) {
      const s = m[1].trim().toLowerCase().replace(/\s+/g, '-');
      const art = articles.find(a => a.slug === s);
      if (art && !links.find(l => l.slug === s)) links.push({ slug: s, title: art.title });
    }
    if (links.length) {
      asideConnections = `
        <div class="aside-section">
          <div class="aside-label">See also</div>
          <div class="aside-links">
            ${links.slice(0, 8).map(l =>
              `<a href="/wiki/${l.slug}" class="aside-link">${escHtml(l.title)}</a>`
            ).join('')}
          </div>
        </div>`;
    }
  }

  const hasAside = asideTags || asideToc || asideBacklinks || asideConnections;
  const aside = hasAside ? `
    <aside class="article-aside">
      ${asideTags}${asideToc}${asideBacklinks}${asideConnections}
    </aside>` : '';

  const tocScript = tocHeadings.length >= 2 ? `
    <script>
      (function() {
        const links = document.querySelectorAll('.aside-toc a');
        if (!links.length) return;
        const root = document.getElementById('content');
        const headings = [...links].map(l => {
          const id = l.getAttribute('href').slice(1);
          return { el: document.getElementById(id), link: l };
        }).filter(h => h.el);
        if (!headings.length) return;
        const obs = new IntersectionObserver(entries => {
          for (const e of entries) {
            if (e.isIntersecting) {
              links.forEach(l => l.classList.remove('active'));
              const h = headings.find(h => h.el === e.target);
              if (h) h.link.classList.add('active');
            }
          }
        }, { root, rootMargin: '-10% 0% -65% 0%', threshold: 0 });
        headings.forEach(h => obs.observe(h.el));
      })();
    </script>` : '';

  const html = `<div class="article-layout">
    <div class="article-body">
      ${meta_line ? `<div class="article-meta">${meta_line}</div>` : ''}
      ${bodyHtml}
      ${tocScript}
    </div>
    ${aside}
  </div>`;

  return layout(html, articles, slugName, `${title} — Second Brain`, { contentClass: 'content-article' });
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

// ── Inbox page (Ingest + Pending unified) ────────────────────────────────────

function handleInboxPage(token, articles) {
  let state = { pending: [], lastCompile: null };
  try { state = JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8')); } catch {}
  const pending = state.pending || [];
  const lastCompile = state.lastCompile
    ? new Date(state.lastCompile).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;

  const typeIcons = {
    article: ICONS.article, note: ICONS.note, bookmark: ICONS.bookmark,
    file: ICONS.file, image: ICONS.image, 'x-bookmarks': ICONS.xbookmark, task: ICONS.tasks,
  };
  const byType = {};
  for (const item of pending) {
    const t = item.type || 'other';
    if (!byType[t]) byType[t] = [];
    byType[t].push(item);
  }
  const pendingGroups = Object.entries(byType).map(([type, items]) => {
    const icon = typeIcons[type] || ICONS.file;
    const rows = items.map(item => {
      const name = item.path.split('/').pop().replace(/\.md$/, '');
      let preview = '';
      try {
        const raw = readFileSync(join(ROOT, item.path), 'utf8');
        if (item.type === 'video') {
          const channelM = raw.match(/^channel:\s*"?([^"\n]+)"?/m);
          const transcriptM = raw.match(/## Transcript\n\n([\s\S]+)/);
          const channel = channelM ? `📺 ${channelM[1].trim()}` : '📺 YouTube';
          const excerpt = transcriptM ? transcriptM[1].trim().slice(0, 200) : '';
          preview = [channel, excerpt && `"${excerpt}${excerpt.length >= 200 ? '…' : ''}"`].filter(Boolean).join('\n');
        } else {
          preview = raw.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^#+\s.*$/gm, '').replace(/\n{2,}/g, '\n').trim().slice(0, 600);
        }
      } catch {}
      const hp = preview.length > 0;
      const taskText = name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ');
      const p = escHtml(item.path);
      return `<div class="pending-item${hp?' has-preview':''}"${hp?' onclick="togglePreview(this)"':''}>
        <div class="pending-header">
          <span class="pending-icon">${icon}</span>
          <span class="pending-name">${escHtml(name)}</span>
          <span class="pending-path">${p}</span>
          ${hp ? `<span class="pending-toggle">${ICONS.chevron}</span>` : ''}
          <button class="pending-task-btn" data-path="${p}" onclick="toggleTaskForm(event,this)" title="Convert to task">→ Task</button>
          <button class="pending-delete" data-path="${p}" onclick="deletePending(event,this)" title="Remove">×</button>
        </div>
        ${hp ? `<div class="pending-preview"><pre>${escHtml(preview)}${preview.length>=600?'\n…':''}</pre></div>` : ''}
        <div class="pending-task-form">
          <input class="task-text-input" type="text" value="${escHtml(taskText)}" placeholder="Task description">
          <input class="task-due-input" type="datetime-local">
          <button onclick="submitPendingTask(event,this)">Create task</button>
          <span class="task-form-error"></span>
        </div>
      </div>`;
    }).join('');
    return `<div class="pending-group"><h3>${escHtml(type)} <span class="pending-count">${items.length}</span></h3>${rows}</div>`;
  }).join('');

  const tokenScript = token ? `const INGEST_TOKEN=${JSON.stringify(token)};` : `const INGEST_TOKEN='';`;

  const content = `
    <h1 class="page-title">Inbox</h1>
    <p class="page-subtitle">${pending.length} item${pending.length!==1?'s':''} pending${lastCompile?` · Compiled ${escHtml(lastCompile)}`:''}</p>

    <div class="inbox-section">
      <h2 class="inbox-section-title">Quick Capture</h2>
      <div class="card">
        <div class="drop-zone" id="drop-zone">
          <textarea id="ingest-input" rows="6" placeholder="Paste a URL, type a note, or drop files here…" autocomplete="off" spellcheck="true"></textarea>
          <div class="drop-hint">
            <span>Drop files · Cmd+Enter to save</span>
            <button id="voice-btn" type="button" title="Hold Space to record voice note">
              ${ICONS.mic}
              <span id="voice-label">Hold Space</span>
            </button>
            <span id="type-preview" class="type-badge" style="display:none"></span>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" id="save-btn" onclick="submitText()">Add to Brain</button>
          <label class="btn-file" for="file-input">Browse files</label>
          <input type="file" id="file-input" multiple accept="*/*">
        </div>
        <div id="queue"></div>
      </div>
    </div>

    <div class="inbox-sep"></div>

    <div class="inbox-section">
      <h2 class="inbox-section-title">Pending <span class="pending-count" id="pending-total-count">${pending.length}</span></h2>
      <div id="pending-content">
        ${pending.length===0?'<div class="pending-empty">Nothing pending — the wiki is up to date.</div>':pendingGroups}
      </div>
    </div>

    <div class="compile-bar">
      <div id="compile-progress" class="compile-progress-bar"></div>
      <button id="compile-btn"${pending.length===0?' disabled':''}>${ICONS.zap} Compile now</button>
      ${pending.length>0?'<button id="preview-btn" class="preview-btn">Preview</button>':''}
      <span id="compile-status" data-pending="${pending.length}">${pending.length===0?'Nothing to compile.':`${pending.length} item${pending.length!==1?'s':''} will be processed.`}</span>
      <span class="schedule-ctrl" id="schedule-ctrl"></span>
      <button id="log-toggle-btn" class="log-toggle-btn" style="display:none" title="Show/hide log">Log</button>
    </div>
    <div id="compile-log" class="compile-log" hidden></div>

    <script>
    ${tokenScript}
    const URL_RE_IB = /^https?:\\/\\/\\S+$/;
    function guessType(text,mime){
      if(mime){if(mime.startsWith('image/'))return'image';if(mime.startsWith('audio/'))return'voice';if(mime==='application/pdf')return'pdf';if(mime!=='text/plain')return'file';}
      return URL_RE_IB.test((text||'').trim())?'article':'note';
    }
    const TYPE_ICONS={article:\`${ICONS.article}\`,note:\`${ICONS.note}\`,image:\`${ICONS.image}\`,voice:\`${ICONS.file}\`,pdf:\`${ICONS.file}\`,file:\`${ICONS.file}\`};
    function escH(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
    function authHdrs(extra){const h={...extra};if(INGEST_TOKEN)h['Authorization']='Bearer '+INGEST_TOKEN;return h;}

    const queue=[];let isProcessing=false;
    function enqueueText(text){if(!text.trim())return;const id=crypto.randomUUID(),type=guessType(text,null);queue.push({id,label:text.length>60?text.slice(0,58)+'…':text,type,status:'pending',send:()=>sendJson(text)});renderQueue();processNext();}
    function enqueueFile(file){const id=crypto.randomUUID(),type=guessType('',file.type);queue.push({id,label:file.name,type,status:'pending',send:()=>sendFile(file)});renderQueue();processNext();}
    async function processNext(){if(isProcessing)return;const item=queue.find(i=>i.status==='pending');if(!item)return;isProcessing=true;item.status='processing';renderQueue();try{const r=await item.send();item.status='done';item.message=r.message||'Saved';if(r.items?.[0]?.type)item.type=r.items[0].type;refreshPending();}catch(e){item.status='error';item.message=e.message||'Error';}renderQueue();isProcessing=false;processNext();}
    function renderQueue(){const el=document.getElementById('queue');if(!queue.length){el.innerHTML='';return;}el.innerHTML=queue.map(i=>{const icon=TYPE_ICONS[i.type]||\`${ICONS.file}\`;const sl=i.status==='processing'?' spin':'';const sl2={pending:'Pending',processing:'Uploading…',done:'Saved',error:'Error'};const errLine=i.status==='error'&&i.message?\`<div class="q-err">\${escH(i.message)}</div>\`:'';return\`<div class="q-item"><span class="q-icon\${sl}">\${icon}</span><span class="q-name">\${escH(i.label)}</span><span class="q-badge type-badge \${i.type}">\${i.type}</span><span class="q-status \${i.status}">\${sl2[i.status]}</span></div>\${errLine}\`;}).join('');}
    async function sendJson(content){const res=await fetch('/api/ingest',{method:'POST',headers:authHdrs({'Content-Type':'application/json'}),body:JSON.stringify({content})});const data=await res.json();if(!res.ok)throw new Error(data.error||'Server error');return data;}
    async function sendFile(file){const fd=new FormData();fd.append('file',file,file.name);const res=await fetch('/api/ingest',{method:'POST',headers:authHdrs({}),body:fd});const data=await res.json();if(!res.ok)throw new Error(data.error||'Server error');return data;}

    async function refreshPending(){
      try{
        const data=await fetch('/api/pending').then(r=>r.json());
        const ps=data.pending||[];
        const tc=document.getElementById('pending-total-count');
        const cb=document.getElementById('compile-btn');
        const cs=document.getElementById('compile-status');
        if(tc)tc.textContent=ps.length;
        if(cb)cb.disabled=ps.length===0;
        if(cs)cs.textContent=ps.length===0?'Nothing to compile.':\`\${ps.length} item\${ps.length!==1?'s':''} will be processed.\`;
        const dot=document.getElementById('status-dot'),stxt=document.getElementById('status-text');
        if(dot&&stxt){stxt.textContent=ps.length>0?ps.length+' pending':'Up to date';dot.className='status-dot'+(ps.length>0?' pending':' fresh');}
        const pc=document.getElementById('pending-content');
        if(pc){if(ps.length===0){pc.innerHTML='<div class="pending-empty">Nothing pending \u2014 the wiki is up to date.</div>';}else{const grps={};ps.forEach(i=>{const t=i.type||'other';if(!grps[t])grps[t]=[];grps[t].push(i);});pc.innerHTML=Object.entries(grps).map(([type,items])=>{const icon=TYPE_ICONS[type]||TYPE_ICONS.file||'';const rows=items.map(i=>{const nm=escH(i.path.split('/').pop().replace(/\.md$/,''));const p=escH(i.path);const tt=escH(nm.replace(/^\d{4}-\d{2}-\d{2}-/,'').replace(/-/g,' '));return\`<div class="pending-item"><div class="pending-header"><span class="pending-icon">\${icon}</span><span class="pending-name">\${nm}</span><span class="pending-path">\${p}</span><button class="pending-task-btn" data-path="\${p}" onclick="toggleTaskForm(event,this)" title="Convert to task">\u2192 Task</button><button class="pending-delete" data-path="\${p}" onclick="deletePending(event,this)" title="Remove">\xd7</button></div><div class="pending-task-form"><input class="task-text-input" type="text" value="\${tt}" placeholder="Task description"><input class="task-due-input" type="datetime-local"><button onclick="submitPendingTask(event,this)">Create task</button><span class="task-form-error"></span></div></div>\`;}).join('');return\`<div class="pending-group"><h3>\${escH(type)} <span class="pending-count">\${items.length}</span></h3>\${rows}</div>\`;}).join('');}}
      }catch{}
    }

    function submitText(){const ta=document.getElementById('ingest-input');const t=ta.value.trim();if(!t)return;enqueueText(t);ta.value='';updateTypePreview('');}
    const ta=document.getElementById('ingest-input');
    ta.addEventListener('input',()=>updateTypePreview(ta.value));
    ta.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();submitText();}});
    function updateTypePreview(text){const b=document.getElementById('type-preview');if(!text.trim()){b.style.display='none';return;}const t=guessType(text,null);b.textContent=t;b.className='type-badge '+t;b.style.display='';}
    document.getElementById('file-input').addEventListener('change',e=>{for(const f of e.target.files)enqueueFile(f);e.target.value='';});
    const card=document.querySelector('.card');
    card.addEventListener('dragover',e=>{e.preventDefault();document.getElementById('drop-zone').classList.add('drag-over');});
    card.addEventListener('dragleave',e=>{if(!card.contains(e.relatedTarget))document.getElementById('drop-zone').classList.remove('drag-over');});
    card.addEventListener('drop',e=>{e.preventDefault();document.getElementById('drop-zone').classList.remove('drag-over');for(const f of e.dataTransfer.files)enqueueFile(f);const t=e.dataTransfer.getData('text/plain')||e.dataTransfer.getData('text/uri-list');if(t&&!e.dataTransfer.files.length)enqueueText(t);});
    document.addEventListener('paste',e=>{const items=[...(e.clipboardData?.items||[])];const img=items.find(i=>i.type.startsWith('image/'));if(img){e.preventDefault();const f=img.getAsFile();if(f)enqueueFile(f);}});

    function togglePreview(el){el.classList.toggle('open');}

    function toggleTaskForm(e,btn){
      e.stopPropagation();
      const form=btn.closest('.pending-item').querySelector('.pending-task-form');
      const open=form.classList.toggle('open');
      if(open){
        // Default due: tomorrow 09:00
        const d=new Date();d.setDate(d.getDate()+1);d.setHours(9,0,0,0);
        const due=form.querySelector('.task-due-input');
        if(!due.value)due.value=d.toISOString().slice(0,16);
        form.querySelector('.task-text-input').focus();
      }
    }
    async function submitPendingTask(e,btn){
      e.stopPropagation();
      const form=btn.closest('.pending-task-form');
      const item=btn.closest('.pending-item');
      const path=item.querySelector('[data-path]').dataset.path;
      const text=form.querySelector('.task-text-input').value.trim();
      const due=form.querySelector('.task-due-input').value;
      const errEl=form.querySelector('.task-form-error');
      if(!text||!due){errEl.textContent='Fill in all fields';return;}
      btn.disabled=true;errEl.textContent='';
      try{
        const r=await fetch('/api/tasks/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,due})});
        if(!r.ok)throw new Error((await r.json()).error||'Error creating task');
        await fetch('/api/pending/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});
        const grp=item.closest('.pending-group');
        item.remove();
        if(!grp?.querySelectorAll('.pending-item').length)grp?.remove();
        refreshPending();
      }catch(err){btn.disabled=false;errEl.textContent=err.message;}
    }

    async function deletePending(e,btn){
      e.stopPropagation();const p=btn.dataset.path;
      try{const res=await fetch('/api/pending/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p})});if(!res.ok)throw new Error();
        const item=btn.closest('.pending-item'),grp=item.closest('.pending-group');item.remove();
        const ce=grp.querySelector('.pending-count');if(ce){const n=parseInt(ce.textContent)-1;if(n<=0)grp.remove();else ce.textContent=n;}
        const total=[...document.querySelectorAll('.pending-item')].length;
        const tc=document.getElementById('pending-total-count');if(tc)tc.textContent=total;
        const cb=document.getElementById('compile-btn');if(cb)cb.disabled=total===0;
        const cs=document.getElementById('compile-status');if(cs)cs.textContent=total===0?'Nothing to compile.':\`\${total} item\${total!==1?'s':''} will be processed.\`;
        const dot=document.getElementById('status-dot'),stxt=document.getElementById('status-text');
        if(dot&&stxt){stxt.textContent=total>0?total+' pending':'Up to date';dot.className='status-dot'+(total>0?' pending':' fresh');}
      }catch{}
    }
    // ── Compile bar (mode toggle + progress + streaming log + diff) ──
    (async()=>{
      const btn=document.getElementById('compile-btn');
      const status=document.getElementById('compile-status');
      const log=document.getElementById('compile-log');
      const bar=document.getElementById('compile-progress');
      let sse=null,pTotal=0,pCurrent=0,currentMode='api';
      try{
        const [caps,cfg]=await Promise.all([fetch('/api/compile-capabilities').then(r=>r.json()),fetch('/api/config').then(r=>r.json())]);
        const modes=caps.modes||['api'];
        currentMode=(modes.includes(cfg.llm_backend)?cfg.llm_backend:null)||'api';
      }catch{}
      function setBar(pct,ind){
        if(!bar)return;
        if(ind){bar.classList.add('indeterminate');}
        else{bar.classList.remove('indeterminate');bar.style.width=pct+'%';}
      }
      function appendLog(text){
        if(!log)return;
        log.hidden=false;
        const el=document.createElement('div');el.className='compile-log-line';el.textContent=text;
        log.appendChild(el);log.scrollTop=log.scrollHeight;
        const m=text.match(/Routing \\d+ items.*?(\\d+) wiki articles?/);
        if(m){pTotal=parseInt(m[1]);setBar(15);}
        if(/Step 1\\/2/.test(text))setBar(5);
        if(/Step 2\\/2/.test(text)){
          currentMode==='claude'?setBar(0,true):setBar(20);
        }
        if(/^\\s*✓\\s+wiki\\//.test(text)&&pTotal>0){pCurrent++;setBar(Math.round(20+pCurrent/pTotal*75));}
      }
      function renderDiff(diff){
        if(!diff||!diff.length||!log)return;
        const sep=document.createElement('div');sep.className='compile-log-sep';log.appendChild(sep);
        const cr=diff.filter(d=>d.isNew),up=diff.filter(d=>!d.isNew);
        const hdr=document.createElement('div');hdr.className='compile-log-diff-header';
        hdr.textContent=(cr.length?cr.length+' created':'')+(cr.length&&up.length?' · ':'')+(up.length?up.length+' updated':'');
        log.appendChild(hdr);
        [...cr,...up].forEach(d=>{
          const row=document.createElement('div');row.className='compile-log-diff-line';
          const delta=d.after-d.before;
          const sz=d.isNew?(d.after/1024).toFixed(1)+' KB':(delta>=0?'+':'')+((delta)/1024).toFixed(1)+' KB';
          row.innerHTML='<span class="diff-icon">'+(d.isNew?'+':'↑')+'</span> '+d.file.replace('wiki/','').replace('.md','')+' <span class="diff-size">'+sz+'</span>';
          log.appendChild(row);
        });
        log.scrollTop=log.scrollHeight;
      }
      function connectStream(){
        pTotal=0;pCurrent=0;
        if(sse)sse.close();
        showLog();
        if(previewBtn)previewBtn.disabled=true;
        sse=new EventSource('/api/compile/stream');
        sse.addEventListener('line',e=>{try{appendLog(JSON.parse(e.data).text);}catch{}});
        sse.addEventListener('done',e=>{
          sse.close();sse=null;setBar(100);
          setTimeout(()=>{if(bar){bar.classList.remove('indeterminate');bar.style.width='0';}},1500);
          if(previewBtn)previewBtn.disabled=false;
          try{
            const d=JSON.parse(e.data);
            btn.disabled=false;btn.innerHTML='${ICONS.zap} Compile now';
            if(d.code===0){
              status.textContent=d.remainingCount>0?'Done. '+d.remainingCount+' item'+(d.remainingCount!==1?'s':'')+' kept for retry.':'Done. Refresh to see updated articles.';
              if(d.remainingCount>=0)status.dataset.pending=String(d.remainingCount);
            }else{
              status.textContent='Compilation failed — check the log above.';
            }
            renderDiff(d.diff);
          }catch{}
        });
      }
      try{
        const st=await fetch('/api/compile/status').then(r=>r.json());
        if(st.running){
          btn.disabled=true;btn.textContent='Compiling...';
          status.textContent='Running in '+(st.mode||'')+' mode...';
          connectStream();
        } else if(st.recentLines&&st.recentLines.length>0){
          connectStream(); // shows log with recent output
        } else if(st.lastDuration&&st.lastDuration.pendingCount>0){
          const pending=parseInt(status?.dataset?.pending||'0');
          if(pending>0){
            const spi=st.lastDuration.durationMs/st.lastDuration.pendingCount/1000;
            const est=Math.round(pending*spi);
            status.textContent+=' — '+(est>=60?'~'+Math.round(est/60)+' min':'~'+est+'s')+' estimated';
          }
        }
      }catch{}
      btn?.addEventListener('click',async()=>{
        const mode=currentMode;
        btn.disabled=true;btn.innerHTML='${ICONS.zap} Starting...';
        status.textContent='Launching compilation...';
        if(log)log.innerHTML='';
        showLog();
        setBar(2);
        try{
          const res=await fetch('/api/compile',{method:'POST'});
          const data=await res.json();
          if(data.ok){btn.textContent='Compiling...';status.textContent='Running in '+mode+' mode...';connectStream();}
          else{btn.disabled=false;btn.innerHTML='${ICONS.zap} Compile now';status.textContent='Error: '+(data.error||'unknown');setBar(0);}
        }catch(e){btn.disabled=false;btn.innerHTML='${ICONS.zap} Compile now';status.textContent='Error: '+e.message;setBar(0);}
      });

      // ── Log toggle ─────────────────────────────────────────────────────────
      const previewBtn=document.getElementById('preview-btn');
      const logToggleBtn=document.getElementById('log-toggle-btn');
      function showLog(){if(log){log.hidden=false;}if(logToggleBtn){logToggleBtn.style.display='';logToggleBtn.textContent='▲ Log';}}
      function hideLog(){if(log){log.hidden=true;}if(logToggleBtn){logToggleBtn.textContent='▼ Log';}}
      logToggleBtn?.addEventListener('click',()=>{ log?.hidden?showLog():hideLog(); });

      // ── Preview (dry-run routing) ───────────────────────────────────────────
      previewBtn?.addEventListener('click',async()=>{
        if(log)log.innerHTML='';
        showLog();
        previewBtn.disabled=true;previewBtn.textContent='Routing...';
        try{
          const r=await fetch('/api/compile/preview',{method:'POST'});
          const d=await r.json();
          if(!d.ok){if(log){const el=document.createElement('div');el.className='compile-log-line';el.textContent='Error: '+(d.error||'unknown');log.appendChild(el);}return;}
          renderPreview(d);
        }catch(e){if(log){const el=document.createElement('div');el.className='compile-log-line';el.textContent='Error: '+e.message;log.appendChild(el);}}
        finally{previewBtn.disabled=false;previewBtn.textContent='Preview';}
      });

      function renderPreview(d){
        if(!log)return;
        const ACTION_LABEL={'update':'update','create':'create','both':'update+create','unknown':'?'};
        const lines=[];
        lines.push('<div class="compile-log-line" style="font-weight:600">Preview — '+d.items.length+' item'+(d.items.length!==1?'s':'')+'</div>');
        lines.push('<div class="compile-log-sep"></div>');
        for(const item of d.items){
          const type='['+item.type+']';
          const name=item.path.split('/').pop();
          const action=ACTION_LABEL[item.action]||item.action;
          const arts=item.articles.length?item.articles.map(a=>a.replace('wiki/','')).join(', '):'(new)';
          lines.push('<div class="compile-log-line"><span style="color:var(--ink-3);min-width:80px;display:inline-block">'+type+'</span> '+name+' <span style="color:var(--ink-3)">→ '+action+'</span> <span style="color:var(--ink-2)">'+arts+'</span></div>');
        }
        lines.push('<div class="compile-log-sep"></div>');
        const s=d.summary;
        const parts=[];
        if(s.create)parts.push(s.create+' create');
        if(s.update)parts.push(s.update+' update');
        parts.push(s.affected+' file'+(s.affected!==1?'s':'')+' affected');
        lines.push('<div class="compile-log-line" style="color:var(--ink-2)">'+parts.join(' · ')+'</div>');
        log.innerHTML=lines.join('');
      }

      // ── Schedule (one-shot) ─────────────────────────────────────────────────
      (async()=>{
        const ctrl=document.getElementById('schedule-ctrl');
        if(!ctrl)return;
        let scheduled=null;
        try{const st=await fetch('/api/compile/status').then(r=>r.json());scheduled=st.scheduledAt||null;}catch{}
        renderSchedule();

        function renderSchedule(){
          if(scheduled){
            const d=new Date(scheduled);
            const hhmm=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});
            const isToday=d.toDateString()===new Date().toDateString();
            const label=(isToday?'today':'tomorrow')+' at '+hhmm;
            ctrl.innerHTML='<span class="schedule-label">Scheduled for '+label+'</span>'
              +'<button class="schedule-cancel" title="Cancel schedule">×</button>';
            ctrl.querySelector('.schedule-cancel').onclick=async()=>{
              await fetch('/api/compile/schedule',{method:'DELETE'});
              scheduled=null;renderSchedule();
            };
          }else{
            ctrl.innerHTML='<span class="schedule-sep">·</span>'
              +'<button class="schedule-open-btn">Schedule</button>';
            ctrl.querySelector('.schedule-open-btn').onclick=()=>{
              ctrl.innerHTML='<input class="schedule-input" type="time" value="07:00" id="schedule-time">'
                +'<button class="schedule-set-btn">Set</button>'
                +'<button class="schedule-cancel-btn">Cancel</button>';
              ctrl.querySelector('.schedule-set-btn').onclick=async()=>{
                const t=document.getElementById('schedule-time').value;
                if(!t)return;
                const r=await fetch('/api/compile/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({time:t})});
                const data=await r.json();
                if(data.ok){scheduled=data.scheduledAt;renderSchedule();}
              };
              ctrl.querySelector('.schedule-cancel-btn').onclick=()=>{scheduled=null;renderSchedule();};
            };
          }
        }
      })();
    })();

    // ── Voice recording (push-to-talk with Space / triple-space in textarea) ──
    {
      let recorder=null,chunks=[],stream=null,recording=false;
      const btn=document.getElementById('voice-btn');
      const lbl=document.getElementById('voice-label');

      function setRecording(on){
        recording=on;
        btn.classList.toggle('recording',on);
        lbl.textContent=on?'Recording…':'Hold Space';
      }

      async function start(){
        if(recording)return;
        try{
          stream=await navigator.mediaDevices.getUserMedia({audio:true});
          const mime=MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'audio/mp4';
          recorder=new MediaRecorder(stream,{mimeType:mime});
          chunks=[];
          recorder.ondataavailable=e=>{if(e.data.size>0)chunks.push(e.data);};
          recorder.onstop=async()=>{
            const mime=recorder.mimeType;
            const ext=mime.includes('webm')?'webm':'mp4';
            const file=new File([new Blob(chunks,{type:mime})],\`voice-\${Date.now()}.\${ext}\`,{type:mime});
            stream.getTracks().forEach(t=>t.stop());
            stream=null;recorder=null;
            setRecording(false);
            // Transcribe first, show in textarea for review
            lbl.textContent='Transcribing…';btn.disabled=true;
            try{
              const fd=new FormData();fd.append('file',file,file.name);
              const r=await fetch('/api/transcribe',{method:'POST',headers:authHdrs({}),body:fd});
              const data=await r.json();
              if(!r.ok)throw new Error(data.error||'Transcription failed');
              const ta=document.getElementById('ingest-input');
              ta.value=data.text;ta.focus();
              updateTypePreview(data.text);
            }catch(e){
              // Fall back to direct ingest if transcription preview fails
              enqueueFile(file);
            }finally{
              lbl.textContent='Hold Space';btn.disabled=false;
            }
          };
          recorder.start();
          setRecording(true);
        }catch(e){setRecording(false);}
      }

      function stop(){
        if(!recording||!recorder)return;
        recorder.stop();
      }

      // Spacebar push-to-talk — only when focus is outside inputs
      document.addEventListener('keydown',e=>{
        if(e.code!=='Space'||e.repeat)return;
        if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
        e.preventDefault();start();
      });
      document.addEventListener('keyup',e=>{
        if(e.code!=='Space')return;
        stop();
      });

      // Triple-space inside textarea triggers recording
      let _sc=0,_st=null;
      ta.addEventListener('keydown',e=>{
        if(e.key!==' '){_sc=0;clearTimeout(_st);return;}
        if(e.repeat){e.preventDefault();return;}  // block key-repeat while holding
        _sc++;clearTimeout(_st);
        _st=setTimeout(()=>{_sc=0;},600);
        if(_sc>=3){e.preventDefault();_sc=0;start();}
      });

      // Button: click-to-start, click-again-to-stop
      btn.addEventListener('mousedown',e=>{e.preventDefault();if(!recording)start();});
      btn.addEventListener('mouseup',()=>{if(recording)stop();});
      btn.addEventListener('touchstart',e=>{e.preventDefault();if(!recording)start();},{passive:false});
      btn.addEventListener('touchend',()=>{if(recording)stop();});
    }
    </script>
  `;
  return layout(content, articles, '__inbox', 'Inbox — Second Brain');
}

// ── Tasks page ────────────────────────────────────────────────────────────────

function handleTasksPage(articles) {
  const todayDefault = new Date().toISOString().slice(0, 10);
  const nowTime = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });

  const content = `
    <h1 class="page-title">Tasks</h1>
    <p class="page-subtitle" id="task-subtitle">Cargando...</p>

    <div class="task-context-wrap">
      <textarea id="task-context" class="task-context-area" rows="2"
        placeholder="Contexto del día (opcional)..." oninput="onContextInput()"></textarea>
    </div>

    <div class="task-add-wrap">
      <input id="task-input" class="task-add-text" type="text"
        placeholder="Nueva tarea o recordatorio..." autocomplete="off">
      <input id="task-date" class="task-add-date" type="date" value="${todayDefault}">
      <input id="task-time" class="task-add-time" type="time" value="09:00">
      <button class="btn btn-primary task-add-btn" onclick="addTask()">Add</button>
    </div>

    <div id="task-sections"></div>
    <div id="upcoming-section"></div>
    <div id="toast"></div>

    <script>
    (function() {
      let state = { date: '', context: '', tasks: [] };
      let upcomingData = [];
      let saveTimer = null;

      // ── Helpers ──────────────────────────────────────────────────────────────

      function escH(s) {
        return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
      function fmtDate(d) {
        return new Date(d + 'T12:00').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
      }
      function fmtDue(dueStr) {
        if (!dueStr) return null;
        const norm = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/.test(dueStr) ? dueStr + ':00' : dueStr;
        const d = new Date(norm);
        return isNaN(d.getTime()) ? null : d;
      }
      function ageDays(createdAt) {
        if (!createdAt) return 0;
        return Math.floor((Date.now() - new Date(createdAt)) / 86400000);
      }
      function todayStr() { return new Date().toISOString().slice(0,10); }

      function showToast(msg, isError) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.className = isError ? 'toast error show' : 'toast success show';
        setTimeout(() => t.classList.remove('show'), 2500);
      }

      // ── Render ────────────────────────────────────────────────────────────────

      function taskCard(t) {
        const age = ageDays(t.createdAt);
        const ageBadge = age >= 1
          ? \`<span class="task-age \${age >= 3 ? 'age-old' : 'age-warn'}">\${age}d</span>\` : '';
        const due = fmtDue(t.due);
        const now = new Date();
        const badgeClass = due ? (due < now ? 'overdue' : (due.toDateString() === now.toDateString() ? 'today' : 'upcoming')) : '';
        const dueHtml = due ? \`<span class="task-due \${badgeClass}">\${due.toLocaleString('es-ES',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</span>\` : '';
        const actions = !t.done ? \`
          <div class="task-actions">
            <select class="task-postpone" onchange="postponeTaskUI('\${escH(t.id)}',this.value);this.selectedIndex=0">
              <option value="">snooze</option>
              <option value="1">Mañana</option>
              <option value="2">+2 días</option>
              <option value="3">+3 días</option>
              <option value="7">+1 semana</option>
            </select>
            <button class="task-delete" onclick="deleteTask('\${escH(t.id)}')">×</button>
          </div>\` : '';
        return \`<div class="task-card\${t.done?' done':''}\${t.carriedOver?' carried':''}" data-id="\${escH(t.id)}">
          <label class="task-check"><input type="checkbox" \${t.done?'checked':''} onchange="toggleDone('\${escH(t.id)}')"></label>
          <div class="task-main">
            <span class="task-text" ondblclick="startEdit(this,'\${escH(t.id)}')">\${escH(t.text)}</span>
            \${ageBadge}\${dueHtml}
          </div>
          \${actions}
        </div>\`;
      }

      function sectionHtml(label, tasks, carried) {
        if (!tasks.length) return '';
        const borderStyle = carried ? 'style="border-left:3px solid var(--rule-2);padding-left:10px"' : '';
        return \`<div class="task-section" \${borderStyle}>
          <h2 class="section-title">\${escH(label)} <span class="section-count">\${tasks.length}</span></h2>
          \${tasks.map(taskCard).join('')}
        </div>\`;
      }

      function render() {
        const carried = state.tasks.filter(t => t.carriedOver && !t.done);
        const todays  = state.tasks.filter(t => !t.carriedOver && !t.done);
        const done    = state.tasks.filter(t => t.done);
        const pending = carried.length + todays.length;

        document.getElementById('task-subtitle').textContent =
          (state.date ? fmtDate(state.date) : '') + ' · ' + pending + ' pendiente' + (pending !== 1 ? 's' : '');

        let html = '';
        if (carried.length) html += sectionHtml('Arrastradas', carried, true);
        if (todays.length)  html += sectionHtml('Hoy', todays, false);
        if (done.length)    html += sectionHtml('Hecho', done, false);
        if (!pending)       html += '<p class="empty">No hay tareas pendientes.</p>';
        document.getElementById('task-sections').innerHTML = html;

        // Upcoming
        const upEl = document.getElementById('upcoming-section');
        if (upcomingData.length) {
          const total = upcomingData.reduce((s,d) => s + d.tasks.length, 0);
          let upHtml = \`<div class="task-section" style="margin-top:32px"><h2 class="section-title">Próximos <span class="section-count">\${total}</span></h2>\`;
          for (const { date, tasks } of upcomingData) {
            upHtml += \`<div class="upcoming-day">
              <div class="upcoming-day-header">\${escH(fmtDate(date))} <span class="pending-count">\${tasks.length}</span></div>
              \${tasks.map(t => \`<div class="task-card" data-id="\${escH(t.id)}">
                <div class="task-main" style="flex:1">
                  <span class="task-text">\${escH(t.text)}</span>
                  \${fmtDue(t.due) ? \`<span class="task-due upcoming">\${fmtDue(t.due).toLocaleString('es-ES',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</span>\` : ''}
                </div>
                <div class="task-actions">
                  <button class="btn-pull" onclick="pullTaskUI('\${escH(t.id)}','\${escH(date)}')">Hoy</button>
                  <button class="task-delete" onclick="deleteUpcomingTask('\${escH(t.id)}')">×</button>
                </div>
              </div>\`).join('')}
            </div>\`;
          }
          upHtml += '</div>';
          upEl.innerHTML = upHtml;
        } else {
          upEl.innerHTML = '';
        }
      }

      // ── Data fetch ────────────────────────────────────────────────────────────

      async function refresh() {
        const [todayRes, upcomingRes] = await Promise.all([
          fetch('/api/today').then(r => r.json()),
          fetch('/api/today/upcoming').then(r => r.json()),
        ]);
        state = todayRes;
        upcomingData = upcomingRes;
        document.getElementById('task-context').value = state.context || '';
        render();
      }

      // ── Save (debounced) ──────────────────────────────────────────────────────

      function debouncedSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          await fetch('/api/today', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: state.context, tasks: state.tasks }),
          });
        }, 400);
      }

      // ── Actions ───────────────────────────────────────────────────────────────

      window.onContextInput = function() {
        state.context = document.getElementById('task-context').value;
        debouncedSave();
      };

      window.addTask = async function() {
        const text = document.getElementById('task-input').value.trim();
        if (!text) return;
        const date = document.getElementById('task-date').value || todayStr();
        const time = document.getElementById('task-time').value || '09:00';
        const due  = date + 'T' + time;
        clearTimeout(saveTimer);
        try {
          const res = await fetch('/api/tasks/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, due }),
          });
          if (!res.ok) throw new Error('Error');
          document.getElementById('task-input').value = '';
          await refresh();
        } catch { showToast('Error al añadir tarea', true); }
      };

      // Enter in task input
      document.getElementById('task-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addTask(); }
      });

      window.toggleDone = function(id) {
        const t = state.tasks.find(t => t.id === id);
        if (!t) return;
        t.done = !t.done;
        t.completedAt = t.done ? new Date().toISOString().slice(0,10) : null;
        render();
        debouncedSave();
      };

      window.deleteTask = function(id) {
        state.tasks = state.tasks.filter(t => t.id !== id);
        render();
        debouncedSave();
      };

      window.startEdit = function(span, id) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = span.textContent;
        input.className = 'task-edit-input';
        span.replaceWith(input);
        input.focus(); input.select();
        const commit = () => {
          const newText = input.value.trim() || span.textContent;
          const t = state.tasks.find(t => t.id === id);
          if (t) { t.text = newText; debouncedSave(); }
          render();
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') render();
        });
      };

      window.postponeTaskUI = async function(id, days) {
        if (!days) return;
        const d = new Date(); d.setDate(d.getDate() + parseInt(days));
        const targetDate = d.toISOString().slice(0,10);
        clearTimeout(saveTimer);
        try {
          const res = await fetch('/api/today/postpone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: id, targetDate }),
          });
          if (!res.ok) throw new Error('Error');
          await refresh();
        } catch { showToast('Error al posponer', true); }
      };

      window.pullTaskUI = async function(id, fromDate) {
        clearTimeout(saveTimer);
        try {
          const res = await fetch('/api/today/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: id, fromDate }),
          });
          if (!res.ok) throw new Error('Error');
          await refresh();
        } catch { showToast('Error al traer tarea', true); }
      };

      window.deleteUpcomingTask = async function(id) {
        try {
          const res = await fetch('/api/tasks/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: id }),
          });
          if (!res.ok) throw new Error('Error');
          await refresh();
        } catch { showToast('Error al borrar tarea', true); }
      };

      window.copyForClaude = function() {
        const carried = state.tasks.filter(t => t.carriedOver && !t.done);
        const todays  = state.tasks.filter(t => !t.carriedOver && !t.done);
        let text = '# Tasks — ' + (state.date || todayStr()) + '\\n\\n';
        if (state.context) text += '**Contexto:** ' + state.context + '\\n\\n';
        if (carried.length) { text += '## Arrastradas\\n'; carried.forEach(t => { text += '- [ ] ' + t.text + '\\n'; }); text += '\\n'; }
        if (todays.length)  { text += '## Hoy\\n'; todays.forEach(t => { text += '- [ ] ' + t.text + '\\n'; }); text += '\\n'; }
        text += 'Ayúdame a priorizar estas tareas y sugiere un orden realista para hoy.';
        navigator.clipboard.writeText(text).then(() => showToast('Copiado para Claude', false));
      };

      refresh();
    })();
    </script>

    <button class="btn btn-outline task-copy-btn" onclick="copyForClaude()" style="margin-top:24px;font-size:11px">
      Copiar para Claude
    </button>
  `;
  return layout(content, articles, '__tasks', 'Tasks — Second Brain');
}

// ── Pending page ──────────────────────────────────────────────────────────────

function handlePendingPage(articles) {
  let state = { pending: [], lastCompile: null };
  try { state = JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8')); } catch {}

  const pending = state.pending || [];
  const lastCompile = state.lastCompile
    ? new Date(state.lastCompile).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'never';

  const typeIcons = {
    article: ICONS.article, note: ICONS.note, bookmark: ICONS.bookmark,
    file: ICONS.file, image: ICONS.image, 'x-bookmarks': ICONS.xbookmark, task: ICONS.tasks
  };
  const byType = {};
  for (const item of pending) {
    const t = item.type || 'other';
    if (!byType[t]) byType[t] = [];
    byType[t].push(item);
  }

  const groups = Object.entries(byType).map(([type, items]) => {
    const icon = typeIcons[type] || ICONS.file;
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
          ${hasPreview ? `<span class="pending-toggle">${ICONS.chevron}</span>` : ''}
          <button class="pending-delete" data-path="${escHtml(item.path)}" onclick="deletePending(event,this)" title="Remove from pending">×</button>
        </div>
        ${hasPreview ? `<div class="pending-preview"><pre>${escHtml(preview)}${preview.length >= 600 ? '\n…' : ''}</pre></div>` : ''}
      </div>`;
    }).join('');
    return `<div class="pending-group">
      <h3>${escHtml(type)} <span class="pending-count">${items.length}</span></h3>
      ${rows}
    </div>`;
  }).join('');

  const emptyMsg = pending.length === 0
    ? `<div class="pending-empty">Nothing pending — the wiki is up to date.</div>`
    : '';

  const content = `
    <h1 class="page-title">Pending Items</h1>
    <p class="pending-meta">Last compiled: ${escHtml(lastCompile)} · ${pending.length} item${pending.length !== 1 ? 's' : ''} waiting</p>
    ${emptyMsg}
    ${groups}
    <div class="compile-bar">
      <div id="compile-progress" class="compile-progress-bar"></div>
      <button id="compile-btn" ${pending.length === 0 ? 'disabled' : ''}>${ICONS.zap} Compile now</button>
      ${pending.length > 0 ? '<button id="preview-btn" class="preview-btn">Preview</button>' : ''}
      <span id="compile-status" data-pending="${pending.length}">${pending.length === 0 ? 'Nothing to compile.' : `${pending.length} item${pending.length !== 1 ? 's' : ''} will be processed.`}</span>
      <span class="schedule-ctrl" id="schedule-ctrl"></span>
      <button id="log-toggle-btn" class="log-toggle-btn" style="display:none" title="Show/hide log">Log</button>
    </div>
    <div id="compile-log" class="compile-log" hidden></div>
    <script>
      function togglePreview(el) {
        el.classList.toggle('open');
      }
      async function deletePending(e, btn) {
        e.stopPropagation();
        const itemPath = btn.dataset.path;
        try {
          const res = await fetch('/api/pending/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: itemPath })
          });
          if (!res.ok) throw new Error('Failed');
          const item = btn.closest('.pending-item');
          const group = item.closest('.pending-group');
          item.remove();
          const countEl = group.querySelector('.pending-count');
          if (countEl) {
            const n = parseInt(countEl.textContent) - 1;
            if (n <= 0) group.remove(); else countEl.textContent = n;
          }
        } catch {}
      }
      // ── Compile bar (mode toggle + progress + streaming log + diff) ──
      (async () => {
        const btn = document.getElementById('compile-btn');
        const status = document.getElementById('compile-status');
        const log = document.getElementById('compile-log');
        const bar = document.getElementById('compile-progress');
        let sse = null, pTotal = 0, pCurrent = 0, currentMode = 'api';
        try {
          const [caps, cfg] = await Promise.all([fetch('/api/compile-capabilities').then(r => r.json()), fetch('/api/config').then(r => r.json())]);
          const modes = caps.modes || ['api'];
          currentMode = (modes.includes(cfg.llm_backend) ? cfg.llm_backend : null) || 'api';
        } catch {}
        function setBar(pct, ind) {
          if (!bar) return;
          if (ind) { bar.classList.add('indeterminate'); }
          else { bar.classList.remove('indeterminate'); bar.style.width = pct + '%'; }
        }
        function appendLog(text) {
          if (!log) return;
          log.hidden = false;
          const el = document.createElement('div');
          el.className = 'compile-log-line'; el.textContent = text;
          log.appendChild(el); log.scrollTop = log.scrollHeight;
          const m = text.match(/Routing \\d+ items.*?(\\d+) wiki articles?/);
          if (m) { pTotal = parseInt(m[1]); setBar(15); }
          if (/Step 1\\/2/.test(text)) setBar(5);
          if (/Step 2\\/2/.test(text)) {
            currentMode === 'claude' ? setBar(0, true) : setBar(20);
          }
          if (/^\\s*✓\\s+wiki\\//.test(text) && pTotal > 0) { pCurrent++; setBar(Math.round(20 + pCurrent / pTotal * 75)); }
        }
        function renderDiff(diff) {
          if (!diff || !diff.length || !log) return;
          const sep = document.createElement('div'); sep.className = 'compile-log-sep'; log.appendChild(sep);
          const cr = diff.filter(d => d.isNew), up = diff.filter(d => !d.isNew);
          const hdr = document.createElement('div'); hdr.className = 'compile-log-diff-header';
          hdr.textContent = (cr.length ? cr.length + ' created' : '') + (cr.length && up.length ? ' · ' : '') + (up.length ? up.length + ' updated' : '');
          log.appendChild(hdr);
          [...cr, ...up].forEach(d => {
            const row = document.createElement('div'); row.className = 'compile-log-diff-line';
            const delta = d.after - d.before;
            const sz = d.isNew ? (d.after / 1024).toFixed(1) + ' KB' : (delta >= 0 ? '+' : '') + (delta / 1024).toFixed(1) + ' KB';
            row.innerHTML = '<span class="diff-icon">' + (d.isNew ? '+' : '↑') + '</span> ' + d.file.replace('wiki/', '').replace('.md', '') + ' <span class="diff-size">' + sz + '</span>';
            log.appendChild(row);
          });
          log.scrollTop = log.scrollHeight;
        }
        // ── Log toggle ────────────────────────────────────────────────────────
        const previewBtn = document.getElementById('preview-btn');
        const logToggleBtn = document.getElementById('log-toggle-btn');
        function showLog() { if (log) log.hidden = false; if (logToggleBtn) { logToggleBtn.style.display = ''; logToggleBtn.textContent = '▲ Log'; } }
        function hideLog() { if (log) log.hidden = true; if (logToggleBtn) logToggleBtn.textContent = '▼ Log'; }
        logToggleBtn?.addEventListener('click', () => { log?.hidden ? showLog() : hideLog(); });

        function connectStream() {
          pTotal = 0; pCurrent = 0;
          if (sse) sse.close();
          showLog();
          if (previewBtn) previewBtn.disabled = true;
          sse = new EventSource('/api/compile/stream');
          sse.addEventListener('line', e => { try { appendLog(JSON.parse(e.data).text); } catch {} });
          sse.addEventListener('done', e => {
            sse.close(); sse = null; setBar(100);
            setTimeout(() => { if (bar) { bar.classList.remove('indeterminate'); bar.style.width = '0'; } }, 1500);
            if (previewBtn) previewBtn.disabled = false;
            try {
              const d = JSON.parse(e.data);
              btn.disabled = false;
              btn.innerHTML = '${ICONS.zap} Compile now';
              if (d.code === 0) {
                status.textContent = d.remainingCount > 0
                  ? 'Done. ' + d.remainingCount + ' item' + (d.remainingCount !== 1 ? 's' : '') + ' kept for retry.'
                  : 'Done. Refresh to see updated articles.';
                if (d.remainingCount >= 0) status.dataset.pending = String(d.remainingCount);
              } else {
                status.textContent = 'Compilation failed — check the log above.';
              }
              renderDiff(d.diff);
            } catch {}
          });
        }
        try {
          const st = await fetch('/api/compile/status').then(r => r.json());
          if (st.running) {
            btn.disabled = true;
            btn.textContent = 'Compiling...';
            status.textContent = 'Running in ' + (st.mode || '') + ' mode...';
            connectStream();
          } else if (st.recentLines && st.recentLines.length > 0) {
            connectStream(); // shows log with recent output
          } else if (st.lastDuration && st.lastDuration.pendingCount > 0) {
            const pending = parseInt(status?.dataset?.pending || '0');
            if (pending > 0) {
              const spi = st.lastDuration.durationMs / st.lastDuration.pendingCount / 1000;
              const est = Math.round(pending * spi);
              status.textContent += ' — ' + (est >= 60 ? '~' + Math.round(est / 60) + ' min' : '~' + est + 's') + ' estimated';
            }
          }
        } catch {}
        btn?.addEventListener('click', async () => {
          const mode = currentMode;
          btn.disabled = true;
          btn.innerHTML = '${ICONS.zap} Starting...';
          status.textContent = 'Launching compilation...';
          if (log) log.innerHTML = '';
          showLog();
          setBar(2);
          try {
            const res = await fetch('/api/compile', { method: 'POST' });
            const data = await res.json();
            if (data.ok) {
              btn.textContent = 'Compiling...';
              status.textContent = 'Running in ' + mode + ' mode...';
              connectStream();
            } else {
              btn.disabled = false;
              btn.innerHTML = '${ICONS.zap} Compile now';
              status.textContent = 'Error: ' + (data.error || 'unknown');
              setBar(0);
            }
          } catch(e) {
            btn.disabled = false;
            btn.innerHTML = '${ICONS.zap} Compile now';
            status.textContent = 'Error: ' + e.message;
            setBar(0);
          }
        });

        // ── Preview (dry-run routing) ─────────────────────────────────────────
        previewBtn?.addEventListener('click', async () => {
          if (log) log.innerHTML = '';
          showLog();
          previewBtn.disabled = true; previewBtn.textContent = 'Routing...';
          try {
            const r = await fetch('/api/compile/preview', { method: 'POST' });
            const d = await r.json();
            if (!d.ok) {
              if (log) { const el = document.createElement('div'); el.className = 'compile-log-line'; el.textContent = 'Error: ' + (d.error || 'unknown'); log.appendChild(el); }
              return;
            }
            renderPreview(d);
          } catch(e) {
            if (log) { const el = document.createElement('div'); el.className = 'compile-log-line'; el.textContent = 'Error: ' + e.message; log.appendChild(el); }
          } finally {
            previewBtn.disabled = false; previewBtn.textContent = 'Preview';
          }
        });

        function renderPreview(d) {
          if (!log) return;
          const ACTION_LABEL = { update: 'update', create: 'create', both: 'update+create', unknown: '?' };
          const lines = [];
          lines.push('<div class="compile-log-line" style="font-weight:600">Preview — ' + d.items.length + ' item' + (d.items.length !== 1 ? 's' : '') + '</div>');
          lines.push('<div class="compile-log-sep"></div>');
          for (const item of d.items) {
            const type = '[' + item.type + ']';
            const name = item.path.split('/').pop();
            const action = ACTION_LABEL[item.action] || item.action;
            const arts = item.articles.length ? item.articles.map(a => a.replace('wiki/', '')).join(', ') : '(new)';
            lines.push('<div class="compile-log-line"><span style="color:var(--ink-3);min-width:80px;display:inline-block">' + type + '</span> ' + name + ' <span style="color:var(--ink-3)">→ ' + action + '</span> <span style="color:var(--ink-2)">' + arts + '</span></div>');
          }
          lines.push('<div class="compile-log-sep"></div>');
          const s = d.summary;
          const parts = [];
          if (s.create) parts.push(s.create + ' create');
          if (s.update) parts.push(s.update + ' update');
          parts.push(s.affected + ' file' + (s.affected !== 1 ? 's' : '') + ' affected');
          lines.push('<div class="compile-log-line" style="color:var(--ink-2)">' + parts.join(' · ') + '</div>');
          log.innerHTML = lines.join('');
        }

        // ── Schedule (one-shot) ───────────────────────────────────────────────
        (async () => {
          const ctrl = document.getElementById('schedule-ctrl');
          if (!ctrl) return;
          let scheduled = null;
          try { const st = await fetch('/api/compile/status').then(r => r.json()); scheduled = st.scheduledAt || null; } catch {}
          renderSchedule();

          function renderSchedule() {
            if (scheduled) {
              const d = new Date(scheduled);
              const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
              const isToday = d.toDateString() === new Date().toDateString();
              const label = (isToday ? 'today' : 'tomorrow') + ' at ' + hhmm;
              ctrl.innerHTML = '<span class="schedule-label">Scheduled for ' + label + '</span>'
                + '<button class="schedule-cancel" title="Cancel schedule">×</button>';
              ctrl.querySelector('.schedule-cancel').onclick = async () => {
                await fetch('/api/compile/schedule', { method: 'DELETE' });
                scheduled = null; renderSchedule();
              };
            } else {
              ctrl.innerHTML = '<span class="schedule-sep">·</span>'
                + '<button class="schedule-open-btn">Schedule</button>';
              ctrl.querySelector('.schedule-open-btn').onclick = () => {
                ctrl.innerHTML = '<input class="schedule-input" type="time" value="07:00" id="schedule-time">'
                  + '<button class="schedule-set-btn">Set</button>'
                  + '<button class="schedule-cancel-btn">Cancel</button>';
                ctrl.querySelector('.schedule-set-btn').onclick = async () => {
                  const t = document.getElementById('schedule-time').value;
                  if (!t) return;
                  const r = await fetch('/api/compile/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ time: t }) });
                  const data = await r.json();
                  if (data.ok) { scheduled = data.scheduledAt; renderSchedule(); }
                };
                ctrl.querySelector('.schedule-cancel-btn').onclick = () => { scheduled = null; renderSchedule(); };
              };
            }
          }
        })();
      })();
    </script>
  `;
  return layout(content, articles, '__pending', 'Pending — Second Brain');
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
    link('/', 'Library', 'articles') +
    link('/graph', 'Graph', 'graph') +
    link('/timeline', 'Feed', 'timeline') +
    link('/inbox', 'Inbox', 'inbox') +
    link('/tasks', 'Tasks', 'tasks') +
    link('/ideas', 'Ideas', 'ideas') +
    `</div>`;

  return html.replace(/<body\b[^>]*>/, m => m + inject);
}

// ── /ideas page ──────────────────────────────────────────────────────────────

function loadIdeas() {
  const dir = join(ROOT, 'raw', 'ideas');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  const now = Date.now();
  return files.map(filename => {
    let raw = '';
    try { raw = readFileSync(join(dir, filename), 'utf8'); } catch { return null; }
    // Parse frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    let meta = {}, body = raw;
    if (fmMatch) {
      body = fmMatch[2].trim();
      for (const line of fmMatch[1].split('\n')) {
        const [k, ...v] = line.split(':');
        if (k && v.length) meta[k.trim()] = v.join(':').trim();
      }
    }
    const ingested = meta.ingested ? new Date(meta.ingested) : null;
    const ageDays = ingested ? Math.floor((now - ingested.getTime()) / 86400000) : 0;
    const tags = meta.tags ? meta.tags.replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean) : [];
    return { filename, body, ingested: meta.ingested || '', ageDays, tags };
  }).filter(Boolean).sort((a, b) => a.ingested.localeCompare(b.ingested));
}

function handleIdeasPage(articles) {
  const ideas = loadIdeas();
  const count = ideas.length;

  const ideaCards = ideas.length === 0
    ? `<p class="ideas-empty">No hay ideas todavía. Usa el formulario de abajo para añadir la primera.</p>`
    : ideas.map(idea => {
        const ageClass = idea.ageDays >= 30 ? 'age-old' : idea.ageDays >= 7 ? 'age-warn' : '';
        const ageBadge = idea.ageDays > 0
          ? `<span class="task-age ${ageClass}">${idea.ageDays}d</span>` : '';
        const tagsHtml = idea.tags.map(t => `<span class="idea-tag">${t}</span>`).join('');
        const bodyEsc = idea.body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `
<div class="idea-card" data-filename="${idea.filename}">
  <div class="idea-card-header">
    <div class="idea-meta">${ageBadge}${tagsHtml}</div>
    <div class="idea-actions">
      <button class="idea-btn promote-btn" onclick="promoteIdea('${idea.filename}')">Promote</button>
      <button class="idea-btn delete-btn" onclick="deleteIdea('${idea.filename}')">×</button>
    </div>
  </div>
  <div class="idea-body">${bodyEsc}</div>
  <div class="idea-date">${idea.ingested ? new Date(idea.ingested).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</div>
</div>`;
      }).join('');

  const content = `
<div class="tasks-header">
  <h1 class="tasks-title">Ideas Vault</h1>
  <span class="tasks-count" id="ideas-count">${count} idea${count !== 1 ? 's' : ''}</span>
</div>
<p class="ideas-subtitle">Cajón de ideas en incubación. Sin presión de compilar. Promueve una idea cuando esté lista.</p>

<div class="idea-add-wrap">
  <textarea id="idea-input" class="idea-add-text" rows="3"
    placeholder="Nueva idea, observación, pregunta abierta..." autocomplete="off"></textarea>
  <button class="btn btn-primary idea-add-btn" onclick="addIdea()">Guardar idea</button>
</div>

<div id="ideas-list">${ideaCards}</div>
<div id="toast"></div>

<style>
.ideas-subtitle { font-size: 13px; color: var(--ink-3); margin: -8px 0 24px; line-height: 1.5; }
.ideas-empty { color: var(--ink-3); font-size: 14px; margin-top: 32px; }
.idea-add-wrap { display: flex; flex-direction: column; gap: 8px; margin-bottom: 32px; }
.idea-add-text { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 14px; font-family: inherit;
  border: 1px solid var(--rule-2); background: var(--surface); color: var(--ink); border-radius: 4px;
  resize: vertical; }
.idea-add-text:focus { outline: none; border-color: var(--ink-3); }
.idea-add-btn { align-self: flex-start; padding: 8px 20px; font-size: 13px; }
.idea-card { border: 1px solid var(--rule-2); border-radius: 4px; padding: 14px 16px; margin-bottom: 12px;
  background: var(--surface); }
.idea-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; gap: 8px; }
.idea-meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.idea-tag { font-size: 10px; padding: 2px 6px; border-radius: 10px;
  background: var(--rule-2); color: var(--ink-3); font-weight: 500; }
.idea-actions { display: flex; gap: 6px; flex-shrink: 0; }
.idea-btn { font-size: 12px; padding: 3px 10px; border-radius: 3px; border: 1px solid var(--rule-2);
  background: transparent; color: var(--ink-2); cursor: pointer; font-family: inherit; }
.idea-btn:hover { border-color: var(--ink-3); color: var(--ink); }
.promote-btn:hover { background: #e6f4ea; border-color: #4caf50; color: #2e7d32; }
.delete-btn:hover { background: #fdecea; border-color: #f44336; color: #c62828; }
.idea-body { font-size: 14px; color: var(--ink); line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.idea-date { font-size: 11px; color: var(--ink-3); margin-top: 8px; }
</style>

<script>
(function() {
  function showToast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = isError ? 'toast error show' : 'toast success show';
    setTimeout(() => t.classList.remove('show'), 2500);
  }

  window.addIdea = async function() {
    const input = document.getElementById('idea-input');
    const text = input.value.trim();
    if (!text) return;
    const btn = document.querySelector('.idea-add-btn');
    btn.disabled = true;
    btn.textContent = 'Guardando...';
    try {
      const r = await fetch('/api/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Error');
      input.value = '';
      showToast('Idea guardada');
      setTimeout(() => location.reload(), 600);
    } catch(e) { showToast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = 'Guardar idea'; }
  };

  window.promoteIdea = async function(filename) {
    if (!confirm('Promover esta idea a Pending (se compilará en el próximo ciclo)?')) return;
    try {
      const r = await fetch('/api/ideas/promote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Error');
      showToast('Promovida a Pending');
      const card = document.querySelector(\`.idea-card[data-filename="\${filename}"]\`);
      if (card) { card.style.opacity = '0.4'; card.style.pointerEvents = 'none'; }
      setTimeout(() => location.reload(), 800);
    } catch(e) { showToast(e.message, true); }
  };

  window.deleteIdea = async function(filename) {
    if (!confirm('Eliminar esta idea?')) return;
    try {
      const r = await fetch('/api/ideas/' + encodeURIComponent(filename), { method: 'DELETE' });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Error');
      const card = document.querySelector(\`.idea-card[data-filename="\${filename}"]\`);
      if (card) card.remove();
      const remaining = document.querySelectorAll('.idea-card').length;
      const cnt = document.getElementById('ideas-count');
      if (cnt) cnt.textContent = remaining + ' idea' + (remaining !== 1 ? 's' : '');
    } catch(e) { showToast(e.message, true); }
  };

  // Ctrl+Enter to save
  document.getElementById('idea-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); window.addIdea(); }
  });
})();
</script>
`;
  return layout(content, articles, '__ideas', 'Ideas — Second Brain');
}

// ── Server ────────────────────────────────────────────────────────────────────

// ── /config page ─────────────────────────────────────────────────────────────

function handleConfigPage(articles) {
  const content = `
<div class="tasks-header">
  <h1 class="tasks-title">Settings</h1>
</div>
<div class="config-page">

  <section class="config-section">
    <h2 class="config-section-title">LLM Backend</h2>
    <p class="config-desc">Choose how the AI calls are made. <strong>API</strong> charges per token (Anthropic API key required). <strong>Claude Code</strong> uses your Team/Max subscription at no extra cost but is slower.</p>
    <div class="config-toggle-group" id="backend-toggle">
      <button class="config-toggle-btn" data-value="api" id="btn-api">API</button>
      <button class="config-toggle-btn" data-value="claude" id="btn-claude">Claude Code</button>
    </div>
    <p class="config-note" id="claude-note" style="display:none">Claude Code CLI not detected on this machine. The bot on the Pi may still work if <code>claude</code> is installed there.</p>
  </section>

  <section class="config-section">
    <h2 class="config-section-title">Reactive Compilation</h2>
    <p class="config-desc">When enabled, the brain compiles automatically when enough items are pending — no need to wait for the daily cron. Disable to compile only at 7 AM or manually.</p>
    <div class="config-toggle-group" id="reactive-toggle">
      <button class="config-toggle-btn" data-value="false" id="btn-reactive-off">Disabled</button>
      <button class="config-toggle-btn" data-value="true" id="btn-reactive-on">Enabled</button>
    </div>
    <div class="config-reactive-threshold" id="reactive-threshold-row" style="display:none">
      <label class="config-threshold-label" for="threshold-input">Trigger after</label>
      <input class="config-threshold-input" id="threshold-input" type="number" min="1" max="100" value="5">
      <span class="config-threshold-unit">pending items</span>
    </div>
  </section>

  <section class="config-section">
    <h2 class="config-section-title">API Keys</h2>
    <table class="config-keys-table">
      <tbody id="keys-tbody">
        <tr><td class="config-key-name">ANTHROPIC_API_KEY</td><td id="key-anthropic" class="config-key-status">—</td><td class="config-key-desc">Task detection, /ask queries, compilation (API mode)</td></tr>
        <tr><td class="config-key-name">OPENAI_API_KEY</td><td id="key-openai" class="config-key-status">—</td><td class="config-key-desc">Whisper (voice), GPT-4o Vision (photos), semantic search</td></tr>
      </tbody>
    </table>
  </section>

  <div class="config-save-row">
    <button class="config-save-btn" id="save-btn">Save</button>
    <span class="config-save-msg" id="save-msg"></span>
  </div>

</div>

<style>
.config-page { max-width: 640px; padding: 0 0 48px; }
.config-section { margin-bottom: 36px; }
.config-section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted, #888); margin: 0 0 8px; }
.config-desc { font-size: 14px; color: var(--text-secondary, #555); margin: 0 0 16px; line-height: 1.5; }
.config-note { font-size: 12px; color: var(--text-muted, #888); margin: 8px 0 0; }
.config-note code { background: var(--bg-code, #f3f3f3); padding: 1px 4px; border-radius: 3px; }
.config-toggle-group { display: flex; gap: 0; border: 1px solid var(--border, #e0e0e0); border-radius: 6px; width: fit-content; overflow: hidden; }
.config-toggle-btn { padding: 8px 24px; font-size: 14px; font-weight: 500; border: none; background: transparent; color: var(--text, #333); cursor: pointer; transition: background .15s, color .15s; }
.config-toggle-btn.active { background: var(--accent, #1a1a1a); color: #fff; }
.config-toggle-btn:hover:not(.active) { background: var(--bg-hover, #f5f5f5); }
.config-keys-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.config-keys-table td { padding: 10px 12px; border-bottom: 1px solid var(--border, #e8e8e8); vertical-align: middle; }
.config-key-name { font-family: monospace; font-size: 12px; color: var(--text, #333); white-space: nowrap; }
.config-key-status { text-align: center; font-size: 16px; width: 40px; }
.config-key-desc { color: var(--text-secondary, #666); font-size: 13px; }
.config-save-row { display: flex; align-items: center; gap: 16px; margin-top: 24px; }
.config-save-btn { padding: 8px 24px; font-size: 14px; font-weight: 600; background: var(--accent, #1a1a1a); color: #fff; border: none; border-radius: 6px; cursor: pointer; }
.config-save-btn:hover { opacity: .85; }
.config-save-msg { font-size: 13px; color: var(--text-muted, #888); }
.config-save-msg.ok { color: #22a06b; }
.config-save-msg.err { color: #e5393a; }
.config-reactive-threshold { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.config-threshold-label { font-size: 13px; color: var(--text-secondary, #555); }
.config-threshold-input { width: 64px; padding: 6px 8px; font-size: 14px; border: 1px solid var(--border, #e0e0e0); border-radius: 5px; text-align: center; background: var(--bg, #fff); color: var(--text, #333); }
.config-threshold-unit { font-size: 13px; color: var(--text-secondary, #555); }
</style>

<script>
(async function() {
  let current = {};
  try {
    const r = await fetch('/api/config');
    current = await r.json();
  } catch(e) { return; }

  // Backend toggle
  const setBtnActive = (val) => {
    document.querySelectorAll('.config-toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === val);
    });
  };
  setBtnActive(current.llm_backend || 'api');

  async function saveBackend(val) {
    const msg = document.getElementById('save-msg');
    msg.textContent = 'Saving…'; msg.className = 'config-save-msg';
    try {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm_backend: val }),
      });
      const data = await r.json();
      if (data.ok) { msg.textContent = 'Saved'; msg.className = 'config-save-msg ok'; }
      else throw new Error(data.error);
    } catch(e) {
      msg.textContent = 'Error: ' + e.message; msg.className = 'config-save-msg err';
    }
    setTimeout(() => { msg.textContent = ''; msg.className = 'config-save-msg'; }, 2000);
  }

  // Auto-save on toggle click
  document.querySelectorAll('.config-toggle-btn').forEach(b => {
    b.addEventListener('click', () => {
      current.llm_backend = b.dataset.value;
      setBtnActive(b.dataset.value);
      saveBackend(b.dataset.value);
    });
  });

  if (!current.claudeAvailable) {
    document.getElementById('claude-note').style.display = '';
  }

  // Reactive compilation
  const reactiveEnabled = current.reactive_enabled === true;
  const thresholdRow = document.getElementById('reactive-threshold-row');
  const thresholdInput = document.getElementById('threshold-input');
  thresholdInput.value = current.reactive_threshold_items ?? 5;

  const setReactiveActive = (val) => {
    document.querySelectorAll('#reactive-toggle .config-toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === String(val));
    });
    thresholdRow.style.display = val ? '' : 'none';
  };
  setReactiveActive(reactiveEnabled);

  async function saveReactive(enabled, threshold) {
    const msg = document.getElementById('save-msg');
    msg.textContent = 'Saving…'; msg.className = 'config-save-msg';
    try {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reactive_enabled: enabled, reactive_threshold_items: threshold }),
      });
      const data = await r.json();
      if (data.ok) { msg.textContent = 'Saved'; msg.className = 'config-save-msg ok'; }
      else throw new Error(data.error);
    } catch(e) {
      msg.textContent = 'Error: ' + e.message; msg.className = 'config-save-msg err';
    }
    setTimeout(() => { msg.textContent = ''; msg.className = 'config-save-msg'; }, 2000);
  }

  document.querySelectorAll('#reactive-toggle .config-toggle-btn').forEach(b => {
    b.addEventListener('click', () => {
      const enabled = b.dataset.value === 'true';
      current.reactive_enabled = enabled;
      setReactiveActive(enabled);
      saveReactive(enabled, parseInt(thresholdInput.value) || 5);
    });
  });

  thresholdInput.addEventListener('change', () => {
    const v = Math.max(1, parseInt(thresholdInput.value) || 5);
    thresholdInput.value = v;
    current.reactive_threshold_items = v;
    saveReactive(current.reactive_enabled, v);
  });

  // API key status
  const icon = (ok) => ok
    ? '<span style="color:#22a06b" title="Present">&#10003;</span>'
    : '<span style="color:#e5393a" title="Missing">&#10005;</span>';
  document.getElementById('key-anthropic').innerHTML = icon(current.keys?.anthropic);
  document.getElementById('key-openai').innerHTML    = icon(current.keys?.openai);

  document.getElementById('save-btn').addEventListener('click', () => {
    saveBackend(current.llm_backend);
    saveReactive(current.reactive_enabled, parseInt(thresholdInput.value) || 5);
  });
})();
</script>`;

  return layout(content, articles, '__config', 'Settings — Second Brain');
}

// ─────────────────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url   = new URL(req.url, `http://localhost:${PORT}`);
  const path  = decodeURIComponent(url.pathname);

  const articles  = allArticles();
  const backlinks = buildBacklinks(articles);

  let html = null;
  let status = 200;

  if (path === '/' || path === '') {
    html = handleHome(articles, backlinks);

  } else if (path.startsWith('/wiki/')) {
    const slugName = path.slice(6).replace(/\/$/, '');
    html = handleArticle(slugName, articles, backlinks);
    if (!html) {
      html = layout(`<p class="empty">Article <strong>${escHtml(slugName)}</strong> not found yet.</p>`, articles, '');
      status = 404;
    }

  } else if (path === '/timeline') {
    html = buildTimelineHtml(ROOT, layout, articles);

  } else if (path === '/x') {
    html = buildXPageHtml(ROOT, layout, articles, getXBookmarks());

  } else if (path === '/graph') {
    html = buildGraphHtml(ROOT, { wikiBase: '/wiki' }, layout, articles);

  } else if (path === '/search') {
    const q = url.searchParams.get('q');
    html = handleSearch(q, articles) || handleHome(articles, backlinks);

  } else if (path === '/inbox' && req.method === 'GET') {
    html = handleInboxPage(process.env.INGEST_TOKEN || '', articles);

  } else if (path === '/ingest' && req.method === 'GET') {
    res.writeHead(301, { 'Location': '/inbox' }); res.end(); return;

  } else if (path === '/tasks' && req.method === 'GET') {
    html = handleTasksPage(articles);

  } else if (path === '/ideas' && req.method === 'GET') {
    html = handleIdeasPage(articles);

  } else if (path === '/config' && req.method === 'GET') {
    html = handleConfigPage(articles);

  } else if (path === '/pending' && req.method === 'GET') {
    res.writeHead(301, { 'Location': '/inbox' }); res.end(); return;

  } else if (path === '/api/x-bookmarks' && req.method === 'GET') {
    const json = JSON.stringify(getXBookmarks());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(json);
    return;

  } else if (path === '/api/x-search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const apiKey = process.env.OPENAI_API_KEY;
    if (!q.trim() || !apiKey || !xIndexExists(ROOT)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [], semantic: false, noIndex: !xIndexExists(ROOT) }));
      return;
    }
    searchXSemantic(ROOT, q, apiKey)
      .then(results => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results, semantic: true }));
      })
      .catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;

  } else if (path === '/api/x-embed' && req.method === 'POST') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'OPENAI_API_KEY not set' }));
      return;
    }
    buildXIndex(ROOT, apiKey)
      .then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;

  } else if (path === '/api/sync-x' && req.method === 'POST') {
    const syncPath = join(ROOT, 'bin', 'sync-x.mjs');
    if (!existsSync(syncPath)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'sync-x.mjs not found' }));
      return;
    }
    let out = '';
    const child = spawn(process.execPath, [syncPath], { cwd: ROOT, env: process.env });
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Sync timed out (90s). Is Chrome open with X?' }));
    }, 90000);
    child.on('close', code => {
      clearTimeout(timer);
      if (res.headersSent) return;
      // Invalidate cached bookmarks so next /api/x-bookmarks fetch picks up new ones
      _xBookmarks = null;
      const newMatch = out.match(/(\d+) bookmarks saved/);
      const noNewMatch = /No new bookmarks/.test(out);
      const errMatch = code !== 0;
      const newCount = newMatch ? parseInt(newMatch[1]) : (noNewMatch ? 0 : null);
      // Incrementally index new bookmarks if any were added
      const apiKey = process.env.OPENAI_API_KEY;
      if (!errMatch && newCount && apiKey) {
        buildXIndex(ROOT, apiKey).catch(() => { /* non-fatal */ });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: !errMatch,
        newCount,
        output: out.slice(-500),
      }));
    });
    return;

  } else if (path === '/api/status' && req.method === 'GET') {
    try {
      const ps = JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pending: (ps.pending||[]).length, lastCompile: ps.lastCompile||null }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pending: 0, lastCompile: null }));
    }
    return;

  } else if (path === '/api/pending' && req.method === 'GET') {
    try {
      const ps = JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pending: ps.pending||[], lastCompile: ps.lastCompile||null }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pending: [], lastCompile: null }));
    }
    return;

  } else if (path === '/api/compile/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(compileState));
    return;

  } else if (path === '/api/compile/schedule' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let time = '';
      try { time = JSON.parse(body).time || ''; } catch {}
      if (!/^\d{2}:\d{2}$/.test(time)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'time must be HH:MM' }));
        return;
      }
      const scheduledAt = nextOccurrence(time);
      saveSchedule(scheduledAt);
      armSchedule(scheduledAt);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, scheduledAt }));
    });
    return;

  } else if (path === '/api/compile/schedule' && req.method === 'DELETE') {
    clearSchedule();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;

  } else if (path === '/api/compile/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    for (const text of compileState.recentLines) {
      res.write(`event: line\ndata: ${JSON.stringify({ text })}\n\n`);
    }
    if (!compileState.running) { res.end(); return; }
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;

  } else if (path === '/api/compile/preview' && req.method === 'POST') {
    if (compileState.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Compilation in progress' }));
      return;
    }
    const routePath = join(ROOT, 'bin', 'route.mjs');
    const pendingPath = join(ROOT, '.state', 'pending.json');
    const routingPath = join(ROOT, '.state', 'routing.json');

    // Ensure there are pending items
    let pendingItems = [];
    try { pendingItems = JSON.parse(readFileSync(pendingPath, 'utf8')).pending || []; } catch {}
    if (pendingItems.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items: [], summary: { update: 0, create: 0, affected: 0 } }));
      return;
    }

    // Run routing synchronously (pure Node.js, ~1-2s, no LLM)
    try {
      const { execFileSync: execRoute } = await import('child_process');
      execRoute(process.execPath, [routePath, '--skip-llm'], { cwd: ROOT, stdio: 'pipe' });
    } catch { /* routing failure is non-fatal — return stale routing if available */ }

    let routes = [];
    try { routes = JSON.parse(readFileSync(routingPath, 'utf8')).routes || []; } catch {}

    const routeMap = new Map(routes.map(r => [r.path, r]));
    let updateCount = 0, createCount = 0;
    const affectedArticles = new Set();

    const items = pendingItems.map(item => {
      const route = routeMap.get(item.path);
      const action = route?.routing?.action ?? 'unknown';
      const articles = route?.routing?.articles ?? [];
      if (action === 'update') updateCount++;
      else if (action === 'create') createCount++;
      else if (action === 'both') { updateCount++; createCount++; }
      articles.forEach(a => affectedArticles.add(a));
      return { path: item.path, type: item.type, action, articles };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      items,
      summary: { update: updateCount, create: createCount, affected: affectedArticles.size },
    }));
    return;

  } else if (path === '/api/compile-capabilities' && req.method === 'GET') {
    const modes = ['api'];
    if (claudeAvailable) modes.push('claude');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ modes, default: 'api' }));
    return;

  } else if (path === '/api/compile' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      // Mode comes from server config (set in Settings), not from the request body
      const cfg = readConfig(ROOT);
      const mode = (cfg.llm_backend === 'claude' && claudeAvailable) ? 'claude' : 'api';

      if (mode === 'claude' && !claudeAvailable) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Claude Code CLI not available on this machine' }));
        return;
      }

      const script = mode === 'claude' ? 'compile.mjs' : 'compile-lite.mjs';
      const compilePath = join(ROOT, 'bin', script);
      if (!existsSync(compilePath)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `${script} not found` }));
        return;
      }
      if (compileState.running) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Compilation already in progress' }));
        return;
      }

      let pendingCount = 0;
      try {
        const ps = JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8'));
        pendingCount = (ps.pending || []).length;
      } catch {}
      const beforeSnapshot = snapshotWikiSizes();

      const child = spawn(process.execPath, [compilePath], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      compileState.running = true;
      compileState.pid = child.pid;
      compileState.mode = mode;
      compileState.startedAt = new Date().toISOString();
      compileState.pendingCount = pendingCount;
      compileState.recentLines = [];

      function handleLine(line) {
        const text = line.trimEnd();
        if (!text) return;
        compileState.recentLines.push(text);
        if (compileState.recentLines.length > MAX_RECENT_LINES) compileState.recentLines.shift();
        sseBroadcast('line', { text });
      }
      child.stdout.on('data', buf => buf.toString().split('\n').forEach(handleLine));
      child.stderr.on('data', buf => buf.toString().split('\n').forEach(handleLine));
      child.on('close', code => {
        const durationMs = Date.now() - new Date(compileState.startedAt).getTime();
        compileState.lastDuration = { durationMs, pendingCount: compileState.pendingCount, mode: compileState.mode };

        const afterSnapshot = snapshotWikiSizes();
        const allFiles = new Set([...Object.keys(beforeSnapshot), ...Object.keys(afterSnapshot)]);
        const diff = [];
        for (const f of allFiles) {
          const before = beforeSnapshot[f] ?? 0;
          const after = afterSnapshot[f] ?? 0;
          if (before !== after) diff.push({ file: f, before, after, isNew: before === 0 });
        }
        compileState.diff = diff;
        compileState.running = false;
        compileState.pid = null;
        let remainingCount = 0;
        try {
          const ps = JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8'));
          remainingCount = (ps.pending || []).length;
        } catch {}
        sseBroadcast('done', { code, mode: compileState.mode, diff, remainingCount });
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: child.pid, mode }));
    });
    return;

  } else if (path === '/api/pending/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { path: itemPath } = JSON.parse(body);
        if (!itemPath) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing path' })); return; }
        const stateFile = join(ROOT, '.state', 'pending.json');
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        state.pending = (state.pending || []).filter(i => i.path !== itemPath);
        writeFileSync(stateFile, JSON.stringify(state, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;

  } else if (path === '/api/today' && req.method === 'GET') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getTodayWithCarryover(ROOT)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;

  } else if (path === '/api/today' && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(saveTodayData(ROOT, data)));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;

  } else if (path === '/api/today/upcoming' && req.method === 'GET') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getUpcoming(ROOT)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;

  } else if (path === '/api/today/postpone' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { taskId, targetDate } = JSON.parse(body);
        if (!taskId || !targetDate) throw new Error('Missing taskId or targetDate');
        postponeTask(ROOT, taskId, targetDate);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;

  } else if (path === '/api/today/pull' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { taskId, fromDate } = JSON.parse(body);
        if (!taskId || !fromDate) throw new Error('Missing taskId or fromDate');
        pullToToday(ROOT, taskId, fromDate);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;

  } else if (path === '/api/tasks/add' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { text, due } = JSON.parse(body);
        if (!text || !due) throw new Error('Missing text or due');
        const dueDate = new Date((/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(due) ? due + ':00' : due));
        if (isNaN(dueDate.getTime())) throw new Error('Invalid due date');
        const result = saveTask(ROOT, text, dueDate);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;

  } else if (path === '/api/tasks/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { taskId } = JSON.parse(body);
        if (!taskId) throw new Error('Missing taskId');
        const removed = removeTaskById(ROOT, taskId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: removed }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;

  } else if (path === '/api/ideas' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        if (!text?.trim()) throw new Error('text is required');
        const result = await ingestIdea(ROOT, text.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: result.path }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;

  } else if (path === '/api/ideas/promote' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { filename } = JSON.parse(body);
        if (!filename) throw new Error('filename is required');
        // Sanitize: no path traversal
        if (filename.includes('/') || filename.includes('..')) throw new Error('invalid filename');
        const srcPath = join(ROOT, 'raw', 'ideas', filename);
        if (!existsSync(srcPath)) throw new Error('idea not found');
        // Read the idea content
        let content = readFileSync(srcPath, 'utf8');
        // Write to raw/notes/ with today's date prefix
        const destFilename = today() + '-' + filename.replace(/^\d{4}-\d{2}-\d{2}-/, '');
        const destPath = join(ROOT, 'raw', 'notes', destFilename);
        // Update frontmatter: type=note, status=pending
        content = content.replace(/^type: idea$/m, 'type: note');
        if (!/^status:/m.test(content)) {
          content = content.replace(/^---\n/, `---\nstatus: pending\n`);
        } else {
          content = content.replace(/^status: .+$/m, 'status: pending');
        }
        writeFileSync(destPath, content);
        // Add to pending.json
        const state = readPending(ROOT);
        state.pending.push({ path: `raw/notes/${destFilename}`, type: 'note', added: new Date().toISOString() });
        writePending(ROOT, state);
        // Delete original idea
        unlinkSync(srcPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, dest: `raw/notes/${destFilename}` }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;

  } else if (path.startsWith('/api/ideas/') && req.method === 'DELETE') {
    try {
      const filename = decodeURIComponent(path.slice('/api/ideas/'.length));
      if (!filename || filename.includes('/') || filename.includes('..')) throw new Error('invalid filename');
      const ideaPath = join(ROOT, 'raw', 'ideas', filename);
      if (!existsSync(ideaPath)) throw new Error('idea not found');
      unlinkSync(ideaPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;

  } else if (path === '/api/config' && req.method === 'GET') {
    const cfg = readConfig(ROOT);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...cfg,
      keys: {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai:    !!process.env.OPENAI_API_KEY,
      },
      claudeAvailable,
    }));
    return;

  } else if (path === '/api/config' && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        const allowed = ['llm_backend', 'reactive_enabled', 'reactive_threshold_items'];
        const safe = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
        // Coerce types
        if ('reactive_enabled' in safe) safe.reactive_enabled = Boolean(safe.reactive_enabled);
        if ('reactive_threshold_items' in safe) safe.reactive_threshold_items = Math.max(1, parseInt(safe.reactive_threshold_items, 10) || 5);
        const updated = writeConfig(ROOT, safe);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config: updated }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;

  } else if (path === '/api/ingest' && req.method === 'POST') {
    handleIngestApi(req, res);
    return;

  } else if (path === '/api/transcribe' && req.method === 'POST') {
    // Transcribe audio without saving — returns { text } for preview in textarea
    try {
      const { buffer, filename } = await new Promise((resolve, reject) => {
        const bb = busboy({ headers: req.headers });
        bb.on('file', (field, stream, info) => {
          const chunks = [];
          stream.on('data', d => chunks.push(d));
          stream.on('end', () => resolve({ buffer: Buffer.concat(chunks), filename: info.filename }));
        });
        bb.on('error', reject);
        req.pipe(bb);
      });
      const text = await transcribeAudio(getOpenAI(), buffer, filename);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
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

  } else if (path.startsWith('/static/')) {
    const staticPath = join(__dirname, 'public', path.slice(8));
    if (existsSync(staticPath)) {
      const mimes = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
      const mime = mimes[extname(staticPath)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(readFileSync(staticPath));
    } else {
      res.writeHead(404); res.end('Not found');
    }
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
  // Re-arm any pending schedule that survived a server restart
  const saved = loadSchedule();
  if (saved?.scheduledAt) armSchedule(saved.scheduledAt);
});
