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
export async function postCompile(root, { writtenFiles, pendingItems, mode, compileError = null }) {
  const PENDING_PATH     = join(root, '.state', 'pending.json');
  const COMPILE_LOG_PATH = join(root, '.state', 'compile-log.json');

  // Warn if partial compile
  if (compileError) {
    log('warn', `${mode}:partial`, { written: writtenFiles.length, message: compileError.message });
    console.warn(`\nPartial compile: ${writtenFiles.length} files written before error.`);
    console.warn(compileError.message);
  }

  // 1. Update pending.json
  const now = new Date().toISOString();
  writeFileSync(PENDING_PATH, JSON.stringify({ pending: [], lastCompile: now }, null, 2));

  // 2. Update compile-log.json
  let compileLog = [];
  try { compileLog = JSON.parse(readFileSync(COMPILE_LOG_PATH, 'utf8')); } catch {}
  compileLog.push({
    date: now,
    processed: pendingItems.length,
    written: writtenFiles,
    mode,
  });
  writeFileSync(COMPILE_LOG_PATH, JSON.stringify(compileLog, null, 2));

  log('info', `${mode}:done`, { pending: pendingItems.length, written: writtenFiles.length });
  console.log(`\n✓ Compiled ${pendingItems.length} items → ${writtenFiles.length} files written.\n`);

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
    execFileSync(process.execPath, [join(root, 'bin', 'journal.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
  } catch (err) {
    log('warn', `${mode}:journal-failed`, { message: err.message });
  }

  // 7. Sync to Pi
  if (process.env.PI_HOST && process.env.PI_USER) {
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
