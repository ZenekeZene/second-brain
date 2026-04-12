#!/usr/bin/env node
/**
 * second-brain compile (Claude Code mode)
 * Runs the LLM compilation step via Claude CLI (`claude -p`).
 * Covered by Claude Team / Max subscriptions — no per-token API cost.
 *
 * Requires: `claude` CLI installed and authenticated
 *   npm install -g @anthropic-ai/claude-code
 *   claude login
 *
 * Usage:
 *   node bin/compile.mjs             Compile all pending items
 *   node bin/compile.mjs --dry-run   Preview without executing
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { log } from './lib/logger.mjs';
import { notify, postCompile } from './lib/post-compile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');
const ROUTING_PATH = join(ROOT, '.state', 'routing.json');
const PROMPT_PATH = join(ROOT, 'prompts', 'compile.md');
const ROUTE_SCRIPT = join(ROOT, 'bin', 'route.mjs');

// Load .env so env vars are available for Claude CLI
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
  node bin/compile.mjs             Compile all pending items via Claude CLI
  node bin/compile.mjs --dry-run   Show what would be compiled without executing
`);
  process.exit(0);
}

const dryRun = flag === '--dry-run';

function readPending() {
  try { return JSON.parse(readFileSync(PENDING_PATH, 'utf8')); }
  catch { return { pending: [], lastCompile: null }; }
}

// Snapshot mtime of all wiki/*.md + INDEX.md before compilation.
// Returns a Map<relativePath, mtimeMs>.
function snapshotMtimes() {
  const snap = new Map();
  const wikiDir = join(ROOT, 'wiki');
  if (existsSync(wikiDir)) {
    for (const f of readdirSync(wikiDir).filter(f => f.endsWith('.md'))) {
      snap.set('wiki/' + f, statSync(join(ROOT, 'wiki', f)).mtimeMs);
    }
  }
  const indexPath = join(ROOT, 'INDEX.md');
  if (existsSync(indexPath)) {
    snap.set('INDEX.md', statSync(indexPath).mtimeMs);
  }
  return snap;
}

// Compare current mtimes to snapshot and return files that were written or created.
function diffMtimes(before) {
  const written = [];
  const wikiDir = join(ROOT, 'wiki');
  if (existsSync(wikiDir)) {
    for (const f of readdirSync(wikiDir).filter(f => f.endsWith('.md'))) {
      const rel = 'wiki/' + f;
      const now = statSync(join(ROOT, 'wiki', f)).mtimeMs;
      if (!before.has(rel) || before.get(rel) !== now) written.push(rel);
    }
  }
  const indexPath = join(ROOT, 'INDEX.md');
  if (existsSync(indexPath)) {
    const now = statSync(indexPath).mtimeMs;
    if (!before.has('INDEX.md') || before.get('INDEX.md') !== now) written.push('INDEX.md');
  }
  return written;
}

async function main() {
  const state = readPending();

  if (state.pending.length === 0) {
    console.log('✓ No pending items to compile.');
    process.exit(0);
  }

  log('info', 'compile:start', { pending: state.pending.length });
  console.log(`\nSecond Brain — Compile (Claude Code)`);
  console.log(`   Pending items: ${state.pending.length}\n`);
  state.pending.forEach(item => console.log(`   - [${item.type}] ${item.path}`));
  console.log('');

  if (dryRun) {
    console.log('(dry-run: compilation not executed)');
    process.exit(0);
  }

  // Step 1: incremental routing (pure Node.js, no LLM)
  console.log('Step 1/2: Computing incremental routing...\n');
  try {
    execFileSync(process.execPath, [ROUTE_SCRIPT, '--skip-llm'], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    log('warn', 'compile:routing-failed', {});
    console.warn('Routing failed — compiling without incremental context.\n');
  }

  // Append routing context to prompt
  let routingContext = '';
  if (existsSync(ROUTING_PATH)) {
    try {
      const routing = JSON.parse(readFileSync(ROUTING_PATH, 'utf8'));
      routingContext = `\n\n## Incremental routing (use this to compile only affected articles)\n\n` +
        routing.routes.map(r =>
          `- ${r.path} → action: ${r.routing.action}, articles: [${(r.routing.articles || []).join(', ')}]`
        ).join('\n');
    } catch { /* compile without routing if parse fails */ }
  }

  if (!existsSync(PROMPT_PATH)) {
    console.error(`Error: prompt not found at ${PROMPT_PATH}`);
    process.exit(1);
  }

  const prompt = readFileSync(PROMPT_PATH, 'utf8') + routingContext;

  // Step 2: compile via Claude CLI
  console.log('Step 2/2: Running Claude Code to compile...\n');

  const before = snapshotMtimes();

  // Strip ANTHROPIC_API_KEY so claude uses its OAuth credentials (Team subscription),
  // not the per-token API key which would bypass the subscription and cost tokens.
  const claudeEnv = { ...process.env };
  delete claudeEnv.ANTHROPIC_API_KEY;

  let compileError = null;
  try {
    execFileSync('claude', ['-p'], {
      cwd: ROOT,
      input: prompt,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: claudeEnv,
      timeout: 600_000, // 10-minute safety timeout
    });
    log('info', 'compile:llm-done', { pending: state.pending.length });
  } catch (err) {
    compileError = err;
    log('error', 'compile:llm-failed', { status: err.status ?? err.code, message: err.message });
    console.error(`\nClaude Code error: ${err.message}`);
  }

  const writtenFiles = diffMtimes(before);

  if (writtenFiles.length === 0) {
    log('error', 'compile:no-writes', { message: compileError?.message });
    console.error('\nCompilation failed: no files were written.');
    await notify(`❌ *Second Brain — compile failed*\nNo files were written.\n\`${compileError?.message ?? 'unknown error'}\``);
    process.exit(1);
  }

  await postCompile(ROOT, {
    writtenFiles,
    pendingItems: state.pending,
    mode: 'claude',
    compileError,
  });
}

main();
