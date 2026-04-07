#!/usr/bin/env node
/**
 * second-brain compile
 * Runs the LLM compilation step via Claude CLI.
 *
 * Usage:
 *   node bin/compile.mjs             Compile all pending items
 *   node bin/compile.mjs --dry-run   Preview without executing
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { log } from './lib/logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');
const PROMPT_PATH = join(ROOT, 'prompts', 'compile.md');

const [,, flag] = process.argv;

if (flag === '--help' || flag === '-h') {
  console.log(`
Usage:
  node bin/compile.mjs             Compile all pending items into wiki articles
  node bin/compile.mjs --dry-run   Show what would be compiled without executing
`);
  process.exit(0);
}

const dryRun = flag === '--dry-run';

function readPending() {
  try {
    return JSON.parse(readFileSync(PENDING_PATH, 'utf8'));
  } catch {
    return { pending: [], lastCompile: null };
  }
}

const state = readPending();

if (state.pending.length === 0) {
  console.log('✓ No pending items to compile.');
  process.exit(0);
}

log('info', 'compile:start', { pending: state.pending.length });
console.log(`\nSecond Brain — Compile`);
console.log(`   Pending items: ${state.pending.length}\n`);
state.pending.forEach(item => {
  console.log(`   - [${item.type}] ${item.path}`);
});
console.log('');

if (dryRun) {
  console.log('(dry-run: compilation not executed)');
  process.exit(0);
}

// Paso previo: routing incremental (genera .state/routing.json)
const ROUTING_PATH = join(ROOT, '.state', 'routing.json');
const ROUTE_SCRIPT = join(ROOT, 'bin', 'route.mjs');

console.log('Step 1/2: Computing incremental routing...\n');
try {
  execFileSync(process.execPath, [ROUTE_SCRIPT, '--skip-llm'], { cwd: ROOT, stdio: 'inherit' });
} catch {
  log('warn', 'compile:routing failed', {});
  console.warn('Routing failed, compiling without incremental context.\n');
}

// Leer routing para añadirlo al prompt de compilación
let routingContext = '';
if (existsSync(ROUTING_PATH)) {
  try {
    const routing = JSON.parse(readFileSync(ROUTING_PATH, 'utf8'));
    routingContext = `\n\n## Incremental routing (use this to compile only affected articles)\n\n` +
      routing.routes.map(r =>
        `- ${r.path} → acción: ${r.routing.action}, artículos: [${(r.routing.articles || []).join(', ')}]`
      ).join('\n');
  } catch { /* si falla, compilar sin routing */ }
}

if (!existsSync(PROMPT_PATH)) {
  console.error(`Error: no se encuentra el prompt en ${PROMPT_PATH}`);
  process.exit(1);
}

const prompt = readFileSync(PROMPT_PATH, 'utf8') + routingContext;

console.log('\nStep 2/2: Running Claude to compile...\n');

try {
  execFileSync('claude', ['-p'], {
    cwd: ROOT,
    input: prompt,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  log('info', 'compile:done', { pending: state.pending.length });
} catch (err) {
  if (err.status && err.status !== 0) {
    log('error', 'compile:failed', { status: err.status });
    console.error(`\nError en la compilación (status ${err.status})`);
    process.exit(1);
  }
}
