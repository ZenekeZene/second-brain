#!/usr/bin/env node
/**
 * second-brain knowledge gap detection
 * Finds [[wikilinks]] that reference topics with no article yet.
 * Sorted by reference frequency — the most-linked missing topics are top priority.
 *
 * Usage:
 *   node bin/gap-detect.mjs               Print report + save to outputs/
 *   node bin/gap-detect.mjs --telegram    Also send top gaps to Telegram
 *   node bin/gap-detect.mjs --json        Output raw JSON (for scripting)
 *   node bin/gap-detect.mjs --help
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './lib/logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TELEGRAM = process.argv.includes('--telegram');
const JSON_OUT = process.argv.includes('--json');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node bin/gap-detect.mjs               Print report + save to outputs/
  node bin/gap-detect.mjs --telegram    Also send top gaps to Telegram
  node bin/gap-detect.mjs --json        Output raw JSON (for scripting)
`);
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10); }
function nowISO() { return new Date().toISOString(); }

function toSlug(text) {
  return text.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-');
}

function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}

// ── Analysis ──────────────────────────────────────────────────────────────────

const wikiDir = join(ROOT, 'wiki');

if (!existsSync(wikiDir)) {
  console.log('No wiki directory found. Compile some articles first.');
  process.exit(0);
}

const files = readdirSync(wikiDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');

if (files.length === 0) {
  console.log('No wiki articles found.');
  process.exit(0);
}

// Existing slugs (normalised)
const existingSlugs = new Set(files.map(f => toSlug(f.replace(/\.md$/, ''))));

// Collect all [[wikilinks]] and where they appear
// Handles: [[slug]], [[slug|alias]], [[slug#section]]
const WIKILINK_RE = /\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g;

/** @type {Map<string, Set<string>>} slug -> set of source article slugs */
const refs = new Map();

for (const file of files) {
  const content = readFileSync(join(wikiDir, file), 'utf8');
  const sourceSlug = file.replace(/\.md$/, '');
  for (const m of content.matchAll(WIKILINK_RE)) {
    const linked = toSlug(m[1]);
    if (!existingSlugs.has(linked)) {
      if (!refs.has(linked)) refs.set(linked, new Set());
      refs.get(linked).add(sourceSlug);
    }
  }
}

// Sort by number of referencing articles (desc), then alphabetically
const gaps = [...refs.entries()]
  .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
  .map(([slug, sources]) => ({ slug, count: sources.size, sources: [...sources].sort() }));

log('info', 'gap-detect:done', { articles: files.length, gaps: gaps.length });

// ── Output ────────────────────────────────────────────────────────────────────

if (JSON_OUT) {
  console.log(JSON.stringify({ date: today(), articles: files.length, gaps }, null, 2));
  process.exit(0);
}

// Console report
if (gaps.length === 0) {
  console.log(`\nNo knowledge gaps found — all [[wikilinks]] have matching articles.\n`);
} else {
  console.log(`\nKnowledge Gaps — ${today()}`);
  console.log(`  ${files.length} articles scanned | ${gaps.length} missing topics\n`);
  const maxSlug = Math.max(...gaps.map(g => g.slug.length), 5);
  console.log(`  ${'Topic'.padEnd(maxSlug)}  Refs  Referenced from`);
  console.log(`  ${'─'.repeat(maxSlug)}  ────  ──────────────`);
  for (const g of gaps) {
    const from = g.sources.slice(0, 3).join(', ') + (g.sources.length > 3 ? ` +${g.sources.length - 3}` : '');
    console.log(`  ${g.slug.padEnd(maxSlug)}  ${String(g.count).padEnd(4)}  ${from}`);
  }
  console.log('');
}

// Save markdown report to outputs/
const outputsDir = join(ROOT, 'outputs');
mkdirSync(outputsDir, { recursive: true });

const reportFile = join(outputsDir, `${today()}-gap-report.md`);
const topGaps = gaps.slice(0, 20);

const reportLines = [
  `---`,
  `type: gap-report`,
  `date: ${today()}`,
  `generated: ${nowISO()}`,
  `articles_scanned: ${files.length}`,
  `gaps_found: ${gaps.length}`,
  `---`,
  ``,
  `# Knowledge Gap Report — ${today()}`,
  ``,
  `> ${files.length} articles scanned. **${gaps.length}** topics referenced but not yet written.`,
  ``,
];

if (gaps.length === 0) {
  reportLines.push(`All [[wikilinks]] have matching articles. No gaps detected.`);
} else {
  reportLines.push(
    `## Top Missing Topics`,
    ``,
    `Sorted by how many articles reference each missing topic.`,
    ``,
    `| Topic | References | Referenced from |`,
    `|-------|-----------|----------------|`,
    ...topGaps.map(g => {
      const from = g.sources.slice(0, 3).map(s => `[[${s}]]`).join(', ') + (g.sources.length > 3 ? ` +${g.sources.length - 3} more` : '');
      return `| [[${g.slug}]] | ${g.count} | ${from} |`;
    }),
    ``,
    `## Suggested Next Articles`,
    ``,
    ...topGaps.slice(0, 5).map(g =>
      `- **[[${g.slug}]]** — referenced ${g.count}x from: ${g.sources.slice(0, 3).map(s => `[[${s}]]`).join(', ')}`
    ),
    ``,
    `> To fill a gap: \`brain: save <url-about-${topGaps[0]?.slug || 'topic'}>\``,
  );
}

writeFileSync(reportFile, reportLines.join('\n') + '\n');
if (!JSON_OUT) console.log(`Report saved to ${reportFile.replace(ROOT + '/', '')}`);

// ── Telegram (optional) ───────────────────────────────────────────────────────

if (!TELEGRAM || gaps.length === 0) process.exit(0);

loadEnv();
const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALLOWED_USER_ID;

if (!TOKEN || !CHAT_ID) {
  console.error('Telegram credentials not found in .env — skipping notification.');
  process.exit(0);
}

const top5 = gaps.slice(0, 5);
const msgLines = [
  `*Knowledge Gaps — ${today()}*`,
  `_${files.length} articles | ${gaps.length} missing topics_`,
  ``,
  `*Top missing articles:*`,
  ...top5.map((g, i) => `${i + 1}. \`[[${g.slug}]]\` — referenced ${g.count}x`),
];
if (gaps.length > 5) msgLines.push(`_...and ${gaps.length - 5} more (see outputs/)_`);

try {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: msgLines.join('\n'), parse_mode: 'Markdown' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
  console.log('Gap report sent to Telegram.');
} catch (err) {
  console.error(`Telegram error: ${err.message}`);
}
