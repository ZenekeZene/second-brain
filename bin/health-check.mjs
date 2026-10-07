#!/usr/bin/env node
/**
 * second-brain monthly health check
 * Runs locally (Mac/Pi) where wiki/, raw/, and .state/ are available.
 *
 * Usage:
 *   node bin/health-check.mjs             Run checks, save report
 *   node bin/health-check.mjs --push      Also git commit + push
 *   node bin/health-check.mjs --telegram  Also send summary to Telegram
 *   node bin/health-check.mjs --help
 */

import {
  readFileSync, readdirSync, writeFileSync,
  mkdirSync, existsSync,
} from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PUSH     = process.argv.includes('--push');
const TELEGRAM = process.argv.includes('--telegram');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node bin/health-check.mjs             Run checks, save report to outputs/
  node bin/health-check.mjs --push      Also git add + commit + push origin master
  node bin/health-check.mjs --telegram  Also send summary to Telegram
`);
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10); }
function nowISO() { return new Date().toISOString(); }

function toSlug(text) {
  return text.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-');
}

function parseFrontmatter(content) {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = content.slice(4, end);
  const result = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    result[key] = val;
  }
  return result;
}

function hasSources(content) {
  const fm = parseFrontmatter(content);
  if (!fm.sources) return false;
  const val = fm.sources.trim();
  return val !== '' && val !== '[]' && val !== '-' && val !== '- []';
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

// ── Load data ─────────────────────────────────────────────────────────────────

const wikiDir   = join(ROOT, 'wiki');
const outputDir = join(ROOT, 'outputs');
const stateDir  = join(ROOT, '.state');

if (!existsSync(wikiDir)) {
  console.error('❌  wiki/ not found — run this script on a machine where the wiki lives (Mac or Pi).');
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const allFiles = readdirSync(wikiDir).filter(f => f.endsWith('.md'));
const articleFiles = allFiles.filter(f => f !== 'INDEX.md');

/** @type {Map<string, string>} slug → full content */
const articles = new Map();
for (const f of articleFiles) {
  articles.set(f.replace(/\.md$/, ''), readFileSync(join(wikiDir, f), 'utf8'));
}

const existingSlugs = new Set([...articles.keys()].map(toSlug));

// ── 1. Pending items ──────────────────────────────────────────────────────────

let pendingCount = 0;
let lastCompile = null;
try {
  const state = JSON.parse(readFileSync(join(stateDir, 'pending.json'), 'utf8'));
  pendingCount = (state.items ?? state.pending ?? []).length;
  lastCompile = state.lastCompile ?? null;
} catch {}

// ── 2. Wikilink graph ─────────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g;

/** @type {Map<string, Set<string>>} slug → set of slugs that link TO it */
const inbound = new Map();
for (const slug of articles.keys()) inbound.set(slug, new Set());

/** @type {Map<string, Set<string>>} missing slug → set of slugs that reference it */
const broken = new Map();

for (const [slug, content] of articles) {
  for (const m of content.matchAll(WIKILINK_RE)) {
    const target = toSlug(m[1]);
    if (existingSlugs.has(target)) {
      inbound.get(target)?.add(slug);
    } else {
      if (!broken.has(target)) broken.set(target, new Set());
      broken.get(target).add(slug);
    }
  }
}

// ── 3. Orphan articles (nothing points to them, excluding INDEX.md) ───────────

const orphans = [...articles.keys()].filter(slug => (inbound.get(slug)?.size ?? 0) === 0);

// ── 4. Articles without sources ───────────────────────────────────────────────

const noSources = [...articles.entries()]
  .filter(([, content]) => !hasSources(content))
  .map(([slug]) => slug);

// ── 5. Possible contradictions (same-topic pairs) ─────────────────────────────

function keywordsOf(slug) {
  return new Set(slug.split('-').filter(w => w.length > 3));
}

const contradictions = [];
const slugList = [...articles.keys()];
for (let i = 0; i < slugList.length; i++) {
  for (let j = i + 1; j < slugList.length; j++) {
    const a = slugList[i], b = slugList[j];
    const ka = keywordsOf(a), kb = keywordsOf(b);
    const shared = [...ka].filter(k => kb.has(k));
    if (shared.length >= 2) {
      contradictions.push({ a, b, shared });
    }
  }
}

// ── 6. Top missing topics (from broken wikilinks) ────────────────────────────

const gaps = [...broken.entries()]
  .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
  .map(([slug, sources]) => ({ slug, count: sources.size, sources: [...sources].sort() }));

// ── 7. Build report ───────────────────────────────────────────────────────────

const reportDate = today();
const reportPath = join(outputDir, `${reportDate}-health-check.md`);

function pct(n, total) { return total ? `${Math.round(n / total * 100)}%` : '0%'; }

const lines = [
  `---`,
  `query: "Monthly health check"`,
  `date: ${reportDate}`,
  `generated: ${nowISO()}`,
  `type: health-check`,
  `---`,
  ``,
  `# Health Check Mensual — ${reportDate}`,
  ``,
  `## Resumen ejecutivo`,
  ``,
  `| Métrica | Valor |`,
  `|---|---|`,
  `| Artículos en wiki/ | **${articles.size}** |`,
  `| Items pendientes de compilar | **${pendingCount}** |`,
  `| Último compile | ${lastCompile ? lastCompile.slice(0, 10) : 'nunca'} |`,
  `| Artículos huérfanos | ${orphans.length} (${pct(orphans.length, articles.size)}) |`,
  `| Artículos sin fuentes | ${noSources.length} (${pct(noSources.length, articles.size)}) |`,
  `| Wikilinks rotos | ${gaps.length} temas referenciados pero sin artículo |`,
  `| Posibles solapamientos | ${contradictions.length} pares |`,
  ``,
];

// Priority issues
const issues = [];
if (pendingCount > 10) issues.push(`🔴 **${pendingCount} items pendientes** — considerar compilar pronto`);
else if (pendingCount > 0) issues.push(`🟡 **${pendingCount} items pendientes** — sin urgencia`);
if (orphans.length > 5) issues.push(`🔴 **${orphans.length} artículos huérfanos** — ningún wikilink apunta a ellos`);
else if (orphans.length > 0) issues.push(`🟡 **${orphans.length} artículos huérfanos** — bajo impacto`);
if (noSources.length > 0) issues.push(`🟡 **${noSources.length} artículos sin fuentes** — rigor documental comprometido`);
if (gaps.length > 0) issues.push(`🟡 **${gaps.length} wikilinks rotos** — temas referenciados sin artículo`);
if (contradictions.length > 0) issues.push(`⚪ **${contradictions.length} posibles solapamientos** — revisar si deben fusionarse`);

if (issues.length === 0) {
  lines.push(`> ✅ Wiki en buen estado. Sin problemas detectados.\n`);
} else {
  lines.push(`### Problemas detectados (orden de impacto)\n`);
  lines.push(...issues.map(i => `- ${i}`), ``);
}

// Orphans
lines.push(`## Artículos huérfanos`);
lines.push(``, `_Ningún \`[[wikilink]]\` apunta a estos artículos._`, ``);
if (orphans.length === 0) {
  lines.push(`✅ Ninguno.\n`);
} else {
  lines.push(`| Artículo | Acción sugerida |`, `|---|---|`);
  for (const s of orphans) {
    lines.push(`| [[${s}]] | Añadir wikilink desde un artículo relacionado |`);
  }
  lines.push(``);
}

// No sources
lines.push(`## Artículos sin fuentes`);
lines.push(``, `_Artículos donde \`sources:\` está vacío en el frontmatter._`, ``);
if (noSources.length === 0) {
  lines.push(`✅ Ninguno.\n`);
} else {
  lines.push(`| Artículo |`, `|---|`);
  for (const s of noSources) lines.push(`| [[${s}]] |`);
  lines.push(``);
}

// Contradictions / overlaps
lines.push(`## Posibles solapamientos temáticos`);
lines.push(``, `_Pares de artículos con keywords comunes — pueden necesitar fusión._`, ``);
if (contradictions.length === 0) {
  lines.push(`✅ Ninguno.\n`);
} else {
  lines.push(`| Artículo A | Artículo B | Keywords compartidas |`, `|---|---|---|`);
  for (const { a, b, shared } of contradictions.slice(0, 15)) {
    lines.push(`| [[${a}]] | [[${b}]] | ${shared.join(', ')} |`);
  }
  if (contradictions.length > 15) lines.push(``, `_...y ${contradictions.length - 15} pares más._`);
  lines.push(``);
}

// Broken wikilinks / gaps
lines.push(`## Wikilinks rotos y temas candidatos`);
lines.push(``, `_Temas referenciados desde el wiki pero sin artículo propio. Ordenados por frecuencia._`, ``);
if (gaps.length === 0) {
  lines.push(`✅ Todos los \`[[wikilinks]]\` tienen artículo.\n`);
} else {
  lines.push(`| Tema | Referencias | Referenciado desde |`, `|---|---|---|`);
  for (const g of gaps.slice(0, 20)) {
    const from = g.sources.slice(0, 3).map(s => `[[${s}]]`).join(', ')
      + (g.sources.length > 3 ? ` +${g.sources.length - 3}` : '');
    lines.push(`| [[${g.slug}]] | ${g.count} | ${from} |`);
  }
  if (gaps.length > 20) lines.push(``, `_...y ${gaps.length - 20} temas más._`);
  lines.push(``, `### Artículos candidatos prioritarios`, ``);
  for (const g of gaps.slice(0, 5)) {
    lines.push(`- **[[${g.slug}]]** — referenciado ${g.count}x → \`brain: save <url-sobre-${g.slug}>\``);
  }
  lines.push(``);
}

lines.push(
  `---`,
  ``,
  `*Generado automáticamente por \`bin/health-check.mjs\` · ${reportDate}*`,
);

writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(`\n✅  Health check guardado en ${reportPath.replace(ROOT + '/', '')}\n`);

// ── Console summary ───────────────────────────────────────────────────────────

console.log(`Second Brain — ${reportDate}`);
console.log(`  Artículos   : ${articles.size}`);
console.log(`  Pendientes  : ${pendingCount}`);
console.log(`  Huérfanos   : ${orphans.length}`);
console.log(`  Sin fuentes : ${noSources.length}`);
console.log(`  Links rotos : ${gaps.length}`);
console.log(`  Solapamientos: ${contradictions.length}\n`);

// ── Optional: git push ────────────────────────────────────────────────────────

if (PUSH) {
  try {
    execSync(`git -C "${ROOT}" add outputs/${reportDate}-health-check.md`, { stdio: 'inherit' });
    execSync(`git -C "${ROOT}" commit -m "chore: monthly health check report ${reportDate}"`, { stdio: 'inherit' });
    execSync(`git -C "${ROOT}" push -u origin master`, { stdio: 'inherit' });
    console.log('✅  Pushed to origin/master');
  } catch (e) {
    console.error('Git push failed:', e.message);
  }
}

// ── Optional: Telegram ────────────────────────────────────────────────────────

if (!TELEGRAM) process.exit(0);

loadEnv();
const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALLOWED_USER_ID;
if (!TOKEN || !CHAT_ID) {
  console.error('Telegram credentials not found in .env — skipping notification.');
  process.exit(0);
}

const summaryLines = [
  `*Health Check — ${reportDate}*`,
  ``,
  `📚 Artículos: ${articles.size} | Pendientes: ${pendingCount}`,
  `🔗 Huérfanos: ${orphans.length} | Sin fuentes: ${noSources.length}`,
  `❓ Links rotos: ${gaps.length} | Solapamientos: ${contradictions.length}`,
];
if (gaps.length > 0) {
  summaryLines.push(``, `*Top temas candidatos:*`);
  gaps.slice(0, 3).forEach((g, i) =>
    summaryLines.push(`${i + 1}. \`[[${g.slug}]]\` — ${g.count}x referenciado`)
  );
}

try {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: summaryLines.join('\n'), parse_mode: 'Markdown' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
  console.log('✅  Summary sent to Telegram.');
} catch (err) {
  console.error(`Telegram error: ${err.message}`);
}
