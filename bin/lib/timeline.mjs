/**
 * Timeline data collection and HTML generation.
 * Shared by bin/timeline.mjs and bin/wiki-server.mjs.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// ── Data collection ───────────────────────────────────────────────────────────

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

export function collectItems(ROOT) {
  const items = [];
  const rawTypes = ['articles', 'notes', 'bookmarks', 'files', 'images', 'x-bookmarks'];

  for (const dir of rawTypes) {
    const fullDir = join(ROOT, 'raw', dir);
    if (!existsSync(fullDir)) continue;
    for (const f of readdirSync(fullDir).filter(f => f.endsWith('.md'))) {
      try {
        const content = readFileSync(join(fullDir, f), 'utf8');
        const meta = parseFm(content);
        const date = (meta.ingested || '').slice(0, 10);
        if (!date) continue;
        items.push({ date, type: meta.type || dir.replace(/s$/, ''), tags: meta.tags || [] });
      } catch { /* skip unreadable */ }
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
      const meta = parseFm(content);
      return { slug: f.replace(/\.md$/, ''), created: meta.created, updated: meta.updated, tags: meta.tags || [] };
    });
}

// ── Derived data ──────────────────────────────────────────────────────────────

export function monthlyGroups(items) {
  const groups = {};
  for (const item of items) {
    const m = item.date.slice(0, 7);
    if (!groups[m]) groups[m] = { total: 0, byType: {} };
    groups[m].total++;
    groups[m].byType[item.type] = (groups[m].byType[item.type] || 0) + 1;
  }
  return groups;
}

export function tagTimeline(items) {
  const tags = {};
  for (const item of items) {
    for (const tag of item.tags) {
      if (!tags[tag]) tags[tag] = { first: item.date, last: item.date, count: 0, types: new Set() };
      if (item.date < tags[tag].first) tags[tag].first = item.date;
      if (item.date > tags[tag].last)  tags[tag].last  = item.date;
      tags[tag].count++;
      tags[tag].types.add(item.type);
    }
  }
  // Convert Set to Array for serialisation
  for (const t of Object.values(tags)) t.types = [...t.types];
  return tags;
}

function daysBetween(a, b) {
  return Math.max(0, (new Date(b) - new Date(a)) / 86_400_000);
}

function daysSince(d) {
  return (Date.now() - new Date(d)) / 86_400_000;
}

// ── SVG helpers ───────────────────────────────────────────────────────────────

const TYPE_COLOR = {
  article:    '#3b82f6',
  note:       '#10b981',
  bookmark:   '#f59e0b',
  image:      '#8b5cf6',
  'x-bookmark': '#ec4899',
  file:       '#6b7280',
};
function typeColor(t) { return TYPE_COLOR[t] || '#94a3b8'; }

const TAG_PALETTE = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#f97316','#06b6d4','#84cc16','#a78bfa'];
function tagColor(i) { return TAG_PALETTE[i % TAG_PALETTE.length]; }

function escX(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function svgBarChart(groups) {
  const months = Object.keys(groups).sort();
  if (!months.length) return '<p style="color:#6b7280">No data yet.</p>';

  const BAR_W = 44, GAP = 6, PAD_L = 36, PAD_B = 32, H = 180;
  const W = PAD_L + months.length * (BAR_W + GAP) + 20;
  const maxCount = Math.max(...Object.values(groups).map(g => g.total), 1);

  const bars = months.map((month, i) => {
    const g = groups[month];
    const totalH = ((g.total / maxCount) * (H - PAD_B - 10));
    const x = PAD_L + i * (BAR_W + GAP);
    let parts = '';
    let yOff = H - PAD_B - totalH;

    // Stacked segments by type
    for (const [type, count] of Object.entries(g.byType)) {
      const segH = (count / maxCount) * (H - PAD_B - 10);
      parts += `<rect x="${x}" y="${yOff.toFixed(1)}" width="${BAR_W}" height="${Math.max(segH, 0.5).toFixed(1)}" fill="${typeColor(type)}" rx="2"/>`;
      yOff += segH;
    }

    const label = month.slice(5); // MM
    const yearLabel = i === 0 || month.slice(0, 4) !== months[i - 1]?.slice(0, 4) ? month.slice(0, 4) : '';

    return `${parts}
      <text x="${(x + BAR_W / 2).toFixed(0)}" y="${H - PAD_B + 13}" font-size="10" text-anchor="middle" fill="#6b7280">${escX(label)}</text>
      ${yearLabel ? `<text x="${(x + BAR_W / 2).toFixed(0)}" y="${H - PAD_B + 25}" font-size="9" text-anchor="middle" fill="#9ca3af">${escX(yearLabel)}</text>` : ''}
      ${g.total > 0 ? `<text x="${(x + BAR_W / 2).toFixed(0)}" y="${(H - PAD_B - totalH - 3).toFixed(0)}" font-size="10" text-anchor="middle" fill="#374151">${g.total}</text>` : ''}`;
  });

  // Y-axis ticks
  const ticks = [0, Math.ceil(maxCount / 2), maxCount].map(v => {
    const y = (H - PAD_B - (v / maxCount) * (H - PAD_B - 10)).toFixed(1);
    return `<line x1="${PAD_L - 4}" y1="${y}" x2="${W}" y2="${y}" stroke="#f3f4f6" stroke-width="1"/>
            <text x="${PAD_L - 6}" y="${parseFloat(y) + 4}" font-size="9" text-anchor="end" fill="#9ca3af">${v}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;overflow:visible">
    ${ticks.join('')}
    ${bars.join('')}
  </svg>`;
}

function svgGantt(tags) {
  const entries = Object.entries(tags).sort((a, b) => b[1].last.localeCompare(a[1].last));
  if (!entries.length) return '<p style="color:#6b7280">No tags found.</p>';

  const allDates = entries.flatMap(([, t]) => [t.first, t.last]);
  const minDate  = allDates.reduce((a, b) => a < b ? a : b);
  const maxDate  = allDates.reduce((a, b) => a > b ? a : b);
  const spanDays = daysBetween(minDate, maxDate) || 1;

  const ROW_H = 26, LABEL_W = 140, CHART_W = 680, PAD_T = 24;
  const H = entries.length * ROW_H + PAD_T + 10;
  const today = new Date().toISOString().slice(0, 10);
  const todayX = LABEL_W + (daysBetween(minDate, today) / spanDays) * CHART_W;

  const rows = entries.map(([tag, t], i) => {
    const x1 = LABEL_W + (daysBetween(minDate, t.first) / spanDays) * CHART_W;
    const x2 = LABEL_W + (daysBetween(minDate, t.last)  / spanDays) * CHART_W;
    const barW = Math.max(6, x2 - x1);
    const y = PAD_T + i * ROW_H;
    const inactive = daysSince(t.last) > 90;
    const color = inactive ? '#d1d5db' : tagColor(i);
    const textColor = inactive ? '#9ca3af' : '#374151';

    return `<text x="${LABEL_W - 8}" y="${y + ROW_H / 2 + 4}" font-size="11" text-anchor="end" fill="${textColor}">${escX(tag)}</text>
      <rect x="${x1.toFixed(1)}" y="${(y + 6).toFixed(1)}" width="${barW.toFixed(1)}" height="14" fill="${color}" rx="3">
        <title>${escX(tag)}: ${t.first} → ${t.last} (${t.count} items)</title>
      </rect>
      <text x="${(x2 + 5).toFixed(1)}" y="${y + ROW_H / 2 + 4}" font-size="10" fill="#9ca3af">${t.count}</text>`;
  });

  // Today marker
  const todayLine = `<line x1="${todayX.toFixed(1)}" y1="${PAD_T - 10}" x2="${todayX.toFixed(1)}" y2="${H}" stroke="#ef4444" stroke-width="1" stroke-dasharray="3,3"/>
    <text x="${(todayX + 3).toFixed(1)}" y="${PAD_T - 2}" font-size="9" fill="#ef4444">today</text>`;

  // Date labels on top
  const dateLabels = [minDate, maxDate].map((d, i) => {
    const x = i === 0 ? LABEL_W : LABEL_W + CHART_W;
    return `<text x="${x}" y="14" font-size="9" text-anchor="${i === 0 ? 'start' : 'end'}" fill="#9ca3af">${d}</text>`;
  });

  return `<svg viewBox="0 0 ${LABEL_W + CHART_W + 60} ${H}" style="width:100%;overflow:visible">
    ${dateLabels.join('')}
    ${todayLine}
    ${rows.join('')}
  </svg>`;
}

// ── Legend ────────────────────────────────────────────────────────────────────

function legend(items) {
  const types = [...new Set(items.map(i => i.type))];
  return types.map(t =>
    `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:12px;color:#374151">
      <span style="width:12px;height:12px;border-radius:3px;background:${typeColor(t)};display:inline-block"></span>${t}
    </span>`
  ).join('');
}

// ── Full HTML page ────────────────────────────────────────────────────────────

export function buildTimelineHtml(ROOT) {
  const items     = collectItems(ROOT);
  const wikiItems = collectWikiItems(ROOT);
  const groups    = monthlyGroups(items);
  const tags      = tagTimeline(items);

  const totalItems    = items.length;
  const activeMonths  = Object.keys(groups).length;
  const peakMonth     = Object.entries(groups).sort((a,b) => b[1].total - a[1].total)[0];
  const topTag        = Object.entries(tags).sort((a,b) => b[1].count - a[1].count)[0];
  const abandoned     = Object.entries(tags).filter(([,t]) => daysSince(t.last) > 90)
                          .sort((a,b) => daysSince(b[1].last) - daysSince(a[1].last));
  const today         = new Date().toISOString().slice(0, 10);

  const statsHtml = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:32px">
      ${[
        ['Items ingested',   totalItems],
        ['Wiki articles',    wikiItems.length],
        ['Active months',    activeMonths],
        ['Peak month',       peakMonth ? `${peakMonth[0].slice(5)} (${peakMonth[1].total})` : '—'],
        ['Top tag',          topTag ? `${topTag[0]} (${topTag[1].count})` : '—'],
        ['Drifted topics',   abandoned.length],
      ].map(([label, val]) => `
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">${label}</div>
          <div style="font-size:20px;font-weight:700;color:#1a1a1a;margin-top:2px">${val}</div>
        </div>`).join('')}
    </div>`;

  const abandonedHtml = abandoned.length === 0
    ? '<p style="color:#6b7280;font-size:14px">No drifted topics — everything is still active.</p>'
    : `<table style="width:100%;font-size:13px;border-collapse:collapse">
        <thead><tr style="border-bottom:1px solid #e5e7eb">
          <th style="text-align:left;padding:6px 8px;color:#6b7280;font-weight:500">Tag</th>
          <th style="text-align:left;padding:6px 8px;color:#6b7280;font-weight:500">Last seen</th>
          <th style="text-align:left;padding:6px 8px;color:#6b7280;font-weight:500">Items</th>
        </tr></thead>
        <tbody>${abandoned.map(([tag, t]) =>
          `<tr style="border-bottom:1px solid #f3f4f6">
            <td style="padding:6px 8px;color:#374151">${escX(tag)}</td>
            <td style="padding:6px 8px;color:#9ca3af">${t.last}</td>
            <td style="padding:6px 8px;color:#9ca3af">${t.count}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Timeline — Second Brain</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f8f9fa; color: #1a1a1a; padding: 40px 24px; }
    .container { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { color: #6b7280; font-size: 13px; margin-bottom: 28px; }
    h2 { font-size: 15px; font-weight: 600; color: #374151; margin: 28px 0 12px;
         text-transform: uppercase; letter-spacing: .05em; }
    .chart-box { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
                 padding: 20px 24px; margin-bottom: 8px; overflow-x: auto; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Second Brain — Timeline</h1>
    <div class="subtitle">Generated ${today} · ${totalItems} items across ${activeMonths} months</div>

    ${statsHtml}

    <h2>Activity by Month</h2>
    <div class="chart-box">
      <div style="margin-bottom:10px">${legend(items)}</div>
      ${items.length ? svgBarChart(groups) : '<p style="color:#6b7280">No items ingested yet.</p>'}
    </div>

    <h2>Topics Over Time</h2>
    <div class="chart-box" style="padding-bottom:12px">
      <p style="font-size:12px;color:#9ca3af;margin-bottom:12px">
        Grey bars = no activity in 90+ days &nbsp;·&nbsp; Red line = today
      </p>
      ${Object.keys(tags).length ? svgGantt(tags) : '<p style="color:#6b7280">No tags found.</p>'}
    </div>

    <h2>Drifted Topics</h2>
    <div class="chart-box">${abandonedHtml}</div>
  </div>
</body>
</html>`;
}
