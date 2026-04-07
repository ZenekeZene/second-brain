#!/usr/bin/env node
/**
 * second-brain graph visualizer
 * Interactive d3-force node graph of [[wikilinks]] between articles.
 *
 * Usage:
 *   node bin/graph.mjs              Generate + open in browser
 *   node bin/graph.mjs --no-open   Generate without opening
 *   node bin/graph.mjs --help
 *
 * Also available at http://localhost:4321/graph when the wiki viewer is running.
 * Requires an internet connection to load d3 from CDN.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { buildGraphHtml } from './lib/graph.mjs';
import { log } from './lib/logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node bin/graph.mjs             Generate graph + open in browser
  node bin/graph.mjs --no-open  Generate without opening

Also available at /graph in the wiki viewer (npm run wiki).
Requires internet connection to load d3 from CDN.
`);
  process.exit(0);
}

const noOpen = process.argv.includes('--no-open');
const today  = new Date().toISOString().slice(0, 10);
const outDir = join(ROOT, 'outputs');
const outFile = join(outDir, `${today}-graph.html`);

mkdirSync(outDir, { recursive: true });

const html = buildGraphHtml(ROOT);
writeFileSync(outFile, html);

log('info', 'graph:generated', { file: outFile });
console.log(`Graph saved to outputs/${today}-graph.html`);

if (!noOpen) {
  try {
    execFileSync('open', [outFile]);
  } catch {
    console.log(`Open in your browser: file://${outFile}`);
  }
}
