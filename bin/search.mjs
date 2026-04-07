#!/usr/bin/env node
/**
 * second-brain search
 * Usage:
 *   node bin/search.mjs <query>         Search wiki/ by content
 *   node bin/search.mjs --tags <tag>    Search by frontmatter tag
 *   node bin/search.mjs --recent [n]    Last n modified articles (default: 10)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WIKI = join(ROOT, 'wiki');

const [,, flag, ...rest] = process.argv;

const HELP = `
Usage:
  node bin/search.mjs <query>         Search wiki articles by content
  node bin/search.mjs --tags <tag>    Search articles by tag
  node bin/search.mjs --recent [n]    List last n modified articles (default: 10)
`;

if (!flag || flag === '--help' || flag === '-h') {
  console.log(HELP);
  process.exit(0);
}

if (flag === '--recent') {
  const n = parseInt(rest[0]) || 10;
  if (!existsSync(WIKI)) { console.log('Wiki is empty.'); process.exit(0); }

  const files = readdirSync(WIKI)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, mtime: statSync(join(WIKI, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n);

  console.log(`\nLast ${n} modified articles:\n`);
  files.forEach(f => {
    const date = f.mtime.toISOString().slice(0, 10);
    console.log(`  ${date}  ${f.name.replace('.md', '')}`);
  });
  console.log('');
  process.exit(0);
}

if (flag === '--tags') {
  const tag = rest[0];
  if (!tag) { console.error('Missing tag'); process.exit(1); }
  if (!existsSync(WIKI)) { console.log('Wiki is empty.'); process.exit(0); }

  const files = readdirSync(WIKI).filter(f => f.endsWith('.md'));
  const matches = [];
  for (const file of files) {
    const content = readFileSync(join(WIKI, file), 'utf8');
    if (content.includes(`[${tag}`) || content.includes(` ${tag}`)) {
      matches.push(file.replace('.md', ''));
    }
  }

  if (matches.length === 0) {
    console.log(`No articles found with tag "${tag}"`);
  } else {
    console.log(`\nArticles tagged "${tag}":\n`);
    matches.forEach(m => console.log(`  - ${m}`));
    console.log('');
  }
  process.exit(0);
}

// Content search using grep
const query = [flag, ...rest].join(' ');
if (!existsSync(WIKI)) { console.log('Wiki is empty.'); process.exit(0); }

const r1 = spawnSync('grep', ['-ril', query, WIKI], { encoding: 'utf8' });

if (r1.status !== 0 || !r1.stdout.trim()) {
  console.log(`No se encontraron resultados para "${query}"`);
  process.exit(0);
}

const matchedFiles = r1.stdout.trim().split('\n').filter(Boolean);
console.log(`\nResults for "${query}" (${matchedFiles.length} articles):\n`);

for (const filePath of matchedFiles) {
  const name = filePath.split('/').pop().replace('.md', '');
  const r2 = spawnSync('grep', ['-in', query, filePath], { encoding: 'utf8' });
  const lines = (r2.stdout || '').trim().split('\n').slice(0, 3).filter(Boolean);
  console.log(`  ${name}`);
  lines.forEach(l => console.log(`     ${l}`));
  console.log('');
}
