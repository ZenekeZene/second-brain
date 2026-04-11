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

// Load .env so ANTHROPIC_API_KEY is available for Claude CLI
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}

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

// Pre-step: incremental routing (generates .state/routing.json)
const ROUTING_PATH = join(ROOT, '.state', 'routing.json');
const ROUTE_SCRIPT = join(ROOT, 'bin', 'route.mjs');

console.log('Step 1/2: Computing incremental routing...\n');
try {
  execFileSync(process.execPath, [ROUTE_SCRIPT, '--skip-llm'], { cwd: ROOT, stdio: 'inherit' });
} catch {
  log('warn', 'compile:routing failed', {});
  console.warn('Routing failed, compiling without incremental context.\n');
}

// Read routing to append it to the compilation prompt
let routingContext = '';
if (existsSync(ROUTING_PATH)) {
  try {
    const routing = JSON.parse(readFileSync(ROUTING_PATH, 'utf8'));
    routingContext = `\n\n## Incremental routing (use this to compile only affected articles)\n\n` +
      routing.routes.map(r =>
        `- ${r.path} → action: ${r.routing.action}, articles: [${(r.routing.articles || []).join(', ')}]`
      ).join('\n');
  } catch { /* if it fails, compile without routing */ }
}

if (!existsSync(PROMPT_PATH)) {
  console.error(`Error: prompt not found at ${PROMPT_PATH}`);
  process.exit(1);
}

const prompt = readFileSync(PROMPT_PATH, 'utf8') + routingContext;

console.log('\nStep 2/2: Running Claude to compile...\n');

try {
  const claudeEnv = { ...process.env };
  if (process.env.ANTHROPIC_API_KEY) {
    claudeEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  execFileSync('claude', ['-p'], {
    cwd: ROOT,
    input: prompt,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: claudeEnv,
  });
  log('info', 'compile:done', { pending: state.pending.length });

  // Sync to Raspberry Pi if configured
  if (process.env.PI_HOST && process.env.PI_USER) {
    try {
      execFileSync(process.execPath, [join(ROOT, 'bin', 'sync-pi.mjs')], {
        cwd: ROOT,
        stdio: 'inherit',
      });
    } catch {
      console.warn('Warning: Pi sync failed (wiki compiled successfully).');
    }
  }
} catch (err) {
  const status = err.status ?? err.code ?? 'unknown';
  log('error', 'compile:failed', { status, message: err.message });
  console.error(`\nCompilation error: ${err.message} (${status})`);
  process.exit(1);
}
