#!/usr/bin/env node
/**
 * compile-lite — lightweight compilation for resource-constrained environments (Raspberry Pi).
 *
 * Uses the Anthropic SDK directly instead of Claude Code CLI.
 * Memory footprint: ~60 MB vs ~400 MB for `claude -p`.
 * No native dependencies, no PATH issues, no browser auth required.
 *
 * Usage:
 *   node bin/compile-lite.mjs             Compile all pending items
 *   node bin/compile-lite.mjs --dry-run   Preview without executing
 *
 * Required env var: ANTHROPIC_API_KEY (in .env)
 * Optional env var: COMPILE_MODEL (default: claude-sonnet-4-6)
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { log } from './lib/logger.mjs';
import { notify, postCompile } from './lib/post-compile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');
const ROUTING_PATH = join(ROOT, '.state', 'routing.json');
const INDEX_PATH = join(ROOT, 'INDEX.md');
const ROUTE_SCRIPT = join(ROOT, 'bin', 'route.mjs');

// Load .env
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
  node bin/compile-lite.mjs             Compile all pending items (lightweight, Raspberry Pi)
  node bin/compile-lite.mjs --dry-run   Show what would be compiled without executing
`);
  process.exit(0);
}

const dryRun = flag === '--dry-run';

// ── State helpers ─────────────────────────────────────────────────────────────

function readPending() {
  try { return JSON.parse(readFileSync(PENDING_PATH, 'utf8')); }
  catch { return { pending: [], lastCompile: null }; }
}

function readRouting() {
  try { return JSON.parse(readFileSync(ROUTING_PATH, 'utf8')); }
  catch { return { routes: [] }; }
}

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return null; }
}

// ── Context assembly ──────────────────────────────────────────────────────────

// Collect context for a specific group of items and their target articles.
// Reads articles fresh from disk so previous-group writes are visible.
function collectContext(items, targetArticles) {
  const articles = {};
  for (const rel of targetArticles) {
    const content = safeRead(join(ROOT, rel));
    if (content) articles[rel] = content;
  }

  const rawFiles = {};
  for (const item of items) {
    const content = safeRead(join(ROOT, item.path));
    if (content) rawFiles[item.path] = content;
  }

  const index = safeRead(INDEX_PATH) || '(INDEX.md does not exist yet)';
  return { index, articles, rawFiles };
}

// Group pending items by their routing target articles.
// Items that share the same target article set go in one API call.
// Items with no routing info are batched together as a fallback group.
function groupItemsByArticles(state, routing) {
  const routeMap = new Map((routing.routes || []).map(r => [r.path, r]));
  const groups = new Map(); // articleKey → { items, articles, routes }

  for (const item of state.pending) {
    const route = routeMap.get(item.path);
    const articles = (route?.routing?.articles || []).slice().sort();
    const key = articles.join('|') || '__unrouted__';

    if (!groups.has(key)) {
      groups.set(key, { items: [], articles, routes: [] });
    }
    const g = groups.get(key);
    g.items.push(item);
    if (route) g.routes.push(route);
  }

  return [...groups.values()];
}

// ── Prompt builder ────────────────────────────────────────────────────────────

// Returns the initial messages array with prompt caching applied.
// Block 1 (cached):  existing wiki articles — stable across agentic loop calls.
//                    Marked with cache_control so calls 2-N read from cache at 10% price.
// Block 2 (dynamic): task context (date, pending items, routing, raw files, INDEX.md).
function buildMessages(state, routing, context) {
  const today = new Date().toISOString().split('T')[0];

  // ── Block 1: stable wiki articles (cached) ────────────────────────────────
  const cacheBlocks = [];
  if (Object.keys(context.articles).length > 0) {
    const articleLines = [`## Existing wiki articles (relevant)`];
    for (const [path, content] of Object.entries(context.articles)) {
      articleLines.push(`\n### ${path}\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``);
    }
    cacheBlocks.push({
      type: 'text',
      text: articleLines.join('\n'),
      cache_control: { type: 'ephemeral' },
    });
  }

  // ── Block 2: dynamic content (not cached) ─────────────────────────────────
  const lines = [];

  lines.push(`# Second Brain — Compilation Task`);
  lines.push(`Today: ${today}\n`);
  lines.push(`You are the compiler for a personal second brain wiki.`);
  lines.push(`Process the ${state.pending.length} pending raw item(s) below and write/update wiki articles.\n`);

  lines.push(`## Pending items`);
  for (const item of state.pending) {
    lines.push(`- [${item.type}] ${item.path}`);
  }

  if ((routing.routes || []).length > 0) {
    lines.push(`\n## Incremental routing`);
    for (const route of routing.routes) {
      const action = route.routing?.action ?? 'unknown';
      const articles = (route.routing?.articles || []).join(', ') || 'none';
      lines.push(`- ${route.path} → action: ${action}, articles: [${articles}]`);
    }
  }

  lines.push(`\n## Raw files to process`);
  for (const [path, rawContent] of Object.entries(context.rawFiles)) {
    lines.push(`\n### ${path}\n\`\`\`\n${rawContent.slice(0, 8000)}\n\`\`\``);
  }

  lines.push(`\n## Current INDEX.md\n\`\`\`\n${context.index.slice(0, 4000)}\n\`\`\``);

  lines.push(`
## Your task

For each pending item, use the \`write_file\` tool to create or update a wiki article.
After processing all items, use \`write_file\` to update INDEX.md.

**Wiki article format (required):**
\`\`\`markdown
---
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - raw/type/file.md
tags: [tag1, tag2]
---

# Title

> One-line summary.

## Executive Summary

2-3 essential paragraphs.

## Key Concepts

- **Concept**: definition

## In Depth

Detailed content.

## Connections

- Related to [[another-article]]

## Sources

- [Title](url) (ingested YYYY-MM-DD)
\`\`\`

**Rules:**
- File names: kebab-case under wiki/ (e.g. wiki/machine-learning.md)
- Use [[wikilinks]] for internal links
- Prefer updating existing articles over creating new ones
- Process ALL ${state.pending.length} pending item(s) — call write_file at least once per item
- Do NOT say what you are going to do — just call write_file directly`);

  return [{ role: 'user', content: [...cacheBlocks, { type: 'text', text: lines.join('\n') }] }];
}

// ── Compile via Anthropic API ─────────────────────────────────────────────────

async function compile(state, routing, context) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.COMPILE_MODEL || 'claude-sonnet-4-6';

  const tools = [
    {
      name: 'write_file',
      description: 'Write or overwrite a file. Use for wiki articles and INDEX.md.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to project root. E.g. "wiki/machine-learning.md" or "INDEX.md".',
          },
          content: {
            type: 'string',
            description: 'Full file content.',
          },
        },
        required: ['path', 'content'],
      },
    },
  ];

  const messages = buildMessages(state, routing, context);
  const writtenFiles = [];

  // Call API with exponential backoff on 429
  async function callWithRetry(params, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await client.messages.create(params);
      } catch (err) {
        const is429 = err.status === 429 || (err.message && err.message.includes('429'));
        if (is429 && attempt < maxRetries) {
          const wait = Math.pow(2, attempt + 1) * 10_000; // 20s, 40s, 80s
          console.warn(`  Rate limit hit — retrying in ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          // Attach partial writes so the caller can save state
          err.writtenFiles = writtenFiles;
          throw err;
        }
      }
    }
  }

  // Agentic tool-use loop
  while (true) {
    const response = await callWithRetry({
      model,
      max_tokens: 16384,
      tools,
      messages,
      betas: ['prompt-caching-2024-07-31'],
    });

    // Log cache stats when available
    const cacheCreated = response.usage?.cache_creation_input_tokens ?? 0;
    const cacheRead = response.usage?.cache_read_input_tokens ?? 0;
    if (cacheCreated > 0) console.log(`  Cache written: ${cacheCreated.toLocaleString()} tokens`);
    if (cacheRead > 0) console.log(`  Cache read:    ${cacheRead.toLocaleString()} tokens (saved ~${Math.round(cacheRead * 0.9 / 1000)}k tokens at full price)`);

    // Log any narrative text from the model
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        console.log(block.text);
      }
    }

    const toolUses = response.content.filter(b => b.type === 'tool_use');

    if (toolUses.length > 0) {
      const toolResults = [];

      for (const toolUse of toolUses) {
        if (toolUse.name === 'write_file') {
          const { path: relPath, content } = toolUse.input;

          // Safety check: only allow writes inside the project root
          const absPath = resolve(join(ROOT, relPath));
          if (!absPath.startsWith(ROOT)) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Rejected: path outside project root — ${relPath}`,
              is_error: true,
            });
            continue;
          }

          // Ensure parent directory exists
          const parentDir = dirname(absPath);
          if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

          try {
            writeFileSync(absPath, content, 'utf8');
            console.log(`  ✓ ${relPath}`);
            writtenFiles.push(relPath);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Written: ${relPath}`,
            });
          } catch (err) {
            console.error(`  ✗ ${relPath}: ${err.message}`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error writing ${relPath}: ${err.message}`,
              is_error: true,
            });
          }
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    if (response.stop_reason === 'end_turn' || toolUses.length === 0) break;
  }

  return writtenFiles;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const state = readPending();

  if (state.pending.length === 0) {
    console.log('✓ No pending items to compile.');
    process.exit(0);
  }

  log('info', 'compile-lite:start', { pending: state.pending.length });
  console.log(`\nSecond Brain — Compile (lite)`);
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
    log('warn', 'compile-lite:routing-failed', {});
    console.warn('Routing failed — compiling without incremental context.\n');
  }

  const routing = readRouting();
  const groups = groupItemsByArticles(state, routing);

  console.log(`Step 2/2: Compiling with Anthropic API (${groups.length} group${groups.length !== 1 ? 's' : ''})...\n`);

  const writtenFiles = [];
  let compileError = null;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const label = group.articles.length > 0
      ? group.articles.map(a => a.replace('wiki/', '')).join(', ')
      : 'new article(s)';
    console.log(`Group ${i + 1}/${groups.length}: ${group.items.length} item(s) → [${label}]`);

    // Re-read articles from disk: previous groups may have updated them
    const context = collectContext(group.items, group.articles);
    const groupState = { pending: group.items };
    const groupRouting = { routes: group.routes };

    try {
      const written = await compile(groupState, groupRouting, context);
      writtenFiles.push(...written);
      console.log(`  → ${written.length} file(s) written\n`);
    } catch (err) {
      const partialWrites = err.writtenFiles ?? [];
      writtenFiles.push(...partialWrites);
      compileError = err; // keep last error; postCompile handles partial state
      console.warn(`  Group failed (${partialWrites.length} partial writes) — continuing...\n`);
      log('warn', 'compile-lite:group-failed', { group: label, message: err.message });
    }
  }

  if (writtenFiles.length === 0) {
    log('error', 'compile-lite:no-writes', { message: compileError?.message });
    console.error('\nCompilation failed: no files were written.');
    console.error(compileError?.message ?? '');
    await notify(`❌ *Second Brain — compile failed*\nNo files were written.\n\`${compileError?.message ?? 'unknown error'}\``);
    process.exit(1);
  }

  await postCompile(ROOT, {
    writtenFiles,
    pendingItems: state.pending,
    mode: 'lite',
    compileError,
  });
}

main();
