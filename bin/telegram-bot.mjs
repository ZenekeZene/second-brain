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
 *   /start              -> welcome and help
 *   /status             -> brain status
 *   /pending            -> items pending compilation
 *   /help               -> list of commands
 *
 * Automatic messages:
 *   URL alone           -> brain: save <url>
 *   Plain text          -> brain: note <text>
 *   brain: <command>    -> executes the command directly
 *   Photo               -> brain: image (download + description pending)
 */

import { Telegraf } from 'telegraf';
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import { spawn } from 'child_process';
import OpenAI from 'openai';
import { autoTag } from './lib/autotag.mjs';
import { log, LOG_PATH_EXPORT as LOG_PATH } from './lib/logger.mjs';
import { shouldCompile, triggerMessage } from './lib/reactive.mjs';

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

function toSlug(text) {
  return text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-')
    .slice(0, 60);
}

function today() { return new Date().toISOString().slice(0, 10); }
function nowISO() { return new Date().toISOString(); }

function readPending() {
  try {
    const data = JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8'));
    if (!Array.isArray(data.pending)) data.pending = [];
    return data;
  } catch { return { pending: [], lastCompile: null }; }
}

function writePending(state) {
  writeFileSync(join(ROOT, '.state', 'pending.json'), JSON.stringify(state, null, 2) + '\n');
}

function isUrl(text) {
  return /^https?:\/\/\S+/.test(text.trim());
}

// ── ingest helpers ────────────────────────────────────────────────────────────

async function saveNote(text) {
  const slug = toSlug(text.split(' ').slice(0, 6).join(' '));
  const filename = `${today()}-${slug}.md`;
  const dir = join(ROOT, 'raw', 'notes');
  mkdirSync(dir, { recursive: true });
  const tags = await autoTag(text);
  const tagsLine = tags.length ? `tags: [${tags.join(', ')}]\n` : '';
  const content = `---\ningested: ${nowISO()}\ntype: note\nstatus: pending\nsource: telegram\n${tagsLine}---\n\n${text}\n`;
  writeFileSync(join(dir, filename), content);
  const state = readPending();
  state.pending.push({ path: `raw/notes/${filename}`, type: 'note', ingested: nowISO() });
  writePending(state);
  return { filename, pending: state.pending.length, tags };
}

async function saveBookmark(url) {
  const filename = `${today()}-bookmarks.md`;
  const dir = join(ROOT, 'raw', 'bookmarks');
  mkdirSync(dir, { recursive: true });
  const filepath = join(dir, filename);
  const line = `- [ ] ${url} — (process)\n`;
  if (!existsSync(filepath)) {
    const tags = await autoTag(url);
    const tagsLine = tags.length ? `tags: [${tags.join(', ')}]\n` : '';
    writeFileSync(filepath, `---\ningested: ${nowISO()}\ntype: bookmark\nstatus: pending\nsource: telegram\n${tagsLine}---\n\n# Bookmarks ${today()}\n\n${line}`);
    const state = readPending();
    state.pending.push({ path: `raw/bookmarks/${filename}`, type: 'bookmark', ingested: nowISO() });
    writePending(state);
  } else {
    writeFileSync(filepath, readFileSync(filepath, 'utf8') + line);
  }
  const state = readPending();
  return { filename, pending: state.pending.length };
}

function getStatus() {
  const state = readPending();
  const wikiDir = join(ROOT, 'wiki');
  let articles = 0;
  try { articles = readFileSync(join(ROOT, 'INDEX.md'), 'utf8').match(/\[\[/g)?.length || 0; } catch {}
  const lastCompile = state.lastCompile
    ? new Date(state.lastCompile).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'never';
  return { articles, pending: state.pending.length, lastCompile, items: state.pending };
}

async function triggerReactiveIfNeeded(ctx) {
  const state = readPending();
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

// ── audio transcription ───────────────────────────────────────────────────────

async function transcribeVoice(ctx, fileId) {
  // 1. Get download URL from Telegram
  const file = await ctx.telegram.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

  // 2. Download file to /tmp
  const tmpPath = join('/tmp', `voice-${fileId}.ogg`);
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Error downloading audio: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(tmpPath, buffer);

  // 3. Transcribe with Whisper API
  const transcription = await openai.audio.transcriptions.create({
    file: createReadStream(tmpPath),
    model: 'whisper-1',
    language: 'es',
  });

  // 4. Clean up temp file
  try { unlinkSync(tmpPath); } catch {}

  return transcription.text;
}

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

Ingest content into your wiki directly from here.

*Automatic ingestion:*
• Send a URL -> saves it as an article
• Send text -> saves it as a note
• Send \`brain: save <url>\` -> same as above
• Send \`brain: bookmark <url>\` -> bookmark for later processing

*Commands:*
/status — brain status
/pending — pending items
/logs — last 10 events
/help — this help`));

// /help
bot.help((ctx) => ctx.replyWithMarkdown(`*Available commands:*

/status — articles, pending, last compilation
/pending — list of items to compile
/logs — last 10 events (debug)
/help — this help

*Automatic messages:*
\`https://...\` -> saves as article to process
\`Any text\` -> saves as note
\`brain: bookmark https://...\` -> bookmark`));

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

  // Explicit brain: command
  if (text.toLowerCase().startsWith('brain:')) {
    const cmd = text.slice(6).trim();

    if (isUrl(cmd) || cmd.toLowerCase().startsWith('save ')) {
      const url = cmd.replace(/^save\s+/i, '').trim();
      if (!isUrl(url)) return ctx.reply('Invalid URL.');
      const r = await saveBookmark(url);
      await ctx.reply(`URL saved for processing.\n${r.pending} items pending.`);
      await triggerReactiveIfNeeded(ctx);
      return;
    }

    if (cmd.toLowerCase().startsWith('bookmark ')) {
      const url = cmd.replace(/^bookmark\s+/i, '').trim();
      if (!isUrl(url)) return ctx.reply('Invalid URL.');
      const r = await saveBookmark(url);
      await ctx.reply(`Bookmark saved.\n${r.pending} items pending.`);
      await triggerReactiveIfNeeded(ctx);
      return;
    }

    if (cmd.toLowerCase().startsWith('note ')) {
      const noteText = cmd.replace(/^note\s+/i, '').trim();
      const r = await saveNote(noteText);
      await ctx.reply(`Note saved.\n${r.pending} items pending.`);
      await triggerReactiveIfNeeded(ctx);
      return;
    }

    return ctx.reply(`Unknown command: "${cmd}"\nUse /help to see available commands.`);
  }

  // URL sola → guardar para procesar (como artículo)
  if (isUrl(text)) {
    const r = await saveBookmark(text);
    await ctx.reply(`URL saved for processing.\n${r.pending} items pending.\n\nContent will be expanded on next compile.`);
    await triggerReactiveIfNeeded(ctx);
    return;
  }

  // Plain text -> note
  if (text.length > 0) {
    const r = await saveNote(text);
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
    const slug = toSlug((caption || 'image').slice(0, 40));
    const imageFilename = `${today()}-${slug}.${ext}`;
    const dir = join(ROOT, 'raw', 'images');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, imageFilename), buffer);
    log('info', 'photo saved', { file: imageFilename });

    const base64 = buffer.toString('base64');
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: `Describe this image in detail. ${caption ? `User context: "${caption}".` : ''} Include: what is shown, colors, composition, any text visible, and any other relevant details.` }
        ]
      }]
    });
    const description = visionResponse.choices[0].message.content;
    log('info', 'photo described', { chars: description.length });

    const mdFilename = `${today()}-${slug}.md`;
    const mdContent = `---\nsource_image: raw/images/${imageFilename}\ningested: ${nowISO()}\ntype: image\nstatus: pending\nsource: telegram\n---\n\n## Description\n\n${description}\n\n## Context\n\n${caption || '<!-- User can add context here before compiling -->'}\n`;
    writeFileSync(join(dir, mdFilename), mdContent);

    const state = readPending();
    state.pending.push({ path: `raw/images/${mdFilename}`, type: 'image', ingested: nowISO() });
    writePending(state);
    log('info', 'photo ingested', { path: `raw/images/${mdFilename}`, pending: state.pending.length });

    await ctx.reply(`Image analyzed and saved.\n\n_${description.slice(0, 200)}${description.length > 200 ? '...' : ''}_\n\n${state.pending.length} items pending.`, { parse_mode: 'Markdown' });
    await triggerReactiveIfNeeded(ctx);
  } catch (err) {
    log('error', 'photo failed', { error: err.message });
    ctx.reply('Error processing the photo. Check server logs.');
  }
});

// Voice notes -> automatic transcription with Whisper
bot.on('voice', async (ctx) => {
  const voice = ctx.message.voice;
  const duration = voice.duration;
  log('info', 'voice received', { duration });

  await ctx.reply(`Voice note received (${duration}s). Transcribing...`);

  let transcription;
  try {
    transcription = await transcribeVoice(ctx, voice.file_id);
    log('info', 'voice transcribed', { chars: transcription.length });
  } catch (err) {
    log('error', 'transcription failed', { error: err.message });
    // Fallback: save without transcription
    const filename = `${today()}-voice-${voice.file_id.slice(-8)}.md`;
    const dir = join(ROOT, 'raw', 'notes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename),
      `---\nsource_audio: telegram:${voice.file_id.slice(-8)}\ningested: ${nowISO()}\ntype: note\nstatus: pending\nsource: telegram-voice\n---\n\n<!-- Transcription failed — check server logs -->\n`
    );
    const state = readPending();
    state.pending.push({ path: `raw/notes/${filename}`, type: 'note', ingested: nowISO() });
    writePending(state);
    return ctx.reply(`Transcription failed. Saved without text.\n${state.pending.length} items pending.`);
  }

  // Save note with transcription
  const r = await saveNote(transcription);
  log('info', 'voice ingested', { path: r.filename, pending: r.pending });
  await ctx.reply(`Transcription ready:\n\n_"${transcription}"_\n\nSaved as note.\n${r.pending} items pending.`, { parse_mode: 'Markdown' });
  await triggerReactiveIfNeeded(ctx);
});

// Documents / files
bot.on('document', (ctx) => {
  const doc = ctx.message.document;
  ctx.reply(`Files not supported yet (${doc.file_name}).\nSend the URL or text content instead.`);
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
