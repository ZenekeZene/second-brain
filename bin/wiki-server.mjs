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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { marked } from 'marked';
import { buildTimelineHtml } from './lib/timeline.mjs';
import { buildGraphHtml } from './lib/graph.mjs';

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
  return readdirSync(WIKI_DIR)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
    .map(f => {
      const s = slug(f);
      const content = readFileSync(join(WIKI_DIR, f), 'utf8');
      const { meta } = parseFrontmatter(content);
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const summaryMatch = content.match(/^>\s+(.+)$/m);
      const mtime = statSync(join(WIKI_DIR, f)).mtime;
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
    </nav>
    <div id="search-wrap">
      <input id="search" type="search" placeholder="Search articles..." autocomplete="off"
             value="" oninput="filterList(this.value)">
    </div>
    <div id="article-list">${listItems}</div>
  </nav>
  <main id="content">${content}</main>
  <script>
    function filterList(q) {
      q = q.toLowerCase();
      document.querySelectorAll('.article-item').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }
    // Restore search from sessionStorage
    const q = sessionStorage.getItem('search') || '';
    const inp = document.getElementById('search');
    if (q) { inp.value = q; filterList(q); }
    inp.addEventListener('input', e => sessionStorage.setItem('search', e.target.value));
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
           background: #f8f9fa; color: #1a1a1a; display: flex; justify-content: center;
           align-items: flex-start; min-height: 100vh; padding: 48px 16px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
            padding: 32px; width: 100%; max-width: 520px; }
    h1 { font-size: 22px; margin-bottom: 6px; }
    .subtitle { color: #6b7280; font-size: 14px; margin-bottom: 28px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #374151; }
    select, textarea { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db;
                       border-radius: 8px; font-size: 14px; font-family: inherit;
                       outline: none; transition: border-color .15s; }
    select:focus, textarea:focus { border-color: #2563eb; }
    textarea { resize: vertical; min-height: 100px; }
    .field { margin-bottom: 20px; }
    button { width: 100%; padding: 12px; background: #2563eb; color: #fff;
             border: none; border-radius: 8px; font-size: 15px; font-weight: 600;
             cursor: pointer; transition: background .15s; }
    button:hover { background: #1d4ed8; }
    button:disabled { background: #93c5fd; cursor: not-allowed; }
    #status { margin-top: 16px; padding: 12px 16px; border-radius: 8px;
              font-size: 14px; display: none; }
    #status.ok  { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
    #status.err { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .back { display: block; text-align: center; margin-top: 20px; font-size: 13px; color: #6b7280; }
    .back a { color: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Add to Brain</h1>
    <p class="subtitle">Save a URL, note, or bookmark to your second brain.</p>
    <div class="field">
      <label for="type">Type</label>
      <select id="type">
        <option value="url">Article (fetch full content)</option>
        <option value="bookmark">Bookmark (save URL for later)</option>
        <option value="note">Note (free text)</option>
      </select>
    </div>
    <div class="field">
      <label for="content" id="content-label">URL</label>
      <textarea id="content" placeholder="https://..."></textarea>
    </div>
    <button id="btn" onclick="submit()">Save</button>
    <div id="status"></div>
    <p class="back"><a href="/">← Back to wiki</a></p>
  </div>
  <script>
    ${tokenScript}
    const labels = { url: 'URL', bookmark: 'URL', note: 'Note text' };
    const placeholders = { url: 'https://...', bookmark: 'https://...', note: 'Write your note here...' };
    document.getElementById('type').addEventListener('change', e => {
      document.getElementById('content-label').textContent = labels[e.target.value];
      document.getElementById('content').placeholder = placeholders[e.target.value];
    });
    async function submit() {
      const type = document.getElementById('type').value;
      const content = document.getElementById('content').value.trim();
      const btn = document.getElementById('btn');
      const status = document.getElementById('status');
      if (!content) { showStatus('err', 'Content is required.'); return; }
      btn.disabled = true;
      btn.textContent = 'Saving…';
      status.style.display = 'none';
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (INGEST_TOKEN) headers['Authorization'] = 'Bearer ' + INGEST_TOKEN;
        const res = await fetch('/api/ingest', {
          method: 'POST',
          headers,
          body: JSON.stringify({ type, content }),
        });
        const data = await res.json();
        if (res.ok) {
          showStatus('ok', data.message || 'Saved successfully.');
          document.getElementById('content').value = '';
        } else {
          showStatus('err', data.error || 'Error saving.');
        }
      } catch (e) {
        showStatus('err', 'Network error.');
      }
      btn.disabled = false;
      btn.textContent = 'Save';
    }
    function showStatus(type, msg) {
      const el = document.getElementById('status');
      el.className = type;
      el.textContent = msg;
      el.style.display = 'block';
    }
  </script>
</body>
</html>`;
}

function handleIngestApi(req, res, ROOT) {
  const token = process.env.INGEST_TOKEN;
  if (token) {
    const auth = req.headers['authorization'] || req.headers['x-ingest-token'] || '';
    const provided = auth.replace(/^Bearer\s+/i, '');
    if (provided !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { type, content } = parsed;
    if (!type || !content) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'type and content are required' }));
      return;
    }
    if (!['url', 'note', 'bookmark'].includes(type)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'type must be url, note, or bookmark' }));
      return;
    }

    try {
      execFileSync(process.execPath, [join(ROOT, 'bin', 'ingest.mjs'), type, content], {
        cwd: ROOT,
        stdio: 'pipe',
      });
      const labels = { url: 'Article saved', note: 'Note saved', bookmark: 'Bookmark saved' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `${labels[type]} — pending compilation.` }));
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

/** Inject a persistent top nav bar into standalone (dark) HTML pages */
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

  } else if (path === '/api/ingest' && req.method === 'POST') {
    handleIngestApi(req, res, ROOT);
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
