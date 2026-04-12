#!/usr/bin/env node
/**
 * second-brain Telegram bot
 * Ingest content into the brain directly from mobile.
 *
 * Usage:
 *   node bin/telegram-bot.mjs
 *
 * Required environment variables (.env):
 *   TELEGRAM_BOT_TOKEN       — bot token (from @BotFather)
 *   TELEGRAM_ALLOWED_USER_ID — your Telegram user ID (from @userinfobot)
 *
 * Supported commands:
 *   /ask <question>     -> search wiki and synthesize answer with Claude
 *   /challenge <topic>  -> devil's advocate — challenge your own positions
 *   /tasks              -> list pending reminders
 *   /start              -> welcome and help
 *   /status             -> brain status
 *   /pending            -> items pending compilation
 *   /help               -> list of commands
 *
 * Automatic messages:
 *   "recuérdame X"      -> saves a task with parsed due date
 *   "remind me X"       -> saves a task with parsed due date
 *   ¿...? or ? ...      -> auto-detected as query (search + synthesize)
 *   URL alone           -> brain: save <url>
 *   Plain text          -> brain: note <text>
 *   brain: <command>    -> executes the command directly
 *   Photo               -> brain: image (download + description)
 */

import { Telegraf } from 'telegraf';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import OpenAI from 'openai';
import { log, LOG_PATH_EXPORT as LOG_PATH } from './lib/logger.mjs';
import { shouldCompile, triggerMessage } from './lib/reactive.mjs';
import {
  readPending, ingestNote, ingestBookmark, ingestImage, ingestVoice, transcribeAudio,
} from './lib/ingest-helpers.mjs';
import { queryBrain } from './lib/brain-query.mjs';
import { debateTopic, continueDebate, endDebate, saveDebateSession, loadDebateSession, getMostRecentSession, pruneDebateSessions } from './lib/debate.mjs';
import { parseTaskMessage, saveTask, readAllTasks, formatDue, markTaskDone } from './lib/task-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load .env manually (no dotenv dependency) ────────────────────────────────
function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}
loadEnv();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10);

if (!TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN not defined in .env');
  process.exit(1);
}
if (!ALLOWED_ID) {
  console.error('Error: TELEGRAM_ALLOWED_USER_ID not defined in .env');
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isUrl(text) {
  return /^https?:\/\/\S+/.test(text.trim());
}

// Detect if a message looks like a question (query) rather than content to ingest
function looksLikeQuery(text) {
  const t = text.trim().toLowerCase();
  // Starts with explicit question marks
  if (t.startsWith('?') || t.startsWith('¿')) return true;
  // Common Spanish/English query patterns
  const queryPatterns = [
    /^qu[eé]\s+s[eé]\s+(sobre|de|acerca)/,
    /^qu[eé]\s+(sabes|tienes|hay)\s+(sobre|de|acerca)/,
    /^cu[aá]nto\s+s[eé]/,
    /^c[oó]mo\s+(funciona|se\s+usa|se\s+hace)/,
    /^d[oó]nde\s+(est[aá]|puedo|encuentro)/,
    /^busca(r)?\s+/,
    /^busca(me)?\s+/,
    /^what\s+(do\s+i\s+know|is|are)\s+/,
    /^search\s+(for\s+)?/,
    /^find\s+(me\s+)?/,
    /^tell\s+me\s+(about|what)/,
    /^how\s+(does|do|to)\s+/,
    /^explain\s+/,
  ];
  return queryPatterns.some(p => p.test(t));
}

// Convert standard markdown to Telegram-compatible format
function toTelegramMarkdown(text) {
  return text
    // Headers → bold (### before ## before #)
    .replace(/^###\s+(.+)$/gm, '*$1*')
    .replace(/^##\s+(.+)$/gm, '*$1*')
    .replace(/^#\s+(.+)$/gm, '*$1*')
    // Double asterisk bold → single asterisk (Telegram uses single)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    // Blockquotes → italic
    .replace(/^>\s+(.+)$/gm, '_$1_')
    // Horizontal rules → nothing
    .replace(/^---+$/gm, '')
    // [[wikilinks]] → bold
    .replace(/\[\[([^\]]+)\]\]/g, '*$1*')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Format a queryBrain result for Telegram (max 4096 chars)
function formatAnswer({ answer, sources }) {
  const formatted = toTelegramMarkdown(answer);
  const sourceLine = sources.length > 0
    ? `\n\n_Sources: ${sources.map(s => `[${s}]`).join(', ')}_`
    : '';
  const full = formatted + sourceLine;
  const MAX = 4000;
  if (full.length <= MAX) return full;
  return full.slice(0, MAX - 30) + `...\n\n_Full response saved._`;
}

function getStatus() {
  const state = readPending(ROOT);
  const wikiDir = join(ROOT, 'wiki');
  let articles = 0;
  try { articles = readFileSync(join(ROOT, 'INDEX.md'), 'utf8').match(/\[\[/g)?.length || 0; } catch {}
  const lastCompile = state.lastCompile
    ? new Date(state.lastCompile).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'never';
  return { articles, pending: state.pending.length, lastCompile, items: state.pending };
}

async function triggerReactiveIfNeeded(ctx) {
  const state = readPending(ROOT);
  const trigger = shouldCompile(state);
  if (!trigger) return;
  log('info', 'reactive:triggered', { reason: trigger.reason, pending: trigger.pending });
  await ctx.reply(`Reactive compilation triggered: ${triggerMessage(trigger)}.\nRunning in background...`);
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'compile.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// ── bot ───────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const bot = new Telegraf(TOKEN);

// Auth middleware — only accept messages from the authorized user
bot.use((ctx, next) => {
  const userId = ctx.from?.id;
  if (userId !== ALLOWED_ID) {
    log('warn', 'Message rejected', { userId });
    return ctx.reply('Unauthorized.');
  }
  return next();
});

// /start
bot.start((ctx) => ctx.replyWithMarkdown(`*Second Brain Bot*

Ingest content, query your wiki, and set reminders.

*Reminders:*
• \`Recuérdame revisar el PR mañana a las 10\`
• \`Remind me to call doctor on Friday at 9\`
• \`tarea: preparar presentación en 2 horas\`
• \`/tasks\` — list pending reminders

*Ask questions:*
• \`/ask <question>\` -> search and synthesize answer
• \`/challenge <topic>\` -> devil's advocate against your own notes
• \`/challenge_end\` -> close debate and extract insights into the wiki
• \`¿cómo funciona X?\` -> auto-detected as query
• \`? what do I know about Y\` -> explicit query

*Automatic ingestion:*
• Send a URL -> saves it as an article
• Send text -> saves it as a note
• Send \`brain: save <url>\` -> save URL
• Send \`brain: bookmark <url>\` -> bookmark for later

*Commands:*
/ask — query the brain
/challenge — devil's advocate against your notes
/challenge_end — close debate + extract insights
/tasks — pending reminders
/status — brain status
/pending — items pending compilation
/logs — last 10 events
/help — this help`));

// /help
bot.help((ctx) => ctx.replyWithMarkdown(`*Available commands:*

/ask <question> — search wiki and synthesize answer
/challenge <topic> — devil's advocate against your own notes
/challenge_end — close debate, extract insights → pending compilation
/tasks — list pending reminders
/status — articles, pending, last compilation
/pending — list of items to compile
/logs — last 10 events (debug)
/help — this help

*Automatic messages:*
\`Recuérdame X [cuando]\` -> set a reminder
\`¿...?\` or \`? ...\` -> query the brain
\`https://...\` -> saves as article to process
\`Any text\` -> saves as note
\`brain: bookmark https://...\` -> bookmark`));

// ── Task list helpers ─────────────────────────────────────────────────────────

function buildTasksMessage(tasks) {
  const now = new Date();
  const lines = [`*Recordatorios pendientes (${tasks.length}):*`, ''];
  const keyboard = [];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const overdue = t.due < now;
    const icon = overdue ? '🔴' : '🔵';
    const notifiedStr = t.notifiedAt ? ' _(avisado)_' : '';
    lines.push(`${i + 1}. ${icon} ${t.text}`);
    lines.push(`   _${formatDue(t.due)}_${notifiedStr}`);
    lines.push('');
    const label = `✅ ${i + 1}. ${t.text.slice(0, 28)}${t.text.length > 28 ? '…' : ''}`;
    keyboard.push([{ text: label, callback_data: `done:${t.id}` }]);
  }

  return {
    text: lines.join('\n').trimEnd(),
    reply_markup: { inline_keyboard: keyboard },
  };
}

// /tasks — list pending reminders with inline completion buttons
bot.command('tasks', (ctx) => {
  const tasks = readAllTasks(ROOT).filter(t => !t.done);
  if (tasks.length === 0) return ctx.reply('No tienes recordatorios pendientes. ✅');
  const { text, reply_markup } = buildTasksMessage(tasks);
  ctx.replyWithMarkdown(text, { reply_markup });
});

// Inline button: mark task done
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith('done:')) return ctx.answerCbQuery();

  const taskId = data.slice(5);
  markTaskDone(ROOT, taskId);
  log('info', 'task:done-from-bot', { taskId });
  await ctx.answerCbQuery('✅ Completado');

  const remaining = readAllTasks(ROOT).filter(t => !t.done);
  try {
    if (remaining.length === 0) {
      await ctx.editMessageText('¡Sin recordatorios pendientes! ✅');
    } else {
      const { text, reply_markup } = buildTasksMessage(remaining);
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup });
    }
  } catch {
    // Message unchanged or already edited — ignore
  }
});

// /ask — explicit query command
bot.command('ask', async (ctx) => {
  const question = ctx.message.text.replace(/^\/ask\s*/i, '').trim();
  if (!question) return ctx.reply('Usage: /ask <question>\n\nExample: /ask what do I know about hexagonal architecture?');
  log('info', 'query:ask', { question: question.slice(0, 80) });
  await ctx.reply('Searching the brain...');
  try {
    const result = await queryBrain(ROOT, question);
    await ctx.replyWithMarkdown(formatAnswer(result));
  } catch (err) {
    log('error', 'query:failed', { error: err.message });
    ctx.reply(`Error querying the brain: ${err.message}`);
  }
});

// /challenge — devil's advocate mode
bot.command('challenge', async (ctx) => {
  const topic = ctx.message.text.replace(/^\/challenge\s*/i, '').trim();
  if (!topic) return ctx.reply('Usage: /challenge <topic>\n\nExample: /challenge hexagonal architecture');
  log('info', 'debate:start', { topic: topic.slice(0, 80) });
  await ctx.reply('🔥 Preparando contraargumentos...');
  try {
    const result = await debateTopic(ROOT, topic);
    const formatted = toTelegramMarkdown(result.challenge);
    const sourceLine = result.sources.length > 0
      ? `\n\n_Basado en: ${result.sources.join(', ')}_\n_Responde para continuar · /challenge\\_end para cerrar y aprender._`
      : '\n\n_Responde para continuar · /challenge\\_end para cerrar y aprender._';
    const full = `🔥 *Debate: ${topic}*\n\n${formatted}${sourceLine}`;
    const MAX = 4000;
    const sentMsg = await ctx.replyWithMarkdown(full.length <= MAX ? full : full.slice(0, MAX - 30) + '...');
    if (result.sessionMessages.length > 0) {
      await pruneDebateSessions(ROOT);
      saveDebateSession(ROOT, sentMsg.message_id, {
        topic,
        messages: result.sessionMessages,
        sources: result.sources,
        outputPath: result.outputPath,
      });
    }
  } catch (err) {
    log('error', 'debate:failed', { error: err.message });
    ctx.reply(`Error generating debate: ${err.message}`);
  }
});

// /debate-end — close debate and extract insights into pending notes
bot.command('challenge_end', async (ctx) => {
  // Find session: prefer reply-to, fall back to most recent
  const replyToId = ctx.message.reply_to_message?.from?.is_bot
    ? ctx.message.reply_to_message?.message_id : null;
  const session = replyToId
    ? loadDebateSession(ROOT, replyToId)
    : getMostRecentSession(ROOT);

  if (!session) {
    return ctx.reply('No hay ningún debate activo. Usa /challenge <tema> para empezar uno.');
  }
  const turns = Math.floor((session.messages.length - 1) / 2);
  if (turns === 0) {
    return ctx.reply('El debate no tiene respuestas todavía. Responde al menos una vez antes de cerrarlo.');
  }

  log('info', 'debate:end', { topic: session.topic, turns });
  await ctx.reply(`Extrayendo aprendizajes de ${turns} turno${turns !== 1 ? 's' : ''}...`);

  try {
    const result = await endDebate(ROOT, session);
    await ctx.replyWithMarkdown(
      `✅ *Debate cerrado: ${session.topic}*\n\n` +
      `${result.summary}\n\n` +
      `_Los insights se compilarán en el próximo ciclo diario._`
    );
  } catch (err) {
    log('error', 'debate:end-failed', { error: err.message });
    ctx.reply(`Error extrayendo insights: ${err.message}`);
  }
});

// /status
bot.command('status', (ctx) => {
  const s = getStatus();
  const pendingStr = s.pending > 0 ? `${s.pending} pending` : 'Up to date';
  ctx.replyWithMarkdown(`*Second Brain*\n\n${s.articles} articles\n${pendingStr}\nCompiled: ${s.lastCompile}`);
});

// /logs — last 10 log entries
bot.command('logs', (ctx) => {
  try {
    const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-10);
    const formatted = lines.map(l => {
      try {
        const e = JSON.parse(l);
        const time = e.ts.slice(11, 19);
        const extra = Object.entries(e).filter(([k]) => !['ts','level','msg'].includes(k)).map(([k,v]) => `${k}=${v}`).join(' ');
        return `[${time}] ${e.level.toUpperCase()} ${e.msg}${extra ? ' — ' + extra : ''}`;
      } catch { return l; }
    }).join('\n');
    ctx.reply(`Last events:\n\n${formatted}`);
  } catch {
    ctx.reply('No logs yet.');
  }
});

// /pending
bot.command('pending', (ctx) => {
  const s = getStatus();
  if (s.items.length === 0) return ctx.reply('No pending items.');
  const list = s.items.map(i => `• [${i.type}] ${i.path.split('/').pop()}`).join('\n');
  ctx.replyWithMarkdown(`*Pending (${s.items.length}):*\n\n${list}`);
});

// Text messages
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Continue a debate if the user replied to a bot message
  const replyToId = ctx.message.reply_to_message?.from?.is_bot
    ? ctx.message.reply_to_message?.message_id
    : null;
  if (replyToId) {
    const session = loadDebateSession(ROOT, replyToId);
    if (!session) {
      await ctx.reply('Sesión de debate no encontrada (puede haber expirado). Lanza /challenge <tema> para empezar uno nuevo.');
      return;
    }
    log('info', 'debate:continue', { topic: session.topic });
    await ctx.reply('🔥 Contraatacando...');
    try {
      const result = await continueDebate(ROOT, session, text);
      const formatted = toTelegramMarkdown(result.challenge);
      const hint = '\n\n_Responde para seguir · /challenge\\_end para cerrar y aprender._';
      const full = `🔥 *Debate: ${session.topic}*\n\n${formatted}${hint}`;
      const MAX = 4000;
      const sentMsg = await ctx.replyWithMarkdown(full.length <= MAX ? full : full.slice(0, MAX - 30) + '...');
      saveDebateSession(ROOT, sentMsg.message_id, {
        topic: session.topic,
        messages: result.sessionMessages,
        sources: session.sources,
        outputPath: session.outputPath,
      });
    } catch (err) {
      log('error', 'debate:continue-failed', { error: err.message });
      ctx.reply(`Error continuing debate: ${err.message}`);
    }
    return;
  }

  // Auto-detect questions before any ingestion logic
  if (looksLikeQuery(text)) {
    log('info', 'query:auto-detect', { text: text.slice(0, 80) });
    await ctx.reply('Searching the brain...');
    try {
      const result = await queryBrain(ROOT, text);
      await ctx.replyWithMarkdown(formatAnswer(result));
    } catch (err) {
      log('error', 'query:failed', { error: err.message });
      ctx.reply(`Error querying the brain: ${err.message}`);
    }
    return;
  }

  // Explicit brain: command
  if (text.toLowerCase().startsWith('brain:')) {
    const cmd = text.slice(6).trim();

    if (isUrl(cmd) || cmd.toLowerCase().startsWith('save ')) {
      const url = cmd.replace(/^save\s+/i, '').trim();
      if (!isUrl(url)) return ctx.reply('Invalid URL.');
      const r = await ingestBookmark(ROOT, url, 'telegram');
      await ctx.reply(`URL saved for processing.\n${r.pending} items pending.`);
      await triggerReactiveIfNeeded(ctx);
      return;
    }

    if (cmd.toLowerCase().startsWith('bookmark ')) {
      const url = cmd.replace(/^bookmark\s+/i, '').trim();
      if (!isUrl(url)) return ctx.reply('Invalid URL.');
      const r = await ingestBookmark(ROOT, url, 'telegram');
      await ctx.reply(`Bookmark saved.\n${r.pending} items pending.`);
      await triggerReactiveIfNeeded(ctx);
      return;
    }

    if (cmd.toLowerCase().startsWith('note ')) {
      const noteText = cmd.replace(/^note\s+/i, '').trim();
      const r = await ingestNote(ROOT, noteText, 'telegram');
      await ctx.reply(`Note saved.\n${r.pending} items pending.`);
      await triggerReactiveIfNeeded(ctx);
      return;
    }

    return ctx.reply(`Unknown command: "${cmd}"\nUse /help to see available commands.`);
  }

  // Bare URL → save for processing (as an article)
  if (isUrl(text)) {
    const r = await ingestBookmark(ROOT, text, 'telegram');
    await ctx.reply(`URL saved for processing.\n${r.pending} items pending.\n\nContent will be expanded on next compile.`);
    await triggerReactiveIfNeeded(ctx);
    return;
  }

  // Plain text — let Haiku decide: task/reminder or note?
  if (text.length > 0) {
    let parsed = null;
    try {
      parsed = await parseTaskMessage(text, process.env.ANTHROPIC_API_KEY);
    } catch { /* Haiku unavailable — fall through to note */ }

    if (parsed) {
      log('info', 'task:detected', { count: parsed.length, text: text.slice(0, 80) });
      const lines = parsed.map(t => {
        const { id, date } = saveTask(ROOT, t.text, t.due);
        log('info', 'task:saved', { id, date, due: t.due.toISOString() });
        return `• ${t.text} — _${formatDue(t.due)}_`;
      });
      const header = parsed.length > 1 ? `✅ *${parsed.length} recordatorios guardados*` : `✅ *Recordatorio guardado*`;
      await ctx.replyWithMarkdown(`${header}\n\n${lines.join('\n')}`);
      return;
    }

    const r = await ingestNote(ROOT, text, 'telegram');
    await ctx.reply(`Note saved (${text.length} chars).\n${r.pending} items pending.`);
    await triggerReactiveIfNeeded(ctx);
    return;
  }
});

// Photos -> download + describe with GPT-4 Vision + save to raw/images/
bot.on('photo', async (ctx) => {
  const caption = ctx.message.caption || '';
  log('info', 'photo received', { caption: caption.slice(0, 60) });
  await ctx.reply(`Photo received${caption ? ` — "${caption}"` : ''}. Analyzing...`);

  try {
    const photo = ctx.message.photo.at(-1); // highest resolution
    const file = await ctx.telegram.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Error downloading image: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    const ext = file.file_path.split('.').pop() || 'jpg';
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
    const filename = `photo.${ext}`;

    const r = await ingestImage(ROOT, openai, buffer, filename, mimeType, caption);
    await ctx.reply(
      `Image analyzed and saved.\n\n_${r.description.slice(0, 200)}${r.description.length > 200 ? '...' : ''}_\n\n${r.pending} items pending.`,
      { parse_mode: 'Markdown' }
    );
    await triggerReactiveIfNeeded(ctx);
  } catch (err) {
    log('error', 'photo failed', { error: err.message });
    ctx.reply('Error processing the photo. Check server logs.');
  }
});

// Voice notes -> transcribe first, then decide: query or note
bot.on('voice', async (ctx) => {
  const voice = ctx.message.voice;
  log('info', 'voice received', { duration: voice.duration });
  await ctx.reply(`Voice note received (${voice.duration}s). Transcribing...`);

  try {
    const file = await ctx.telegram.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Error downloading voice: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Step 1: transcribe only
    const transcription = await transcribeAudio(openai, buffer, 'voice.ogg');
    log('info', 'voice transcribed', { text: transcription.slice(0, 80) });

    // Step 2: task, query, or note?
    if (looksLikeQuery(transcription)) {
      log('info', 'query:voice-auto-detect', { text: transcription.slice(0, 80) });
      await ctx.reply(`_"${transcription}"_\n\nSearching the brain...`, { parse_mode: 'Markdown' });
      const result = await queryBrain(ROOT, transcription);
      await ctx.replyWithMarkdown(formatAnswer(result));
      return;
    }

    // Let Haiku decide: task/reminder or note?
    let parsed = null;
    try {
      parsed = await parseTaskMessage(transcription, process.env.ANTHROPIC_API_KEY);
    } catch { /* Haiku unavailable — fall through to note */ }

    if (parsed) {
      log('info', 'task:voice-detect', { count: parsed.length, text: transcription.slice(0, 80) });
      const lines = parsed.map(t => {
        saveTask(ROOT, t.text, t.due);
        return `• ${t.text} — _${formatDue(t.due)}_`;
      });
      const header = parsed.length > 1 ? `✅ *${parsed.length} recordatorios guardados*` : `✅ *Recordatorio guardado*`;
      await ctx.replyWithMarkdown(`_"${transcription}"_\n\n${header}\n\n${lines.join('\n')}`);
      return;
    }

    const r = await ingestNote(ROOT, transcription, 'telegram-voice');
    log('info', 'voice ingested as note', { path: r.path, pending: r.pending });
    await ctx.reply(`Voice note saved.\n_"${transcription.slice(0, 120)}${transcription.length > 120 ? '...' : ''}"_\n\n${r.pending} items pending.`, { parse_mode: 'Markdown' });
  } catch (err) {
    log('error', 'voice failed', { error: err.message });
    ctx.reply(`Error processing voice note: ${err.message}`);
  }
});

// Documents / files
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  if (doc.file_size > 25 * 1024 * 1024) {
    return ctx.reply(`File too large (max 25 MB): ${doc.file_name}`);
  }
  await ctx.reply(`Document received: ${doc.file_name}. Processing...`);
  try {
    const file = await ctx.telegram.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Error downloading file: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const { ingestFile, ingestPdf, detectType } = await import('./lib/ingest-helpers.mjs');
    const mimeType = doc.mime_type || 'application/octet-stream';
    const type = detectType('', mimeType, doc.file_name);
    let r;
    if (type === 'pdf') {
      r = await ingestPdf(ROOT, buffer, doc.file_name);
    } else {
      r = await ingestFile(ROOT, buffer, doc.file_name, mimeType);
    }
    await ctx.reply(`File saved (${type}).\n${r.pending} items pending.`);
    await triggerReactiveIfNeeded(ctx);
  } catch (err) {
    log('error', 'document failed', { error: err.message });
    ctx.reply(`Error processing file: ${err.message}`);
  }
});

// Start
bot.launch().then(() => {
  log('info', 'bot started', { userId: `...${String(ALLOWED_ID).slice(-3)}` });
  console.log(`Second Brain Bot started`);
  console.log(`   Single-user mode active (ID: ...${String(ALLOWED_ID).slice(-3)})`);
  console.log(`   Logs: .state/brain.log\n`);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
