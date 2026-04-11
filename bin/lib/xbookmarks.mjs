/**
 * X/Twitter bookmark loader.
 * Reads JSONL files from raw/x-bookmarks/, strips fields, sorts newest first.
 * Called at startup; result cached in wiki-server.mjs memory.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const FT_MEDIA_DIR = join(homedir(), '.ft-bookmarks', 'media');

function unescapeHtml(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Build tweetId → first local media filename from ~/.ft-bookmarks/media/
function buildMediaMap() {
  if (!existsSync(FT_MEDIA_DIR)) return {};
  const map = {};
  for (const f of readdirSync(FT_MEDIA_DIR)) {
    const m = f.match(/^(\d+)-[a-f0-9]+\.(jpg|jpeg|png|gif|webp)$/i);
    if (m && !map[m[1]]) map[m[1]] = f; // keep first image per tweet
  }
  return map;
}

// Build a map of tweetId → wiki article slug by scanning wiki/ for tweet URLs.
function buildTweetArticleMap(ROOT) {
  const wikiDir = join(ROOT, 'wiki');
  const map = {};
  if (!existsSync(wikiDir)) return map;
  for (const f of readdirSync(wikiDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md')) {
    try {
      const content = readFileSync(join(wikiDir, f), 'utf8');
      for (const m of content.matchAll(/https:\/\/x\.com\/[^\/\s]+\/status\/(\d+)/g)) {
        map[m[1]] = f.replace(/\.md$/, '');
      }
    } catch { /* skip */ }
  }
  return map;
}

export function loadXBookmarks(ROOT) {
  const dir = join(ROOT, 'raw', 'x-bookmarks');
  if (!existsSync(dir)) return [];

  const articleMap = buildTweetArticleMap(ROOT);
  const mediaMap   = buildMediaMap();

  const tweets = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    let lines;
    try { lines = readFileSync(join(dir, f), 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        const id = t.id || t.tweetId || '';
        tweets.push({
          id,
          url:                   t.url || '',
          text:                  unescapeHtml(t.text || t.full_text || ''),
          authorHandle:          t.authorHandle || t.author_handle || '',
          authorName:            t.authorName   || t.author_name   || '',
          authorProfileImageUrl: t.authorProfileImageUrl || '',
          postedAt:              t.postedAt || '',
          link:                  (t.links && t.links[0]) || '',
          likeCount:             t.likeCount    || 0,
          bookmarkCount:         t.bookmarkCount || 0,
          mediaCount:            t.mediaCount   || 0,
          mediaFile:             mediaMap[id]   || '',
          article:               articleMap[id] || '',
        });
      } catch { /* skip malformed line */ }
    }
  }

  // Sort newest first (postedAt: "Mon Apr 06 19:29:48 +0000 2026")
  return tweets.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
}

// ── Page HTML ─────────────────────────────────────────────────────────────────

export function buildXPageHtml(ROOT, layoutFn, articles, cachedTweets) {
  const tweets = cachedTweets || loadXBookmarks(ROOT);
  const total  = tweets.length;

  // Client-side JS uses string concatenation to avoid template-literal escaping issues
  const innerContent = `
<div class="xbm-wrap">
  <div class="xbm-header">
    <div class="xbm-header-row">
      <div>
        <h1 class="xbm-title">X Bookmarks</h1>
        <p class="xbm-subtitle" id="xbm-subtitle">${total.toLocaleString()} saved</p>
      </div>
    </div>
    <input class="xbm-search" id="xbm-search" type="search" placeholder="Search tweets, authors..." autocomplete="off" spellcheck="false">
  </div>

  <div id="xbm-grid" class="xbm-grid"></div>

  <div id="xbm-footer" class="xbm-footer">
    <button id="xbm-more" class="xbm-more-btn" style="display:none">Load more</button>
    <span id="xbm-count" class="xbm-count"></span>
  </div>
</div>

<script>
(function() {
  var PAGE = 60;
  var all = [], filtered = [], shown = 0;

  function fmt(n) {
    if (!n) return '';
    if (n >= 1000000) return (n/1000000).toFixed(1).replace('.0','') + 'M';
    if (n >= 1000)    return (n/1000).toFixed(1).replace('.0','') + 'k';
    return String(n);
  }

  function fmtDate(str) {
    if (!str) return '';
    var d = new Date(str);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function domain(url) {
    try { return new URL(url).hostname.replace(/^www\\./, ''); } catch(e) { return ''; }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function card(t) {
    var date = fmtDate(t.postedAt);
    var dom  = t.link ? domain(t.link) : '';
    var init = (t.authorHandle || 'X').slice(0,1).toUpperCase();
    var likes = fmt(t.likeCount);
    var saves = fmt(t.bookmarkCount);

    // Avatar: fallback initials always visible, image sits on top. onerror removes image revealing fallback.
    var avatarHtml = '<div class="xbm-av">'
      + '<span class="xbm-av-fb">' + esc(init) + '</span>'
      + (t.authorProfileImageUrl ? '<img class="xbm-av-img" src="' + esc(t.authorProfileImageUrl) + '" alt="" loading="lazy" onerror="this.remove()">' : '')
      + '</div>';

    var statsHtml = '';
    if (likes) statsHtml += '<span class="xbm-stat">' + esc(likes) + ' likes</span>';
    if (saves) statsHtml += '<span class="xbm-stat">' + esc(saves) + ' saves</span>';

    var articleBadge = t.article
      ? '<span class="xbm-article-badge" data-href="/wiki/' + esc(t.article) + '">' + esc(t.article) + '</span>'
      : '';

    var mediaHtml = t.mediaFile
      ? '<div class="xbm-img-wrap"><img class="xbm-img" src="/xmedia/' + esc(t.mediaFile) + '" alt="" loading="lazy"></div>'
      : (t.mediaCount && !t.mediaFile ? '<div class="xbm-img-placeholder">' + t.mediaCount + ' media</div>' : '');

    return '<a class="xbm-card' + (t.mediaFile ? ' has-media' : '') + '" href="' + esc(t.url) + '" target="_blank" rel="noopener">'
      + '<div class="xbm-card-top">'
        + '<div class="xbm-author">' + avatarHtml + '<span class="xbm-handle">@' + esc(t.authorHandle) + '</span></div>'
        + '<span class="xbm-date">' + esc(date) + '</span>'
      + '</div>'
      + (mediaHtml ? mediaHtml : '')
      + '<div class="xbm-text">' + esc(t.text) + '</div>'
      + '<div class="xbm-card-bottom">'
        + (dom ? '<span class="xbm-domain">' + esc(dom) + '</span>' : '<span></span>')
        + '<span class="xbm-stats">' + statsHtml + '</span>'
      + '</div>'
      + (articleBadge ? '<div class="xbm-card-article">' + articleBadge + '</div>' : '')
      + '</a>';
  }

  function render(reset) {
    var grid = document.getElementById('xbm-grid');
    if (reset) { grid.innerHTML = ''; shown = 0; }
    var batch = filtered.slice(shown, shown + PAGE);
    if (batch.length) grid.insertAdjacentHTML('beforeend', batch.map(card).join(''));
    shown += batch.length;
    var countEl = document.getElementById('xbm-count');
    var moreBtn = document.getElementById('xbm-more');
    var subtitle = document.getElementById('xbm-subtitle');
    if (countEl) countEl.textContent = shown + ' / ' + filtered.length;
    if (moreBtn) moreBtn.style.display = shown >= filtered.length ? 'none' : '';
    if (subtitle && filtered.length !== ${total}) subtitle.textContent = filtered.length + ' matching';
    if (subtitle && filtered.length === ${total}) subtitle.textContent = '${total.toLocaleString()} saved';
  }

  function init() {
    fetch('/api/x-bookmarks', { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        all = data;
        filtered = all;
        render(true);
      })
      .catch(function() {
        document.getElementById('xbm-grid').innerHTML = '<p class="xbm-error">Could not load bookmarks.</p>';
      });
  }

  var searchTimer;
  document.getElementById('xbm-search').addEventListener('input', function(e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function() {
      var q = e.target.value.toLowerCase().trim();
      if (!q) {
        filtered = all;
      } else {
        filtered = all.filter(function(t) {
          return t.text.toLowerCase().indexOf(q) !== -1
            || t.authorHandle.toLowerCase().indexOf(q) !== -1
            || t.authorName.toLowerCase().indexOf(q) !== -1;
        });
      }
      render(true);
    }, 250);
  });

  document.getElementById('xbm-more').addEventListener('click', function() { render(false); });

  // Article badge clicks — stop the outer card link and navigate to the wiki article
  document.getElementById('xbm-grid').addEventListener('click', function(e) {
    var badge = e.target.closest('.xbm-article-badge');
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    window.location.href = badge.getAttribute('data-href');
  });

  init();
})();
</script>`;

  if (layoutFn) return layoutFn(innerContent, articles || [], '__x', 'X Bookmarks — Second Brain', { contentClass: 'content-x' });

  // Standalone fallback
  const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>X Bookmarks — Second Brain</title>
  ${FONTS}
  <link rel="stylesheet" href="/static/style.css">
</head>
<body class="app-shell">
  ${innerContent}
</body>
</html>`;
}
