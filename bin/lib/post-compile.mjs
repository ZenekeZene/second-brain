/**
 * post-compile — shared post-compilation pipeline.
 *
 * Called by both compile-lite.mjs (SDK mode) and compile.mjs (Claude Code mode)
 * after the LLM compilation step completes. Ensures both modes produce identical
 * post-compile behavior regardless of which backend was used.
 *
 * Steps (in order):
 *   1. Update .state/pending.json (clear pending, set lastCompile)
 *   2. Append to .state/compile-log.json
 *   3. Telegram notification
 *   4. Detect cross-article connections (Haiku)
 *   5. Refresh semantic search embeddings (OpenAI)
 *   6. Generate journal entry (Haiku)
 *   7. Sync to Raspberry Pi
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { log } from './logger.mjs';

// ── Telegram ──────────────────────────────────────────────────────────────────

export async function notify(text) {
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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {string} root          - Absolute path to the project root
 * @param {object} opts
 * @param {string[]} opts.writtenFiles  - Relative paths of files written during compilation
 * @param {object[]} opts.pendingItems  - Original pending items array (before clearing)
 * @param {string}  opts.mode           - 'lite' | 'claude' (for compile-log)
 * @param {Error|null} [opts.compileError] - Non-null if compilation ended with a partial error
 */
// Items are considered processed if any of their routing target articles were written.
// Used for partial failures to preserve unprocessed items in pending.json.
function determineProcessedItems(root, pendingItems, writtenFiles) {
  const routingPath = join(root, '.state', 'routing.json');
  let routes = [];
  try { routes = JSON.parse(readFileSync(routingPath, 'utf8')).routes || []; } catch {}
  const writtenSet = new Set(writtenFiles);
  return pendingItems.filter(item => {
    const route = routes.find(r => r.path === item.path);
    if (!route) return false; // no routing info — conservatively keep
    const articles = route.routing?.articles || [];
    return articles.length > 0 && articles.some(a => writtenSet.has(a));
  });
}

export async function postCompile(root, { writtenFiles, pendingItems, mode, compileError = null }) {
  const PENDING_PATH     = join(root, '.state', 'pending.json');
  const COMPILE_LOG_PATH = join(root, '.state', 'compile-log.json');

  // 1. Update pending.json — preserve items that weren't processed on failure
  const now = new Date().toISOString();
  let remaining = [];
  if (compileError) {
    if (writtenFiles.length === 0) {
      // Complete failure: keep all items for retry
      remaining = [...pendingItems];
    } else {
      // Partial failure: keep items whose routing targets weren't written
      const processed = determineProcessedItems(root, pendingItems, writtenFiles);
      remaining = pendingItems.filter(item => !processed.some(p => p.path === item.path));
    }
    log('warn', `${mode}:partial`, { written: writtenFiles.length, remaining: remaining.length, message: compileError.message });
    console.warn(`\nPartial compile: ${writtenFiles.length} files written, ${remaining.length} items kept for retry.`);
  }
  let existingLastCompile = null;
  try { existingLastCompile = JSON.parse(readFileSync(PENDING_PATH, 'utf8')).lastCompile; } catch {}
  writeFileSync(PENDING_PATH, JSON.stringify({
    pending: remaining,
    lastCompile: remaining.length < pendingItems.length ? now : existingLastCompile,
  }, null, 2));

  // 2. Update compile-log.json
  let compileLog = [];
  try { compileLog = JSON.parse(readFileSync(COMPILE_LOG_PATH, 'utf8')); } catch {}
  compileLog.push({
    date: now,
    processed: pendingItems.length - remaining.length,
    written: writtenFiles,
    mode,
  });
  writeFileSync(COMPILE_LOG_PATH, JSON.stringify(compileLog, null, 2));

  const processedCount = pendingItems.length - remaining.length;
  log('info', `${mode}:done`, { pending: processedCount, written: writtenFiles.length, remaining: remaining.length });
  console.log(`\n✓ Compiled ${processedCount} items → ${writtenFiles.length} files written.${remaining.length > 0 ? ` ${remaining.length} items kept for retry.` : ''}\n`);

  // 3. Telegram notification
  const articleList = writtenFiles
    .filter(f => f.startsWith('wiki/'))
    .map(f => `• ${f.replace('wiki/', '').replace('.md', '')}`)
    .join('\n');
  await notify(
    `✅ *Second Brain compilado*\n` +
    `${pendingItems.length} items → ${writtenFiles.length} archivos\n` +
    (articleList ? `\n${articleList}` : '')
  );

  // 4. Detect connections between new articles and existing wiki
  try {
    const { detectConnections } = await import('./post-compile-connections.mjs');
    const newArticles = writtenFiles.filter(f => f.startsWith('wiki/'));
    if (newArticles.length > 0 && process.env.ANTHROPIC_API_KEY) {
      const msg = await detectConnections(root, newArticles, process.env.ANTHROPIC_API_KEY);
      if (msg) await notify(msg);
    }
  } catch (err) {
    log('warn', `${mode}:connections-failed`, { message: err.message });
  }

  // 5. Refresh semantic search index
  if (process.env.OPENAI_API_KEY) {
    try {
      const { buildIndex } = await import('./embeddings.mjs');
      const { indexed, skipped } = await buildIndex(root, process.env.OPENAI_API_KEY);
      log('info', `${mode}:embeddings`, { indexed, skipped });
      console.log(`✓ Embeddings: ${indexed} updated, ${skipped} unchanged.\n`);
    } catch (err) {
      log('warn', `${mode}:embeddings-failed`, { message: err.message });
    }
  }

  // 6. Generate journal entry
  try {
    execFileSync(process.execPath, [join(root, 'bin', 'journal.mjs'), '--mode', mode], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
  } catch (err) {
    log('warn', `${mode}:journal-failed`, { message: err.message });
  }

  // 7. Sync to Pi (skip if running ON the Pi to avoid self-rsync)
  if (process.env.PI_HOST && process.env.PI_USER && !process.env.SKIP_PI_SYNC) {
    try {
      execFileSync(process.execPath, [join(root, 'bin', 'sync-pi.mjs')], {
        cwd: root,
        stdio: 'inherit',
      });
    } catch {
      console.warn('Warning: Pi sync failed (wiki compiled successfully).');
    }
  }
}
