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
    radius: n.missing ? 5 : Math.max(7, 7 + (degree[n.id] || 0) * 2),
  }));

  return { nodes: nodeArray, links };
}

// ── HTML generation ───────────────────────────────────────────────────────────

export function buildGraphHtml(ROOT, { wikiBase = null } = {}) {
  const { nodes, links } = buildGraphData(ROOT);
  const articleCount = nodes.filter(n => !n.missing).length;
  const missingCount = nodes.filter(n => n.missing).length;

  // All tags for filter
  const allTags = [...new Set(nodes.flatMap(n => n.tags))].sort();

  const graphJson = JSON.stringify({ nodes, links });
  const tagsJson  = JSON.stringify(allTags);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Graph — Second Brain</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { display: flex; background: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           overflow: hidden; height: 100vh; }
    #graph-container { flex: 1; min-width: 0; position: relative; }
    svg#graph { width: 100%; height: 100vh; display: block; }

    /* HUD overlay */
    #hud { position: fixed; top: 16px; left: 16px; z-index: 10; display: flex; flex-direction: column; gap: 8px; }
    #hud-title { color: #f1f5f9; font-size: 15px; font-weight: 700; }
    #hud-stats  { color: #64748b; font-size: 12px; }
    #hud-controls { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .hud-btn { background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 6px;
               padding: 4px 10px; font-size: 12px; cursor: pointer; }
    .hud-btn:hover { background: #334155; color: #f1f5f9; }
    .hud-btn.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
    select.hud-btn { appearance: none; padding-right: 20px;
                     background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2394a3b8'/%3E%3C/svg%3E");
                     background-repeat: no-repeat; background-position: right 6px center; }

    /* Side panel — flex column, slides open by expanding width */
    #panel { width: 0; overflow: hidden; flex-shrink: 0; transition: width .3s ease; height: 100vh; }
    #panel.open { width: min(44vw, 620px); }
    #panel-inner { width: min(44vw, 620px); height: 100vh; overflow-y: auto; display: flex;
                   flex-direction: column; border-left: 1px solid #334155; background: #1e293b; }
    #panel-header { padding: 16px 20px 14px; border-bottom: 1px solid #334155; position: relative; flex-shrink: 0; }
    #panel-close { position: absolute; top: 12px; right: 14px; background: none; border: none;
                   color: #64748b; font-size: 18px; cursor: pointer; line-height: 1; }
    #panel-close:hover { color: #f1f5f9; }
    #panel h2 { color: #f1f5f9; font-size: 15px; margin-bottom: 6px; line-height: 1.4; padding-right: 24px; }
    #panel .summary { color: #94a3b8; font-size: 12px; margin-bottom: 10px; font-style: italic; line-height: 1.5; }
    #panel .tags { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
    #panel .tag  { background: #0f172a; color: #3b82f6; padding: 2px 8px; border-radius: 999px; font-size: 11px; }
    #panel .meta { color: #475569; font-size: 11px; }
    /* Article body */
    #panel-article { flex: 1; padding: 18px 20px; overflow-y: auto; }
    #panel-article h1 { display: none; }
    #panel-article h2 { color: #cbd5e1; font-size: 13px; font-weight: 600; margin: 16px 0 7px;
                        padding-bottom: 4px; border-bottom: 1px solid #1e3a5f; }
    #panel-article h3 { color: #94a3b8; font-size: 12px; font-weight: 600; margin: 12px 0 5px; }
    #panel-article p  { color: #94a3b8; font-size: 13px; line-height: 1.65; margin-bottom: 10px; }
    #panel-article ul, #panel-article ol { color: #94a3b8; font-size: 13px; padding-left: 18px; margin-bottom: 10px; }
    #panel-article li { margin-bottom: 3px; line-height: 1.55; }
    #panel-article a  { color: #93c5fd; text-decoration: none; }
    #panel-article a:hover { text-decoration: underline; }
    #panel-article a.wikilink.missing { color: #f87171; border-bottom: 1px dashed #f87171; }
    #panel-article code { background: #0f172a; color: #a5f3fc; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
    #panel-article pre  { background: #0f172a; padding: 12px; border-radius: 6px; overflow-x: auto; margin-bottom: 12px; }
    #panel-article blockquote { border-left: 3px solid #334155; padding-left: 10px; color: #64748b; font-style: italic; margin-bottom: 10px; }
    #panel-article .article-meta { color: #475569; font-size: 11px; margin-bottom: 10px; }
    #panel-article #backlinks { border-top: 1px solid #334155; margin-top: 18px; padding-top: 12px; }
    #panel-article #backlinks h4 { color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
    #panel-article .backlink-pill a { display: inline-block; background: #0f172a; color: #93c5fd; padding: 2px 8px; border-radius: 999px; font-size: 11px; text-decoration: none; margin: 2px 3px 2px 0; }
    #panel-article .loading { color: #475569; font-size: 12px; padding: 16px 0; }
    /* Connections footer */
    #panel-connections-wrap { padding: 12px 20px 16px; border-top: 1px solid #334155; flex-shrink: 0; }
    #panel-connections-wrap h3 { color: #64748b; font-size: 10px; text-transform: uppercase;
                                  letter-spacing: .06em; margin-bottom: 8px; }
    .conn-list { list-style: none; display: flex; flex-wrap: wrap; gap: 5px; }
    .conn-list li { font-size: 12px; }
    .conn-list a { color: #93c5fd; text-decoration: none; background: #0f172a; padding: 2px 8px; border-radius: 999px; }
    .conn-list a:hover { text-decoration: underline; }

    /* Tooltip */
    #tooltip { position: fixed; pointer-events: none; background: #1e293b; color: #f1f5f9;
               border: 1px solid #334155; border-radius: 6px; padding: 6px 10px; font-size: 12px;
               opacity: 0; transition: opacity .1s; z-index: 30; max-width: 200px; }

    /* SVG node/link styles */
    .link { stroke: #1e3a5f; stroke-width: 1.2; }
    .link.highlighted { stroke: #3b82f6; stroke-width: 2; }
    .node circle { stroke: #0f172a; stroke-width: 2; cursor: pointer; transition: r .1s; }
    .node circle:hover { stroke: #3b82f6; stroke-width: 2.5; }
    .node text { fill: #94a3b8; font-size: 10px; pointer-events: none; text-anchor: middle; }
    .node.selected circle { stroke: #f59e0b; stroke-width: 3; }
    .node.faded { opacity: 0.2; }
  </style>
</head>
<body>

<div id="hud">
  <div id="hud-title">Second Brain</div>
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
      <div class="summary" id="panel-summary"></div>
      <div class="tags" id="panel-tags"></div>
      <div class="meta" id="panel-meta"></div>
    </div>
    <div id="panel-article"></div>
    <div id="panel-connections-wrap">
      <h3>Connections</h3>
      <ul class="conn-list" id="panel-connections"></ul>
    </div>
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
    .force('collision', d3.forceCollide().radius(d => d.radius + 10))
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
    .attr('fill', d => d.missing ? '#334155' : (d.tags.length ? tagColor(d.tags[0]) : '#3b82f6'))
    .attr('fill-opacity', d => d.missing ? 0.5 : 0.9);

  nodeSel.append('text')
    .text(d => d.title.length > 22 ? d.title.slice(0, 20) + '…' : d.title)
    .attr('dy', d => d.radius + 13)
    .style('font-size', d => d.radius > 10 ? '11px' : '9px')
    .style('fill', d => d.missing ? '#475569' : '#94a3b8');

  // Events
  nodeSel
    .on('mouseenter', (e, d) => {
      const tip = document.getElementById('tooltip');
      tip.innerHTML = \`<strong>\${d.title}</strong>\${d.tags.length ? '<br><span style="color:#64748b">' + d.tags.join(', ') + '</span>' : ''}\`;
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
  document.getElementById('panel-title').textContent   = d.title;
  document.getElementById('panel-summary').textContent = d.summary || '';
  document.getElementById('panel-meta').textContent    = d.updated ? 'Updated ' + d.updated : '';

  const tagsEl = document.getElementById('panel-tags');
  tagsEl.innerHTML = (d.tags || []).map(t => \`<span class="tag">\${t}</span>\`).join('');

  // Connected nodes
  const connected = [];
  if (links) {
    for (const l of links) {
      const src = l.source.id || l.source, tgt = l.target.id || l.target;
      if (src === d.id) connected.push({ id: tgt, dir: '→' });
      if (tgt === d.id) connected.push({ id: src, dir: '←' });
    }
  }
  const connEl = document.getElementById('panel-connections');
  connEl.innerHTML = connected.map(c => {
    const n = (nodes || []).find(n => n.id === c.id);
    return \`<li><a href="#" data-slug="\${c.id}">\${c.dir} \${n?.title || c.id}</a></li>\`;
  }).join('') || '<li style="color:#475569;font-size:12px">No connections</li>';

  // Connection links navigate within graph
  connEl.querySelectorAll('a[data-slug]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const target = currentNodes?.find(n => n.id === a.dataset.slug);
      if (target) { selectedId = target.id; highlightNode(target); showPanel(target, currentLinks, currentNodes); }
    });
  });

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
</script>
</body>
</html>`;
}
