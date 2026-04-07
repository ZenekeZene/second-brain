/**
 * autotag.mjs — inferencia automática de tags para items raw
 *
 * Paso A (sync): keyword extraction + diccionario estático
 * Paso B (async): LLM ligero vía claude -p — solo si A devuelve <2 tags
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const WIKI_DIR = join(ROOT, 'wiki');

// ── Diccionario: término → tags que implica ──────────────────────────────────

const TERM_MAP = {
  // Arquitectura / Backend
  'microservicio':   ['arquitectura', 'microservicios', 'distribuido'],
  'microservice':    ['arquitectura', 'microservicios', 'distribuido'],
  'docker':          ['devops', 'backend'],
  'kubernetes':      ['devops', 'backend', 'distribuido'],
  'k8s':             ['devops', 'backend'],
  'api':             ['backend', 'arquitectura'],
  'rest':            ['backend', 'arquitectura'],
  'graphql':         ['backend', 'arquitectura'],
  'event-driven':    ['arquitectura', 'distribuido'],
  'circuit breaker': ['arquitectura', 'microservicios'],
  'hexagonal':       ['arquitectura', 'backend'],
  'ddd':             ['arquitectura', 'backend'],
  'serverless':      ['arquitectura', 'cloud', 'devops'],
  'twelve-factor':   ['arquitectura', 'cloud', 'deployment'],
  '12 factor':       ['arquitectura', 'cloud', 'deployment'],
  'cache':           ['cache', 'distribuido', 'backend'],
  'redis':           ['cache', 'backend', 'distribuido'],
  'cap theorem':     ['cap', 'distribuido', 'cache'],
  'consistencia':    ['distribuido', 'cache'],
  'disponibilidad':  ['distribuido', 'cache'],

  // Frontend / Web
  'css':             ['css', 'frontend', 'web'],
  'javascript':      ['javascript', 'frontend'],
  'typescript':      ['javascript', 'frontend'],
  'react':           ['javascript', 'frontend'],
  'vue':             ['javascript', 'frontend'],
  'svelte':          ['javascript', 'frontend'],
  'html':            ['frontend', 'web'],
  'canvas':          ['canvas', 'frontend', 'creatividad'],
  'webgl':           ['webgl', 'frontend', 'creatividad'],
  'webgpu':          ['webgl', 'frontend', 'web'],
  'animacion':       ['css', 'frontend', 'creatividad'],
  'animation':       ['css', 'frontend', 'creatividad'],
  'accesibilidad':   ['frontend', 'web'],
  'accessibility':   ['frontend', 'web'],
  'performance':     ['frontend', 'web'],
  'rendimiento':     ['frontend', 'web'],
  'node':            ['javascript', 'backend'],
  'npm':             ['javascript', 'backend'],
  'bun':             ['javascript', 'backend'],
  'deno':            ['javascript', 'backend'],

  // IA / LLMs
  'llm':             ['ia', 'llm'],
  'gpt':             ['ia', 'llm', 'gpt'],
  'claude':          ['ia', 'llm', 'claude'],
  'openai':          ['ia', 'llm', 'openai'],
  'anthropic':       ['ia', 'llm', 'claude'],
  'prompt':          ['ia', 'llm'],
  'embedding':       ['ia', 'llm'],
  'rag':             ['ia', 'llm'],
  'agente':          ['ia', 'llm', 'agentes'],
  'agent':           ['ia', 'llm', 'agentes'],
  'fine-tuning':     ['ia', 'llm'],
  'transformer':     ['ia', 'llm'],
  'inteligencia artificial': ['ia'],
  'machine learning': ['ia'],
  'whisper':         ['ia', 'llm'],
  'diffusion':       ['ia'],
  'imagen':          ['ia'],
  'midjourney':      ['ia'],

  // Carrera / Negocio
  'startup':         ['startups', 'negocio', 'emprendimiento'],
  'saas':            ['saas', 'negocio', 'startups'],
  'freelance':       ['freelance', 'carrera'],
  'salario':         ['salario', 'carrera'],
  'entrevista':      ['carrera', 'trabajo'],
  'interview':       ['carrera', 'trabajo'],
  'junior':          ['carrera', 'junior'],
  'senior':          ['carrera', 'senior'],
  'producto':        ['producto', 'negocio'],
  'product':         ['producto', 'negocio'],
  'mrr':             ['saas', 'negocio'],
  'revenue':         ['negocio'],
  'yc':              ['startups', 'yc'],
  'y combinator':    ['startups', 'yc'],
  'paul graham':     ['startups', 'paul-graham'],
  'emprender':       ['emprendimiento', 'negocio'],

  // DevOps / Tools
  'git':             ['devops'],
  'ci/cd':           ['devops'],
  'github':          ['devops'],
  'linux':           ['devops'],
  'bash':            ['devops'],
  'python':          ['python', 'backend'],
  'rust':            ['backend'],
  'go ':             ['backend'],
  'golang':          ['backend'],

  // Abstracto / Programación general
  'abstraccion':     ['abstracciones', 'programación'],
  'abstraction':     ['abstracciones', 'programación'],
  'refactor':        ['programación'],
  'test':            ['programación'],
  'debugging':       ['programación'],
  'complejidad':     ['complejidad', 'programación'],
  'pattern':         ['arquitectura', 'programación'],
  'patron':          ['arquitectura', 'programación'],
};

// ── Normalización ─────────────────────────────────────────────────────────────

function normalize(text) {
  return text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ── Paso A: keyword extraction ────────────────────────────────────────────────

export function inferTags(text, existingWikiTags = null) {
  const normalized = normalize(text);
  const found = new Set();

  // Buscar términos del diccionario en el texto
  for (const [term, tags] of Object.entries(TERM_MAP)) {
    if (normalized.includes(normalize(term))) {
      tags.forEach(t => found.add(t));
    }
  }

  // Buscar tags de la wiki directamente en el texto (vocabulario consistente)
  const wikiTags = existingWikiTags || loadWikiTags();
  for (const tag of wikiTags) {
    if (normalized.includes(normalize(tag)) && !found.has(tag)) {
      found.add(tag);
    }
  }

  // Máximo 5 tags, priorizando los más específicos (más cortos = más generales, al final)
  return [...found].slice(0, 5);
}

// ── Cargar tags existentes de la wiki ─────────────────────────────────────────

let _wikiTagsCache = null;

export function loadWikiTags() {
  if (_wikiTagsCache) return _wikiTagsCache;
  const tags = new Set();
  if (!existsSync(WIKI_DIR)) return tags;
  try {
    for (const file of readdirSync(WIKI_DIR).filter(f => f.endsWith('.md'))) {
      const content = readFileSync(join(WIKI_DIR, file), 'utf8');
      const match = content.match(/^tags:\s*\[([^\]]+)\]/m);
      if (match) {
        match[1].split(',').map(t => t.trim().toLowerCase()).forEach(t => tags.add(t));
      }
    }
  } catch {}
  _wikiTagsCache = tags;
  return tags;
}

// ── Paso B: LLM fallback ──────────────────────────────────────────────────────

export async function inferTagsLLM(text) {
  const wikiTags = [...loadWikiTags()].join(', ');
  const prompt = `Dado este texto, sugiere entre 3 y 5 tags en formato JSON array.
Usa preferentemente tags de esta lista si aplican: ${wikiTags || 'sin lista previa'}.
Usa solo minúsculas, sin espacios (usa guion si es necesario), máximo 5 tags.
Responde SOLO con el array JSON, sin texto adicional.

Texto:
${text.slice(0, 500)}`;

  try {
    const result = execFileSync('claude', ['-p'], {
      input: prompt,
      encoding: 'utf8',
      timeout: 20000,
    });
    const match = result.match(/\[[\s\S]*?\]/);
    if (!match) throw new Error('No JSON array en respuesta');
    const tags = JSON.parse(match[0]);
    return tags.map(t => String(t).toLowerCase().trim()).slice(0, 5);
  } catch {
    return [];
  }
}

// ── Función principal: A + B si es necesario ─────────────────────────────────

export async function autoTag(text) {
  const tagsA = inferTags(text);
  if (tagsA.length >= 2) return tagsA;

  // Paso B solo si A devuelve <2 tags
  const tagsB = await inferTagsLLM(text);
  const merged = [...new Set([...tagsA, ...tagsB])].slice(0, 5);
  return merged.length > 0 ? merged : tagsA;
}
