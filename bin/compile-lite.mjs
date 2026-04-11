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
 * Optional env var: COMPILE_MODEL (default: claude-opus-4-6)
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { log } from './lib/logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');
const ROUTING_PATH = join(ROOT, '.state', 'routing.json');
const COMPILE_LOG_PATH = join(ROOT, '.state', 'compile-log.json');
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

function collectContext(state, routing) {
  // Wiki articles identified by routing (only load relevant ones)
  const wikiPaths = new Set();
  for (const route of routing.routes || []) {
    for (const article of route.routing?.articles || []) {
      wikiPaths.add(article);
    }
  }

  const articles = {};
  for (const rel of wikiPaths) {
    const content = safeRead(join(ROOT, rel));
    if (content) articles[rel] = content;
  }

  // Raw files for each pending item
  const rawFiles = {};
  for (const item of state.pending) {
    const content = safeRead(join(ROOT, item.path));
    if (content) rawFiles[item.path] = content;
  }

  const index = safeRead(INDEX_PATH) || '(INDEX.md does not exist yet)';

  return { index, articles, rawFiles };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(state, routing, context) {
  const today = new Date().toISOString().split('T')[0];
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
  for (const [path, content] of Object.entries(context.rawFiles)) {
    lines.push(`\n### ${path}\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``);
  }

  if (Object.keys(context.articles).length > 0) {
    lines.push(`\n## Existing wiki articles (relevant)`);
    for (const [path, content] of Object.entries(context.articles)) {
      lines.push(`\n### ${path}\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``);
    }
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

  return lines.join('\n');
}

// ── Telegram notification (optional) ─────────────────────────────────────────

async function notify(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch { /* notifications are best-effort */ }
}

// ── Compile via Anthropic API ─────────────────────────────────────────────────

async function compile(state, routing, context) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.COMPILE_MODEL || 'claude-sonnet-4-6';
  const prompt = buildPrompt(state, routing, context);

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

  const messages = [{ role: 'user', content: prompt }];
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
    });

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
  const context = collectContext(state, routing);

  // Step 2: compile via Anthropic API
  console.log('Step 2/2: Compiling with Anthropic API...\n');

  let writtenFiles;
  let compileError = null;
  try {
    writtenFiles = await compile(state, routing, context);
  } catch (err) {
    compileError = err;
    writtenFiles = err.writtenFiles ?? []; // partial writes attached by compile()
  }

  if (writtenFiles.length === 0) {
    log('error', 'compile-lite:no-writes', { message: compileError?.message });
    console.error('\nCompilation failed: no files were written.');
    console.error(compileError?.message ?? '');
    await notify(`❌ *Second Brain — compile failed*\nNo files were written.\n\`${compileError?.message ?? 'unknown error'}\``);
    process.exit(1);
  }

  // If some files were written before an error, save state and warn
  if (compileError) {
    log('warn', 'compile-lite:partial', { written: writtenFiles.length, message: compileError.message });
    console.warn(`\nPartial compile: ${writtenFiles.length} files written before error.`);
    console.warn(compileError.message);
  }

  // Update .state/pending.json
  const now = new Date().toISOString();
  writeFileSync(PENDING_PATH, JSON.stringify({ pending: [], lastCompile: now }, null, 2));

  // Update .state/compile-log.json
  let compileLog = [];
  try { compileLog = JSON.parse(readFileSync(COMPILE_LOG_PATH, 'utf8')); } catch {}
  compileLog.push({
    date: now,
    processed: state.pending.length,
    written: writtenFiles,
    mode: 'lite',
  });
  writeFileSync(COMPILE_LOG_PATH, JSON.stringify(compileLog, null, 2));

  log('info', 'compile-lite:done', { pending: state.pending.length, written: writtenFiles.length });
  console.log(`\n✓ Compiled ${state.pending.length} items → ${writtenFiles.length} files written.\n`);

  const articleList = writtenFiles
    .filter(f => f.startsWith('wiki/'))
    .map(f => `• ${f.replace('wiki/', '').replace('.md', '')}`)
    .join('\n');
  await notify(
    `✅ *Second Brain compilado*\n` +
    `${state.pending.length} items → ${writtenFiles.length} archivos\n` +
    (articleList ? `\n${articleList}` : '')
  );

  // Post-compilation: detect connections between new articles and existing wiki
  try {
    const { detectConnections } = await import('./lib/post-compile-connections.mjs');
    const newArticles = writtenFiles.filter(f => f.startsWith('wiki/'));
    if (newArticles.length > 0 && process.env.ANTHROPIC_API_KEY) {
      const msg = await detectConnections(ROOT, newArticles, process.env.ANTHROPIC_API_KEY);
      if (msg) await notify(msg);
    }
  } catch (err) {
    log('warn', 'compile-lite:connections-failed', { message: err.message });
  }

  // Post-compilation: refresh semantic search index
  if (process.env.OPENAI_API_KEY) {
    try {
      const { buildIndex } = await import('./lib/embeddings.mjs');
      const { indexed, skipped } = await buildIndex(ROOT, process.env.OPENAI_API_KEY);
      log('info', 'compile-lite:embeddings', { indexed, skipped });
      console.log(`✓ Embeddings: ${indexed} updated, ${skipped} unchanged.\n`);
    } catch (err) {
      log('warn', 'compile-lite:embeddings-failed', { message: err.message });
    }
  }

  // Post-compilation: generate yesterday's journal entry
  try {
    execFileSync(process.execPath, [join(ROOT, 'bin', 'journal.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
  } catch (err) {
    log('warn', 'compile-lite:journal-failed', { message: err.message });
  }

  // Sync to Pi if configured (same logic as compile.mjs — used when running on the main machine)
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
}

main();
