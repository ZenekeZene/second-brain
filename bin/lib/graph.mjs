/**
 * Graph data builder and HTML generator for the [[wikilinks]] visualizer.
 * Shared by bin/graph.mjs and bin/wiki-server.mjs.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const WIKILINK_RE = /\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g;

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

// ── Graph data ────────────────────────────────────────────────────────────────

export function buildGraphData(ROOT, { includeMissing = true } = {}) {
  const wikiDir = join(ROOT, 'wiki');
  if (!existsSync(wikiDir)) return { nodes: [], links: [] };

  const files = readdirSync(wikiDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
  const existingSlugs = new Set(files.map(f => f.replace(/\.md$/, '')));
  const nodes = new Map();
  const linkSet = new Set();
  const links = [];

  // Existing articles as nodes
  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const content = readFileSync(join(wikiDir, file), 'utf8');
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const summaryMatch = content.match(/^>\s+(.+)$/m);
    const meta = parseFm(content);
    nodes.set(slug, {
      id: slug,
      title: titleMatch ? titleMatch[1].trim() : slug,
      summary: summaryMatch ? summaryMatch[1].trim() : '',
      tags: meta.tags || [],
      updated: meta.updated || '',
      missing: false,
    });
  }

  // Scan [[wikilinks]], build edges
  for (const file of files) {
    const source = file.replace(/\.md$/, '');
    const content = readFileSync(join(wikiDir, file), 'utf8');
    for (const m of content.matchAll(WIKILINK_RE)) {
      const target = m[1].trim().toLowerCase().replace(/\s+/g, '-');
      if (target === source) continue;
      const key = `${source}→${target}`;
      if (linkSet.has(key)) continue;
      linkSet.add(key);

      if (existingSlugs.has(target)) {
        links.push({ source, target });
      } else if (includeMissing) {
        if (!nodes.has(target)) {
          nodes.set(target, { id: target, title: target, summary: '', tags: [], missing: true });
        }
        links.push({ source, target });
      }
    }
  }

  // Compute degree for node sizing
  const degree = {};
  for (const { source, target } of links) {
    degree[source] = (degree[source] || 0) + 1;
    degree[target] = (degree[target] || 0) + 1;
  }

  const nodeArray = [...nodes.values()].map(n => ({
    ...n,
    degree: degree[n.id] || 0,
    radius: n.missing ? 3 : Math.max(4, 4 + (degree[n.id] || 0) * 1.2),
  }));

  return { nodes: nodeArray, links };
}

// ── HTML generation ───────────────────────────────────────────────────────────

export function buildGraphHtml(ROOT, { wikiBase = null } = {}, layoutFn, articles) {
  const { nodes, links } = buildGraphData(ROOT);
  const articleCount = nodes.filter(n => !n.missing).length;
  const missingCount = nodes.filter(n => n.missing).length;

  // All tags for filter
  const allTags = [...new Set(nodes.flatMap(n => n.tags))].sort();

  const graphJson = JSON.stringify({ nodes, links });
  const tagsJson  = JSON.stringify(allTags);

  const graphInnerHtml = `
<div id="hud">
  <div id="hud-title">Graph</div>
  <div id="hud-stats">${articleCount} articles · ${links.length} links${missingCount ? ` · ${missingCount} missing` : ''}</div>
  <div id="hud-controls">
    <select class="hud-btn" id="tag-filter">
      <option value="">All tags</option>
    </select>
    <button class="hud-btn" id="toggle-missing">Hide missing</button>
    <button class="hud-btn" id="reset-zoom">Reset zoom</button>
  </div>
</div>

<div id="graph-container">
  <svg id="graph"></svg>
</div>

<div id="panel">
  <div id="panel-inner">
    <div id="panel-header">
      <button id="panel-close">×</button>
      <h2 id="panel-title"></h2>
    </div>
    <div id="panel-article"></div>
  </div>
</div>

<div id="tooltip"></div>

<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script>
const RAW  = ${graphJson};
const TAGS = ${tagsJson};

// ── State ─────────────────────────────────────────────────────────────────────
let showMissing  = true;
let filterTag    = '';
let selectedId   = null;
let currentLinks = null;
let currentNodes = null;

// Deep-clone so we can re-run simulation on filter change
function getData() {
  const nodes = RAW.nodes.filter(n => {
    if (!showMissing && n.missing) return false;
    if (filterTag && !n.tags.includes(filterTag)) return false;
    return true;
  });
  const nodeIds = new Set(nodes.map(n => n.id));
  const links = RAW.links.filter(l => nodeIds.has(l.source.id || l.source) && nodeIds.has(l.target.id || l.target));
  return {
    nodes: nodes.map(n => ({ ...n })),
    links: links.map(l => ({ source: l.source.id || l.source, target: l.target.id || l.target })),
  };
}

// ── D3 setup ──────────────────────────────────────────────────────────────────
const svg = d3.select('#graph');
const g   = svg.append('g');

const zoom = d3.zoom()
  .scaleExtent([0.2, 5])
  .on('zoom', e => g.attr('transform', e.transform));
svg.call(zoom);

let simulation, linkSel, nodeSel;

function graphWidth() { return document.getElementById('graph-container').offsetWidth || window.innerWidth; }

function render() {
  const { nodes, links } = getData();
  currentNodes = nodes;
  currentLinks = links;

  g.selectAll('*').remove();
  if (nodes.length === 0) return;

  const W = graphWidth(), H = window.innerHeight;

  simulation = d3.forceSimulation(nodes)
    .force('link',      d3.forceLink(links).id(d => d.id).distance(90).strength(0.6))
    .force('charge',    d3.forceManyBody().strength(d => -120 - d.radius * 15))
    .force('center',    d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide().radius(d => d.radius + 6))
    .alphaDecay(0.03);

  // Links
  linkSel = g.append('g').selectAll('line')
    .data(links).join('line').attr('class', 'link');

  // Nodes
  nodeSel = g.append('g').selectAll('g')
    .data(nodes, d => d.id).join('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

  nodeSel.append('circle')
    .attr('r', d => d.radius)
    .style('fill', d => d.missing ? 'var(--ink-3)' : 'var(--ink-2)')
    .style('fill-opacity', d => d.missing ? 0.3 : 0.7)
    .attr('stroke', 'none');

  nodeSel.append('text')
    .text(d => d.title.length > 22 ? d.title.slice(0, 20) + '…' : d.title)
    .attr('dy', d => d.radius + 12)
    .style('font-size', '9px')
    .style('fill', 'var(--ink-2)')
    .style('font-family', "'DM Sans', sans-serif");

  // Events
  nodeSel
    .on('mouseenter', (e, d) => {
      const tip = document.getElementById('tooltip');
      tip.innerHTML = \`<strong>\${d.title}</strong>\${d.tags.length ? '<br><span style="color:#9A9088">' + d.tags.join(', ') + '</span>' : ''}\`;
      tip.style.opacity = '1';
    })
    .on('mousemove', e => {
      const tip = document.getElementById('tooltip');
      tip.style.left = (e.clientX + 12) + 'px';
      tip.style.top  = (e.clientY + 12) + 'px';
    })
    .on('mouseleave', () => { document.getElementById('tooltip').style.opacity = '0'; })
    .on('click', (e, d) => {
      e.stopPropagation();
      if (d.missing) return;
      selectedId = d.id;
      highlightNode(d);
      showPanel(d, links, nodes);
    });

  simulation.on('tick', () => {
    linkSel
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeSel.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
  });
}

// ── Tag color palette ─────────────────────────────────────────────────────────
const PALETTE = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#f97316','#06b6d4','#84cc16','#a78bfa'];
const tagColorMap = {};
let colorIdx = 0;
function tagColor(tag) {
  if (!tagColorMap[tag]) tagColorMap[tag] = PALETTE[colorIdx++ % PALETTE.length];
  return tagColorMap[tag];
}

// ── Highlight ─────────────────────────────────────────────────────────────────
function highlightNode(d) {
  if (!nodeSel) return;
  const connectedIds = new Set([d.id]);
  linkSel.each(l => {
    if ((l.source.id || l.source) === d.id) connectedIds.add(l.target.id || l.target);
    if ((l.target.id || l.target) === d.id) connectedIds.add(l.source.id || l.source);
  });
  nodeSel.classed('faded',    n => !connectedIds.has(n.id));
  nodeSel.classed('selected', n => n.id === d.id);
  linkSel.classed('highlighted', l =>
    (l.source.id || l.source) === d.id || (l.target.id || l.target) === d.id);
}

svg.on('click', () => {
  nodeSel?.classed('faded', false).classed('selected', false);
  linkSel?.classed('highlighted', false);
  closePanel();
  selectedId = null;
});

// ── Side panel ────────────────────────────────────────────────────────────────
function showPanel(d, links, nodes) {
  const panel = document.getElementById('panel');
  document.getElementById('panel-title').textContent = d.title;

  panel.classList.add('open');
  recenterSimulation();

  ${wikiBase ? `
  // Load article content
  const articleEl = document.getElementById('panel-article');
  articleEl.innerHTML = '<div class="loading">Loading…</div>';
  fetch('/api/article/' + encodeURIComponent(d.id))
    .then(r => r.json())
    .then(({ html }) => {
      articleEl.innerHTML = html || '';
      // Wikilinks in article navigate within graph (don't leave the page)
      articleEl.querySelectorAll('a[href^="/wiki/"]').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const slug = a.getAttribute('href').replace('/wiki/', '');
          const target = currentNodes?.find(n => n.id === slug);
          if (target) { selectedId = target.id; highlightNode(target); showPanel(target, currentLinks, currentNodes); }
        });
      });
    })
    .catch(() => { articleEl.innerHTML = '<p class="loading">Could not load article.</p>'; });
  ` : `document.getElementById('panel-article').innerHTML = '';`}
}

function closePanel() {
  document.getElementById('panel').classList.remove('open');
  document.getElementById('panel-article').innerHTML = '';
  recenterSimulation();
}

function recenterSimulation() {
  if (!simulation) return;
  // Delay by transition duration so width has settled
  setTimeout(() => {
    const w = graphWidth();
    simulation.force('center', d3.forceCenter(w / 2, window.innerHeight / 2)).alpha(0.15).restart();
  }, 320);
}

document.getElementById('panel-close').addEventListener('click', closePanel);

// ── Controls ──────────────────────────────────────────────────────────────────
// Populate tag filter
const tagSelect = document.getElementById('tag-filter');
TAGS.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; tagSelect.appendChild(o); });
tagSelect.addEventListener('change', e => { filterTag = e.target.value; render(); });

const toggleBtn = document.getElementById('toggle-missing');
toggleBtn.addEventListener('click', () => {
  showMissing = !showMissing;
  toggleBtn.textContent = showMissing ? 'Hide missing' : 'Show missing';
  toggleBtn.classList.toggle('active', !showMissing);
  render();
});

document.getElementById('reset-zoom').addEventListener('click', () => {
  svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
});

window.addEventListener('resize', () => {
  if (simulation) simulation.force('center', d3.forceCenter(graphWidth() / 2, window.innerHeight / 2)).alpha(0.3).restart();
});

render();
</script>`;

  // Sidebar layout (server mode)
  if (layoutFn) {
    return layoutFn(graphInnerHtml, articles || [], '__graph', 'Graph — Second Brain', { contentClass: 'content-graph' });
  }

  // Standalone fallback (CLI: bin/graph.mjs)
  const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">`;
  const topNavHtml = `<nav class="top-nav" style="z-index:1000">
    <a href="/" class="top-nav-brand">Second Brain</a>
    <span class="top-nav-sep">|</span>
    <a href="/">Articles</a>
    <a href="/graph" class="active">Graph</a>
    <a href="/timeline">Timeline</a>
    <a href="/ingest">Ingest</a>
    <a href="/tasks">Tasks</a>
    <a href="/pending">Pending</a>
  </nav>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Graph — Second Brain</title>
  ${FONTS}
  <link rel="stylesheet" href="/static/style.css">
  <style>body { overflow: hidden; height: 100vh; } .graph-body { padding-top: 40px; }</style>
</head>
<body class="graph-body">
  ${topNavHtml}
  ${graphInnerHtml}
</body>
</html>`;
}
