#!/usr/bin/env node
/**
 * second-brain search
 * Uso:
 *   node bin/search.mjs <query>         → busca en wiki/ por contenido
 *   node bin/search.mjs --tags <tag>    → busca por tag en frontmatter
 *   node bin/search.mjs --recent [n]    → últimos n artículos modificados (default: 10)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WIKI = join(ROOT, 'wiki');

const [,, flag, ...rest] = process.argv;

if (!flag) {
  console.log(`
Uso:
  node bin/search.mjs <query>
  node bin/search.mjs --tags <tag>
  node bin/search.mjs --recent [n]
`);
  process.exit(0);
}

if (flag === '--recent') {
  const n = parseInt(rest[0]) || 10;
  if (!existsSync(WIKI)) { console.log('Wiki vacía.'); process.exit(0); }

  const files = readdirSync(WIKI)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, mtime: statSync(join(WIKI, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n);

  console.log(`\n📚 Últimos ${n} artículos modificados:\n`);
  files.forEach(f => {
    const date = f.mtime.toISOString().slice(0, 10);
    console.log(`  ${date}  ${f.name.replace('.md', '')}`);
  });
  console.log('');
  process.exit(0);
}

if (flag === '--tags') {
  const tag = rest[0];
  if (!tag) { console.error('Falta el tag'); process.exit(1); }
  if (!existsSync(WIKI)) { console.log('Wiki vacía.'); process.exit(0); }

  const files = readdirSync(WIKI).filter(f => f.endsWith('.md'));
  const matches = [];
  for (const file of files) {
    const content = readFileSync(join(WIKI, file), 'utf8');
    if (content.includes(`[${tag}`) || content.includes(` ${tag}`)) {
      matches.push(file.replace('.md', ''));
    }
  }

  if (matches.length === 0) {
    console.log(`No se encontraron artículos con el tag "${tag}"`);
  } else {
    console.log(`\n🏷️  Artículos con tag "${tag}":\n`);
    matches.forEach(m => console.log(`  - ${m}`));
    console.log('');
  }
  process.exit(0);
}

// Búsqueda por contenido usando grep
const query = [flag, ...rest].join(' ');
if (!existsSync(WIKI)) { console.log('Wiki vacía.'); process.exit(0); }

try {
  const result = execSync(
    `grep -ril "${query.replace(/"/g, '\\"')}" "${WIKI}"`,
    { encoding: 'utf8' }
  ).trim();

  if (!result) {
    console.log(`No se encontraron resultados para "${query}"`);
    process.exit(0);
  }

  const matchedFiles = result.split('\n').filter(Boolean);
  console.log(`\n🔍 Resultados para "${query}" (${matchedFiles.length} artículos):\n`);

  for (const filePath of matchedFiles) {
    const name = filePath.split('/').pop().replace('.md', '');
    // Mostrar líneas con contexto
    try {
      const lines = execSync(
        `grep -in "${query.replace(/"/g, '\\"')}" "${filePath}"`,
        { encoding: 'utf8' }
      ).trim().split('\n').slice(0, 3);
      console.log(`  📄 ${name}`);
      lines.forEach(l => console.log(`     ${l}`));
      console.log('');
    } catch {
      console.log(`  📄 ${name}\n`);
    }
  }
} catch {
  console.log(`No se encontraron resultados para "${query}"`);
}
