#!/usr/bin/env node
/**
 * second-brain timeline view
 * Generates a self-contained HTML report visualizing how topics evolved over time.
 *
 * Usage:
 *   node bin/timeline.mjs              Generate + open in browser
 *   node bin/timeline.mjs --no-open   Generate without opening
 *   node bin/timeline.mjs --help
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { buildTimelineHtml } from './lib/timeline.mjs';
import { log } from './lib/logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node bin/timeline.mjs             Generate timeline + open in browser
  node bin/timeline.mjs --no-open  Generate without opening
`);
  process.exit(0);
}

const noOpen = process.argv.includes('--no-open');
const today  = new Date().toISOString().slice(0, 10);
const outDir = join(ROOT, 'outputs');
const outFile = join(outDir, `${today}-timeline.html`);

mkdirSync(outDir, { recursive: true });

const html = buildTimelineHtml(ROOT);
writeFileSync(outFile, html);

log('info', 'timeline:generated', { file: outFile });
console.log(`Timeline saved to outputs/${today}-timeline.html`);

if (!noOpen) {
  try {
    execFileSync('open', [outFile]);
  } catch {
    console.log(`Open in your browser: file://${outFile}`);
  }
}
