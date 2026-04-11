#!/usr/bin/env node
/**
 * second-brain ingest CLI
 * Usage:
 *   node bin/ingest.mjs url <url> [--title "Title"]
 *   node bin/ingest.mjs note "Note text"
 *   node bin/ingest.mjs bookmark <url>
 *   node bin/ingest.mjs file <path>
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { log } from './lib/logger.mjs';
import { shouldCompile, triggerMessage } from './lib/reactive.mjs';
import {
  ingestUrl, ingestNote, ingestBookmark, ingestFile,
} from './lib/ingest-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const HELP = `
Usage:
  node bin/ingest.mjs url <url> [--title "Title"]   Fetch and save a web article
  node bin/ingest.mjs note "Note text"               Save a quick note
  node bin/ingest.mjs bookmark <url>                 Save a URL for later
  node bin/ingest.mjs file <path>                    Ingest a local file
`;

function checkReactive() {
  try {
    const state = JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8'));
    const trigger = shouldCompile(state);
    if (!trigger) return;
    console.log(`\nReactive compilation triggered: ${triggerMessage(trigger)}`);
    execFileSync(process.execPath, [join(__dirname, 'compile.mjs')], { cwd: ROOT, stdio: 'inherit' });
  } catch { /* compile prints its own errors */ }
}

const [,, command, ...args] = process.argv;

if (!command || command === '--help' || command === '-h') {
  console.log(HELP);
  process.exit(0);
}

switch (command) {
  case 'url': {
    const url = args[0];
    const titleIdx = args.indexOf('--title');
    const title = titleIdx !== -1 ? args[titleIdx + 1] : null;
    if (!url) { console.error('Missing URL'); process.exit(1); }
    try {
      const r = await ingestUrl(ROOT, url, title);
      console.log(`✓ Saved to ${r.path}`);
      console.log(`  ${r.pending} item(s) pending compilation.`);
      checkReactive();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    break;
  }
  case 'note': {
    const text = args.join(' ');
    if (!text) { console.error('Missing note text'); process.exit(1); }
    try {
      const r = await ingestNote(ROOT, text);
      console.log(`✓ Note saved to ${r.path}`);
      console.log(`  ${r.pending} item(s) pending compilation.`);
      checkReactive();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    break;
  }
  case 'bookmark': {
    const url = args[0];
    if (!url) { console.error('Missing URL'); process.exit(1); }
    try {
      const r = await ingestBookmark(ROOT, url);
      console.log(`✓ Bookmark saved to ${r.path}`);
      console.log(`  ${r.pending} item(s) pending compilation.`);
      checkReactive();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    break;
  }
  case 'file': {
    const filePath = args[0];
    if (!filePath) { console.error('Missing file path'); process.exit(1); }
    if (!existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }
    try {
      const buffer = readFileSync(filePath);
      const filename = basename(filePath);
      const ext = extname(filePath).toLowerCase();
      const mimeMap = { '.md': 'text/plain', '.txt': 'text/plain', '.pdf': 'application/pdf' };
      const mimeType = mimeMap[ext] || 'application/octet-stream';
      const r = await ingestFile(ROOT, buffer, filename, mimeType);
      console.log(`✓ File saved to ${r.path}`);
      console.log(`  ${r.pending} item(s) pending compilation.`);
      checkReactive();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.log(HELP);
    process.exit(1);
}
