/**
 * Chronological feed — what happened in the brain each day.
 * Shows wiki articles compiled/updated + raw items ingested, grouped by date (reverse-chrono).
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseFm(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const meta = {};
  for (const line of m[1].split('\n')) {
    const [k, ...v] = line.split(':');
    if (k && v.length) meta[k.trim()] = v.join(':').trim();
  }
  const tagsMatch = m[1].match(/^tags:\s*\[([^\]]*)\]/m);
  meta.tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean) : [];
  return meta;
}

function escH(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function slugToTitle(slug) {
  return slug.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ');
}

// ── Backward-compat exports (unused externally, kept for safety) ──────────────

export function collectItems(ROOT) {
  const items = [];
  for (const dir of ['articles','notes','bookmarks','files','images','x-bookmarks']) {
    const fullDir = join(ROOT, 'raw', dir);
    if (!existsSync(fullDir)) continue;
    for (const f of readdirSync(fullDir).filter(f => f.endsWith('.md'))) {
      try {
        const content = readFileSync(join(fullDir, f), 'utf8');
        const meta    = parseFm(content);
        const date    = (meta.ingested || '').slice(0, 10);
        if (date) items.push({ date, type: meta.type || dir.replace(/s$/, ''), tags: meta.tags || [] });
      } catch { /* skip */ }
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

export function collectWikiItems(ROOT) {
  const wikiDir = join(ROOT, 'wiki');
  if (!existsSync(wikiDir)) return [];
  return readdirSync(wikiDir)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
    .map(f => {
      const content = readFileSync(join(wikiDir, f), 'utf8');
      const meta    = parseFm(content);
      return { slug: f.replace(/\.md$/, ''), created: meta.created, updated: meta.updated, tags: meta.tags || [] };
    });
}

// ── Feed data builder ─────────────────────────────────────────────────────────

function collectFeedData(ROOT) {
  const byDate = {};

  function day(d) {
    if (!byDate[d]) byDate[d] = { wiki: [], articles: [], notes: [], bookmarks: 0, xbookmarks: 0, other: 0 };
    return byDate[d];
  }

  // Wiki articles: created / updated events
  const wikiDir = join(ROOT, 'wiki');
  if (existsSync(wikiDir)) {
    for (const f of readdirSync(wikiDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md')) {
      try {
        const slug    = f.replace(/\.md$/, '');
        const content = readFileSync(join(wikiDir, f), 'utf8');
        const meta    = parseFm(content);
        const titleM  = content.match(/^#\s+(.+)$/m);
        const title   = titleM ? titleM[1].trim() : slug;

        if (meta.created) {
          day(meta.created).wiki.push({ slug, title, action: 'created' });
        }
        if (meta.updated && meta.updated !== meta.created) {
          day(meta.updated).wiki.push({ slug, title, action: 'updated' });
        }
      } catch { /* skip */ }
    }
  }

  // Raw items
  const RAW_DIRS = ['articles', 'notes', 'bookmarks', 'files', 'images', 'x-bookmarks'];
  for (const dir of RAW_DIRS) {
    const fullDir = join(ROOT, 'raw', dir);
    if (!existsSync(fullDir)) continue;

    for (const f of readdirSync(fullDir)) {
      try {
        // x-bookmarks: JSONL files — count entries
        if (f.endsWith('.jsonl')) {
          const lines = readFileSync(join(fullDir, f), 'utf8').split('\n').filter(l => l.trim());
          const date  = f.slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(date) && lines.length) {
            day(date).xbookmarks += lines.length;
          }
          continue;
        }
        if (!f.endsWith('.md')) continue;

        const content = readFileSync(join(fullDir, f), 'utf8');
        const meta    = parseFm(content);
        const date    = (meta.ingested || '').slice(0, 10);
        if (!date) continue;

        const type = meta.type || dir.replace(/s$/, '');
        const d    = day(date);

        if (type === 'article') {
          const title = meta.title
            ? meta.title.replace(/^["']|["']$/g, '') // strip surrounding quotes
            : slugToTitle(f.replace(/\.md$/, ''));
          const source = meta.source || '';
          d.articles.push({ title, source });

        } else if (type === 'note') {
          const body    = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
          const snippet = body.slice(0, 160).replace(/\n+/g, ' ');
          d.notes.push(snippet);

        } else if (type === 'bookmark') {
          const count = (content.match(/^- \[ \]/gm) || []).length || 1;
          d.bookmarks += count;

        } else if (type === 'x-bookmark') {
          d.xbookmarks += 1;

        } else {
          d.other += 1;
        }
      } catch { /* skip */ }
    }
  }

  return Object.entries(byDate)
    .filter(([, d]) => d.wiki.length || d.articles.length || d.notes.length || d.bookmarks || d.xbookmarks || d.other)
    .sort(([a], [b]) => b.localeCompare(a));
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function renderFeed(feedEntries) {
  if (!feedEntries.length) {
    return '<p class="feed-empty">No activity recorded yet.</p>';
  }

  return feedEntries.map(([date, d]) => {
    const parts = [];

    // Wiki events
    if (d.wiki.length) {
      // Sort: created first, then updated
      const sorted = [...d.wiki].sort((a, b) => a.action.localeCompare(b.action));
      const items  = sorted.map(({ slug, title, action }) =>
        `<span class="feed-wiki-item">
          <a href="/wiki/${escH(slug)}" class="feed-wiki-link">${escH(title)}</a><span class="feed-action">${action === 'created' ? 'new' : 'updated'}</span>
        </span>`
      ).join('');
      parts.push(`<div class="feed-section">
        <span class="feed-label">Wiki</span>
        <div class="feed-wiki-items">${items}</div>
      </div>`);
    }

    // Ingested articles
    if (d.articles.length) {
      const items = d.articles.map(({ title, source }) => {
        const label = escH(title.length > 90 ? title.slice(0, 88) + '…' : title);
        return source
          ? `<div class="feed-article"><a href="${escH(source)}" class="feed-raw-link" target="_blank" rel="noopener">${label}</a></div>`
          : `<div class="feed-article">${label}</div>`;
      }).join('');
      parts.push(`<div class="feed-section">
        <span class="feed-label">Articles</span>
        <div class="feed-article-list">${items}</div>
      </div>`);
    }

    // Ingested notes
    if (d.notes.length) {
      const items = d.notes.map(snippet =>
        `<div class="feed-note">«${escH(snippet)}${snippet.length >= 160 ? '…' : ''}»</div>`
      ).join('');
      parts.push(`<div class="feed-section">
        <span class="feed-label">Notes</span>
        <div class="feed-note-list">${items}</div>
      </div>`);
    }

    // Counts (bookmarks, x-bookmarks, other)
    const counts = [];
    if (d.bookmarks)  counts.push(`${d.bookmarks} bookmark${d.bookmarks  > 1 ? 's' : ''}`);
    if (d.xbookmarks) counts.push(`${d.xbookmarks} x-bookmark${d.xbookmarks > 1 ? 's' : ''}`);
    if (d.other)      counts.push(`${d.other} other`);
    if (counts.length) {
      parts.push(`<div class="feed-section">
        <span class="feed-label">Saved</span>
        <span class="feed-counts">${escH(counts.join(' · '))}</span>
      </div>`);
    }

    return `<div class="feed-day">
      <div class="feed-date-bar">
        <span class="feed-date">${escH(formatDate(date))}</span>
        <span class="feed-date-iso">${escH(date)}</span>
      </div>
      ${parts.join('\n')}
    </div>`;
  }).join('\n');
}

// ── Full HTML page ────────────────────────────────────────────────────────────

export function buildTimelineHtml(ROOT, layoutFn, articles) {
  const feedEntries = collectFeedData(ROOT);
  const today       = new Date().toISOString().slice(0, 10);
  const totalDays   = feedEntries.length;
  const totalWiki   = feedEntries.reduce((n, [, d]) => n + d.wiki.length, 0);
  const totalRaw    = feedEntries.reduce((n, [, d]) => n + d.articles.length + d.notes.length + d.bookmarks + d.xbookmarks + d.other, 0);

  const innerContent = `
<div class="feed-header">
  <h1 class="feed-title">Feed</h1>
  <p class="feed-subtitle">${totalDays} active days · ${totalWiki} wiki events · ${totalRaw} items ingested</p>
</div>
<div class="feed-list">
  ${renderFeed(feedEntries)}
</div>`;

  // Server mode (sidebar layout)
  if (layoutFn) return layoutFn(innerContent, articles || [], '__timeline', 'Feed — Second Brain');

  // Standalone fallback (CLI: bin/timeline.mjs)
  const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">`;
  const topNavHtml = `<nav class="top-nav">
    <a href="/" class="top-nav-brand">Second Brain</a>
    <span class="top-nav-sep">|</span>
    <a href="/">Articles</a>
    <a href="/graph">Graph</a>
    <a href="/timeline" class="active">Feed</a>
    <a href="/ingest">Ingest</a>
    <a href="/tasks">Tasks</a>
    <a href="/pending">Pending</a>
  </nav>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Feed — Second Brain</title>
  ${FONTS}
  <link rel="stylesheet" href="/static/style.css">
</head>
<body class="top-nav-body">
  ${topNavHtml}
  <div class="timeline-container">${innerContent}</div>
</body>
</html>`;
}
