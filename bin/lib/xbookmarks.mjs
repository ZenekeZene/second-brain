/**
 * X/Twitter bookmark loader.
 * Reads JSONL files from raw/x-bookmarks/, strips fields, sorts newest first.
 * Called at startup; result cached in wiki-server.mjs memory.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

function unescapeHtml(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Extract a tweet ID from an x.com /status/ link.
// Twitter Articles (x.com/i/article/...) are NOT embeddable via createTweet — excluded.
function extractLinkedTweetId(links) {
  const link = links && links[0];
  if (!link) return '';
  const m = link.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/);
  return m ? m[1] : '';
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
          linkedTweetId:         extractLinkedTweetId(t.links),
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
    <div class="xbm-header-top">
      <h1 class="xbm-title">X Bookmarks</h1>
      <p class="xbm-subtitle" id="xbm-subtitle">${total.toLocaleString()} saved</p>
    </div>
    <div class="xbm-toolbar">
      <input class="xbm-search" id="xbm-search" type="search" placeholder="Search tweets, authors..." autocomplete="off" spellcheck="false">
      <select id="xbm-article-filter" class="xbm-filter-select">
        <option value="">All tweets</option>
      </select>
      <button id="xbm-sort-btn" class="xbm-sort-btn" data-order="desc">Newest first</button>
      <button id="xbm-sync-btn" class="xbm-sync-btn">Sync</button>
    </div>
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
  var sortOrder = 'desc';   // 'desc' = newest first, 'asc' = oldest first
  var filterArticle = '';   // '' = all, otherwise article slug

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
    var articleBadge = t.article
      ? '<span class="xbm-article-badge" data-href="/wiki/' + esc(t.article) + '">' + esc(t.article) + '</span>'
      : '';

    // Media tweet: embed placeholder — widgets.js fills it lazily
    if (t.mediaCount) {
      return '<div class="xbm-card xbm-embed-card" data-id="' + esc(t.id) + '" data-url="' + esc(t.url) + '">'
        + '<div class="xbm-embed-slot"></div>'
        + (articleBadge ? '<div class="xbm-card-article">' + articleBadge + '</div>' : '')
        + '</div>';
    }

    // Text-only tweet: custom card
    var date        = fmtDate(t.postedAt);
    var dom         = t.link ? domain(t.link) : '';
    var isArticle   = t.link.indexOf('/i/article/') !== -1;
    var articleLink = isArticle ? '<span class="xbm-tw-article-badge" data-href="' + esc(t.link) + '">Article</span>' : '';
    var init = (t.authorHandle || 'X').slice(0,1).toUpperCase();

    var avatarHtml = '<div class="xbm-av">'
      + '<span class="xbm-av-fb">' + esc(init) + '</span>'
      + (t.authorProfileImageUrl ? '<img class="xbm-av-img" src="' + esc(t.authorProfileImageUrl) + '" alt="" loading="lazy" onerror="this.remove()">' : '')
      + '</div>';

    var cardInner = '<a class="xbm-card-link" href="' + esc(t.url) + '" target="_blank" rel="noopener">'
      + '<div class="xbm-card-top">'
        + '<div class="xbm-author">' + avatarHtml + '<span class="xbm-handle">@' + esc(t.authorHandle) + '</span></div>'
        + '<span class="xbm-date">' + esc(date) + '</span>'
      + '</div>'
      + '<div class="xbm-text">' + esc(t.text) + '</div>'
      + (dom && !t.linkedTweetId ? '<div class="xbm-card-bottom"><span class="xbm-domain">' + esc(dom) + '</span></div>' : '')
      + (articleBadge ? '<div class="xbm-card-article">' + articleBadge + '</div>' : '')
      + '</a>';

    if (!t.linkedTweetId) {
      // Simple text card: keep as <a> for full clickability
      var bottomRow = (articleLink || dom || articleBadge)
        ? '<div class="xbm-card-bottom">'
            + (articleLink ? articleLink : (dom ? '<span class="xbm-domain">' + esc(dom) + '</span>' : ''))
            + (articleBadge ? articleBadge : '')
          + '</div>'
        : '';
      return '<a class="xbm-card" href="' + esc(t.url) + '" target="_blank" rel="noopener">'
        + '<div class="xbm-card-top">'
          + '<div class="xbm-author">' + avatarHtml + '<span class="xbm-handle">@' + esc(t.authorHandle) + '</span></div>'
          + '<span class="xbm-date">' + esc(date) + '</span>'
        + '</div>'
        + '<div class="xbm-text">' + esc(t.text) + '</div>'
        + bottomRow
        + '</a>';
    }

    // Card with linked preview: use <div> wrapper so the slot is outside <a>
    return '<div class="xbm-card has-linked">'
      + cardInner
      + '<div class="xbm-linked-slot" data-linked-id="' + esc(t.linkedTweetId) + '"></div>'
      + '</div>';
  }

  // Lazy Twitter embeds via widgets.js
  var twttrReady = false;
  window.twttr = (function(d, s, id) {
    var js, t = window.twttr || {};
    if (d.getElementById(id)) return t;
    js = d.createElement(s); js.id = id; js.async = true;
    js.src = 'https://platform.twitter.com/widgets.js';
    d.head.appendChild(js);
    t._e = []; t.ready = function(f) { t._e.push(f); };
    return t;
  }(document, 'script', 'twitter-wjs'));
  window.twttr.ready(function() { twttrReady = true; loadVisible(); });

  var embedObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      embedObserver.unobserve(el);
      loadEmbed(el);
    });
  }, { rootMargin: '300px 0px' });

  function loadEmbed(el) {
    var id, slot;
    if (el.classList.contains('xbm-embed-card')) {
      id   = el.getAttribute('data-id');
      slot = el.querySelector('.xbm-embed-slot');
    } else {
      // linked article slot inside a text card
      id   = el.getAttribute('data-linked-id');
      slot = el;
    }
    if (!slot || slot.childElementCount) return;
    if (!twttrReady) { setTimeout(function() { loadEmbed(el); }, 300); return; }
    window.twttr.widgets.createTweet(id, slot, {
      conversation: 'none',
      cards: 'visible',
      theme: 'light',
      dnt: true,
    });
  }

  function loadVisible() {
    document.querySelectorAll('.xbm-embed-card:not([data-obs]), .xbm-linked-slot:not([data-obs])').forEach(function(c) {
      c.setAttribute('data-obs', '1');
      embedObserver.observe(c);
    });
  }

  function render(reset) {
    var grid = document.getElementById('xbm-grid');
    if (reset) { grid.innerHTML = ''; shown = 0; }
    var batch = filtered.slice(shown, shown + PAGE);
    if (batch.length) grid.insertAdjacentHTML('beforeend', batch.map(card).join(''));
    loadVisible();
    shown += batch.length;
    var countEl = document.getElementById('xbm-count');
    var moreBtn = document.getElementById('xbm-more');
    var subtitle = document.getElementById('xbm-subtitle');
    if (countEl) countEl.textContent = shown + ' / ' + filtered.length;
    if (moreBtn) moreBtn.style.display = shown >= filtered.length ? 'none' : '';
    if (subtitle && filtered.length !== ${total}) subtitle.textContent = filtered.length + ' matching';
    if (subtitle && filtered.length === ${total}) subtitle.textContent = '${total.toLocaleString()} saved';
  }

  function applyFilters(q) {
    var base = all;
    if (filterArticle) base = base.filter(function(t) { return t.article === filterArticle; });
    if (q) base = base.filter(function(t) {
      return t.text.toLowerCase().indexOf(q) !== -1
        || t.authorHandle.toLowerCase().indexOf(q) !== -1
        || t.authorName.toLowerCase().indexOf(q) !== -1;
    });
    filtered = sortOrder === 'asc' ? base.slice().reverse() : base;
    render(true);
  }

  function init() {
    fetch('/api/x-bookmarks', { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        all = data; // already sorted newest-first from server

        // Populate article filter
        var articles = [...new Set(data.filter(function(t) { return t.article; }).map(function(t) { return t.article; }))].sort();
        var sel = document.getElementById('xbm-article-filter');
        articles.forEach(function(a) {
          var o = document.createElement('option');
          o.value = a; o.textContent = a.replace(/-/g, ' ');
          sel.appendChild(o);
        });

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
      applyFilters(e.target.value.toLowerCase().trim());
    }, 250);
  });

  document.getElementById('xbm-article-filter').addEventListener('change', function(e) {
    filterArticle = e.target.value;
    applyFilters(document.getElementById('xbm-search').value.toLowerCase().trim());
  });

  document.getElementById('xbm-sort-btn').addEventListener('click', function() {
    sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
    this.textContent = sortOrder === 'desc' ? 'Newest first' : 'Oldest first';
    applyFilters(document.getElementById('xbm-search').value.toLowerCase().trim());
  });

  document.getElementById('xbm-more').addEventListener('click', function() { render(false); });

  document.getElementById('xbm-sync-btn').addEventListener('click', function() {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    fetch('/api/sync-x', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.ok) {
          btn.textContent = 'Sync failed';
          btn.title = data.error || data.output || '';
          setTimeout(function() { btn.disabled = false; btn.textContent = 'Sync'; btn.title = ''; }, 4000);
          return;
        }
        if (data.newCount === 0) {
          btn.textContent = 'Up to date';
          setTimeout(function() { btn.disabled = false; btn.textContent = 'Sync'; }, 2500);
        } else {
          btn.textContent = (data.newCount !== null ? '+' + data.newCount : 'Done') + ' — reloading…';
          setTimeout(function() { window.location.reload(); }, 1200);
        }
      })
      .catch(function() {
        btn.textContent = 'Error';
        setTimeout(function() { btn.disabled = false; btn.textContent = 'Sync'; }, 3000);
      });
  });

  // Badge clicks — stop the card link and navigate
  document.getElementById('xbm-grid').addEventListener('click', function(e) {
    var badge = e.target.closest('.xbm-article-badge, .xbm-tw-article-badge');
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    var href = badge.getAttribute('data-href');
    if (badge.classList.contains('xbm-tw-article-badge')) {
      window.open(href, '_blank', 'noopener');
    } else {
      window.location.href = href;
    }
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
