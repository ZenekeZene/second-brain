#!/usr/bin/env node
/**
 * second-brain route
 * Decide qué artículos wiki debe tocar cada raw item pendiente.
 *
 * Paso A (rápido): matching por tags y keywords — grep en wiki/
 * Paso B (preciso): LLM ligero confirma candidatos — solo lee títulos+tags
 *
 * Uso:
 *   node bin/route.mjs             → genera .state/routing.json
 *   node bin/route.mjs --dry-run   → imprime routing sin escribir
 *   node bin/route.mjs --skip-llm  → solo paso A (sin claude)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');
const ROUTING_PATH = join(ROOT, '.state', 'routing.json');
const WIKI_DIR = join(ROOT, 'wiki');
const PROMPT_PATH = join(ROOT, 'prompts', 'route.md');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipLlm = args.includes('--skip-llm');

// ── helpers ──────────────────────────────────────────────────────────────────

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) fm[key.trim()] = rest.join(':').trim();
  }
  // Parsear tags: [tag1, tag2]
  if (fm.tags) {
    fm.tags = fm.tags.replace(/[\[\]]/g, '').split(',').map(t => t.trim().toLowerCase());
  }
  return fm;
}

function extractKeywords(content) {
  // Eliminar frontmatter y extraer palabras significativas
  const body = content.replace(/^---[\s\S]*?---\n/, '').slice(0, 1000);
  const words = body.toLowerCase()
    .replace(/[^a-záéíóúüñ\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4)
    .filter(w => !STOPWORDS.has(w));
  // Contar frecuencia y devolver top 20
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
}

const STOPWORDS = new Set([
  'para', 'como', 'esto', 'este', 'esta', 'estos', 'estas', 'desde', 'hasta',
  'entre', 'sobre', 'tiene', 'puede', 'cuando', 'donde', 'todos', 'todas',
  'cada', 'menos', 'mismo', 'misma', 'porque', 'pero', 'aunque', 'también',
  'that', 'this', 'with', 'from', 'they', 'have', 'more', 'than', 'will',
  'been', 'their', 'what', 'which', 'when', 'each', 'there', 'would', 'about',
  'into', 'your', 'some', 'them', 'then', 'could', 'other', 'after', 'also',
]);

// ── cargar wiki ───────────────────────────────────────────────────────────────

function loadWikiIndex() {
  if (!existsSync(WIKI_DIR)) return [];
  return readdirSync(WIKI_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const path = `wiki/${f}`;
      const content = readFileSync(join(ROOT, path), 'utf8');
      const fm = parseFrontmatter(content);
      const title = content.match(/^#\s+(.+)$/m)?.[1] || f.replace('.md', '');
      return {
        path,
        title,
        tags: fm.tags || [],
        // Primeras 200 chars del body para scoring adicional
        snippet: content.replace(/^---[\s\S]*?---\n/, '').slice(0, 200).toLowerCase(),
      };
    });
}

// ── paso A: scoring por tags + keywords ──────────────────────────────────────

function scoreArticles(wikiIndex, keywords, rawTags) {
  return wikiIndex
    .map(article => {
      let score = 0;
      const matched = { tags: [], keywords: [] };

      // Tags exactos: peso alto
      for (const tag of rawTags) {
        if (article.tags.includes(tag)) {
          score += 3;
          matched.tags.push(tag);
        }
      }

      // Keywords en snippet del artículo: peso medio
      for (const kw of keywords) {
        if (article.snippet.includes(kw) || article.title.toLowerCase().includes(kw)) {
          score += 1;
          matched.keywords.push(kw);
        }
      }

      // Keywords en título: peso extra
      for (const kw of keywords) {
        if (article.title.toLowerCase().includes(kw)) score += 1;
      }

      return { ...article, score, matched };
    })
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ── paso B: LLM routing ───────────────────────────────────────────────────────

function llmRoute(pendingItem, candidates, wikiIndex) {
  if (!existsSync(PROMPT_PATH)) {
    console.warn('  ⚠ No se encontró prompts/route.md — saltando LLM routing');
    return candidates;
  }

  // Construir contexto compacto para el LLM
  const rawContent = (() => {
    try { return readFileSync(join(ROOT, pendingItem.path), 'utf8').slice(0, 500); }
    catch { return '(no disponible)'; }
  })();

  const allArticlesList = wikiIndex
    .map(a => `- ${a.path}: "${a.title}" [${a.tags.join(', ')}]`)
    .join('\n');

  const candidatesList = candidates.length > 0
    ? candidates.map(c => `- ${c.path} (score: ${c.score}, tags: ${c.matched.tags.join(',')}, kw: ${c.matched.keywords.slice(0, 3).join(',')})`).join('\n')
    : '(ninguno encontrado por grep/tags)';

  const prompt = `${readFileSync(PROMPT_PATH, 'utf8')}

---

## Item a routear

Tipo: ${pendingItem.type}
Path: ${pendingItem.path}
Contenido (extracto):
${rawContent}

## Candidatos del paso A (grep/tags)

${candidatesList}

## Todos los artículos wiki disponibles

${allArticlesList}

---

Responde SOLO con JSON válido:
{
  "action": "update" | "create" | "both",
  "articles": ["wiki/nombre.md"],
  "new_article_name": "nombre-kebab-case" | null,
  "confidence": "high" | "medium" | "low",
  "reason": "una línea"
}`;

  try {
    const result = execFileSync('claude', ['-p'], {
      input: prompt,
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 30000,
    });
    // Extraer JSON de la respuesta
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON en respuesta');
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn(`  ⚠ LLM routing falló (${err.message.slice(0, 60)}) — usando candidatos de paso A`);
    return {
      action: candidates.length > 0 ? 'update' : 'create',
      articles: candidates.map(c => c.path),
      confidence: 'low',
      reason: 'fallback a paso A',
    };
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const state = readJSON(PENDING_PATH, { pending: [] });

if (state.pending.length === 0) {
  console.log('✓ No hay items pendientes.');
  process.exit(0);
}

const wikiIndex = loadWikiIndex();
console.log(`\n🗺  Routing ${state.pending.length} items → ${wikiIndex.length} artículos wiki\n`);

const routes = [];

for (const item of state.pending) {
  console.log(`  📄 ${item.path} (${item.type})`);

  // Leer contenido del raw item
  let rawContent = '';
  try { rawContent = readFileSync(join(ROOT, item.path), 'utf8'); }
  catch { console.log('     ⚠ No se pudo leer el fichero'); continue; }

  const fm = parseFrontmatter(rawContent);
  const rawTags = fm.tags || [];
  const keywords = extractKeywords(rawContent);

  // Paso A
  const candidates = scoreArticles(wikiIndex, keywords, rawTags);
  console.log(`     A) ${candidates.length} candidatos: ${candidates.slice(0, 3).map(c => c.path.replace('wiki/', '')).join(', ') || 'ninguno'}`);

  let routing;

  if (skipLlm) {
    routing = {
      action: candidates.length > 0 ? 'update' : 'create',
      articles: candidates.slice(0, 3).map(c => c.path),
      confidence: 'medium',
      reason: 'solo paso A (--skip-llm)',
    };
  } else {
    // Paso B — solo si hay candidatos plausibles o wiki tiene artículos
    routing = llmRoute(item, candidates.slice(0, 5), wikiIndex);
    console.log(`     B) ${routing.action} → [${routing.articles?.join(', ')}] (${routing.confidence})`);
  }

  routes.push({
    path: item.path,
    type: item.type,
    keywords: keywords.slice(0, 10),
    candidates: candidates.slice(0, 5).map(c => ({ path: c.path, score: c.score })),
    routing,
  });

  console.log('');
}

const output = {
  generated: new Date().toISOString(),
  routes,
};

if (dryRun) {
  console.log('\n--- routing.json (dry-run) ---');
  console.log(JSON.stringify(output, null, 2));
} else {
  writeFileSync(ROUTING_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`✓ Routing guardado en .state/routing.json`);
}
