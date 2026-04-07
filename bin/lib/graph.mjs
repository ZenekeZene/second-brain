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

  // Navigation: in wiki-server mode, clicking a node opens /wiki/slug
  const navScript = wikiBase
    ? `function openNode(d) { window.location.href = '${wikiBase}/' + d.id; }`
    : `function openNode(d) { showPanel(d); }`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Graph — Second Brain</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           overflow: hidden; }
    svg#graph { width: 100vw; height: 100vh; display: block; }

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

    ${wikiBase ? `#back { position: fixed; top: 16px; right: 16px; z-index: 10; }` : ''}

    /* Side panel */
    #panel { position: fixed; right: 0; top: 0; bottom: 0; width: 280px; background: #1e293b;
             border-left: 1px solid #334155; transform: translateX(100%);
             transition: transform .2s ease; z-index: 20; padding: 20px; overflow-y: auto; }
    #panel.open { transform: translateX(0); }
    #panel-close { position: absolute; top: 12px; right: 12px; background: none; border: none;
                   color: #64748b; font-size: 18px; cursor: pointer; line-height: 1; }
    #panel-close:hover { color: #f1f5f9; }
    #panel h2 { color: #f1f5f9; font-size: 16px; margin-bottom: 6px; line-height: 1.4; }
    #panel .summary { color: #94a3b8; font-size: 13px; margin-bottom: 12px; font-style: italic; line-height: 1.5; }
    #panel .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
    #panel .tag  { background: #0f172a; color: #3b82f6; padding: 2px 8px; border-radius: 999px; font-size: 11px; }
    #panel .meta { color: #475569; font-size: 11px; margin-bottom: 14px; }
    #panel a.open-btn { display: block; background: #3b82f6; color: #fff; text-align: center;
                        padding: 8px; border-radius: 6px; font-size: 13px; text-decoration: none; }
    #panel a.open-btn:hover { background: #2563eb; }
    #panel .connections h3 { color: #64748b; font-size: 11px; text-transform: uppercase;
                              letter-spacing: .05em; margin-bottom: 8px; }
    #panel .conn-list { list-style: none; }
    #panel .conn-list li { padding: 5px 0; border-bottom: 1px solid #334155; font-size: 12px; }
    #panel .conn-list a { color: #93c5fd; text-decoration: none; }
    #panel .conn-list a:hover { text-decoration: underline; }

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

${wikiBase ? `<div id="back"><a href="${wikiBase}" class="hud-btn" style="text-decoration:none">← Wiki</a></div>` : ''}

<svg id="graph"></svg>

<div id="panel">
  <button id="panel-close">×</button>
  <h2 id="panel-title"></h2>
  <div class="summary" id="panel-summary"></div>
  <div class="tags" id="panel-tags"></div>
  <div class="meta" id="panel-meta"></div>
  <a id="panel-link" class="open-btn" style="display:none">Open article →</a>
  <div class="connections">
    <h3>Connections</h3>
    <ul class="conn-list" id="panel-connections"></ul>
  </div>
</div>

<div id="tooltip"></div>

<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script>
const RAW  = ${graphJson};
const TAGS = ${tagsJson};
${navScript}

// ── State ─────────────────────────────────────────────────────────────────────
let showMissing = true;
let filterTag   = '';
let selectedId  = null;

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

function render() {
  const { nodes, links } = getData();

  g.selectAll('*').remove();
  if (nodes.length === 0) return;

  const W = window.innerWidth, H = window.innerHeight;

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

  const linkEl = document.getElementById('panel-link');
  ${wikiBase ? `linkEl.href = '${wikiBase}/' + d.id; linkEl.style.display = 'block';` : `linkEl.style.display = 'none';`}

  // Connected nodes
  const connected = [];
  if (links) {
    for (const l of links) {
      const src = l.source.id || l.source, tgt = l.target.id || l.target;
      if (src === d.id) connected.push({ id: tgt,  dir: '→' });
      if (tgt === d.id) connected.push({ id: src,  dir: '←' });
    }
  }
  const connEl = document.getElementById('panel-connections');
  connEl.innerHTML = connected.map(c => {
    const n = (nodes || []).find(n => n.id === c.id);
    ${wikiBase
      ? `return '<li>' + c.dir + ' <a href="${wikiBase}/' + c.id + '">' + (n?.title || c.id) + '</a></li>';`
      : `return '<li><span style="color:#64748b">' + c.dir + '</span> <span style="color:#93c5fd">' + (n?.title || c.id) + '</span></li>';`
    }
  }).join('') || '<li style="color:#475569">No connections</li>';

  panel.classList.add('open');
}

function closePanel() { document.getElementById('panel').classList.remove('open'); }
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
  if (simulation) simulation.force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2)).alpha(0.3).restart();
});

render();
</script>
</body>
</html>`;
}
