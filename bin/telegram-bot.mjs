#!/usr/bin/env node
/**
 * second-brain Telegram bot
 * Ingesta contenido al brain directamente desde el móvil.
 *
 * Uso:
 *   node bin/telegram-bot.mjs
 *
 * Variables de entorno requeridas (.env):
 *   TELEGRAM_BOT_TOKEN       — token del bot (de @BotFather)
 *   TELEGRAM_ALLOWED_USER_ID — tu Telegram user ID (de @userinfobot)
 *
 * Comandos soportados:
 *   /start              → bienvenida y ayuda
 *   /status             → estado del brain
 *   /pending            → items pendientes de compilar
 *   /help               → lista de comandos
 *
 * Mensajes automáticos:
 *   URL sola            → brain: save <url>
 *   Texto normal        → brain: nota <texto>
 *   brain: <comando>    → ejecuta el comando directamente
 *   Foto                → brain: image (descarga + descripción pendiente)
 */

import { Telegraf } from 'telegraf';
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import OpenAI from 'openai';
import { autoTag } from './lib/autotag.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Cargar .env manualmente (sin dependencia de dotenv) ──────────────────────
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
  console.error('Error: TELEGRAM_BOT_TOKEN no definido en .env');
  process.exit(1);
}
if (!ALLOWED_ID) {
  console.error('Error: TELEGRAM_ALLOWED_USER_ID no definido en .env');
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
  try { return JSON.parse(readFileSync(join(ROOT, '.state', 'pending.json'), 'utf8')); }
  catch { return { pending: [], lastCompile: null }; }
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
  const line = `- [ ] ${url} — (procesar)\n`;
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
    ? new Date(state.lastCompile).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'nunca';
  return { articles, pending: state.pending.length, lastCompile, items: state.pending };
}

// ── bot ───────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── transcripción de audio ────────────────────────────────────────────────────

async function transcribeVoice(ctx, fileId) {
  // 1. Obtener URL de descarga de Telegram
  const file = await ctx.telegram.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

  // 2. Descargar el archivo a /tmp
  const tmpPath = join('/tmp', `voice-${fileId}.ogg`);
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Error descargando audio: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(tmpPath, buffer);

  // 3. Transcribir con Whisper API
  const transcription = await openai.audio.transcriptions.create({
    file: createReadStream(tmpPath),
    model: 'whisper-1',
    language: 'es',
  });

  // 4. Limpiar archivo temporal
  try { unlinkSync(tmpPath); } catch {}

  return transcription.text;
}

const bot = new Telegraf(TOKEN);

// Middleware de autenticación — solo acepta mensajes del usuario autorizado
bot.use((ctx, next) => {
  const userId = ctx.from?.id;
  if (userId !== ALLOWED_ID) {
    console.log(`Mensaje rechazado de user ${userId}`);
    return ctx.reply('No autorizado.');
  }
  return next();
});

// /start
bot.start((ctx) => ctx.replyWithMarkdown(`*🧠 Second Brain Bot*

Ingesta contenido a tu wiki directamente desde aquí.

*Uso automático:*
• Manda una URL → la guarda como artículo
• Manda texto → lo guarda como nota
• Manda \`brain: save <url>\` → igual que arriba
• Manda \`brain: bookmark <url>\` → bookmark para procesar después

*Comandos:*
/status — estado del brain
/pending — items pendientes
/help — esta ayuda`));

// /help
bot.help((ctx) => ctx.replyWithMarkdown(`*Comandos disponibles:*

/status — artículos, pendientes, última compilación
/pending — lista de items por compilar
/help — esta ayuda

*Mensajes automáticos:*
\`https://...\` → guarda como artículo a procesar
\`Cualquier texto\` → guarda como nota
\`brain: bookmark https://...\` → bookmark`));

// /status
bot.command('status', (ctx) => {
  const s = getStatus();
  const pendingStr = s.pending > 0 ? `⏳ ${s.pending} pendientes` : '✅ Al día';
  ctx.replyWithMarkdown(`*🧠 Second Brain*\n\n📚 ${s.articles} artículos\n${pendingStr}\n🕐 Compilado: ${s.lastCompile}`);
});

// /pending
bot.command('pending', (ctx) => {
  const s = getStatus();
  if (s.items.length === 0) return ctx.reply('✅ No hay items pendientes.');
  const list = s.items.map(i => `• [${i.type}] ${i.path.split('/').pop()}`).join('\n');
  ctx.replyWithMarkdown(`*⏳ Pendientes (${s.items.length}):*\n\n${list}`);
});

// Mensajes de texto
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Comando brain: explícito
  if (text.toLowerCase().startsWith('brain:')) {
    const cmd = text.slice(6).trim();

    if (isUrl(cmd) || cmd.toLowerCase().startsWith('save ') || cmd.toLowerCase().startsWith('artículo ')) {
      const url = cmd.replace(/^(save|artículo)\s+/i, '').trim();
      if (!isUrl(url)) return ctx.reply('URL no válida.');
      const r = await saveBookmark(url);
      return ctx.reply(`📌 URL guardada para procesar.\n${r.pending} items pendientes.`);
    }

    if (cmd.toLowerCase().startsWith('bookmark ') || cmd.toLowerCase().startsWith('guarda ')) {
      const url = cmd.replace(/^(bookmark|guarda)\s+/i, '').trim();
      if (!isUrl(url)) return ctx.reply('URL no válida.');
      const r = await saveBookmark(url);
      return ctx.reply(`🔖 Bookmark guardado.\n${r.pending} items pendientes.`);
    }

    if (cmd.toLowerCase().startsWith('nota ') || cmd.toLowerCase().startsWith('note ')) {
      const noteText = cmd.replace(/^(nota|note)\s+/i, '').trim();
      const r = await saveNote(noteText);
      return ctx.reply(`📝 Nota guardada.\n${r.pending} items pendientes.`);
    }

    return ctx.reply(`Comando no reconocido: "${cmd}"\nUsa /help para ver los comandos disponibles.`);
  }

  // URL sola → guardar para procesar (como artículo)
  if (isUrl(text)) {
    const r = await saveBookmark(text);
    return ctx.reply(`📌 URL guardada para procesar.\n${r.pending} items pendientes.\n\nCuando compiles, se expandirá el contenido.`);
  }

  // Texto plano → nota
  if (text.length > 0) {
    const r = await saveNote(text);
    return ctx.reply(`📝 Nota guardada (${text.length} chars).\n${r.pending} items pendientes.`);
  }
});

// Fotos → descargar + describir con GPT-4 Vision + guardar en raw/images/
bot.on('photo', async (ctx) => {
  const caption = ctx.message.caption || '';
  await ctx.reply(`🖼 Foto recibida${caption ? ` — "${caption}"` : ''}. Analizando...`);

  try {
    const photo = ctx.message.photo.at(-1); // mayor resolución
    const file = await ctx.telegram.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

    // Descargar imagen
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Error descargando imagen: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Guardar imagen en raw/images/
    const ext = file.file_path.split('.').pop() || 'jpg';
    const slug = toSlug((caption || 'imagen').slice(0, 40));
    const imageFilename = `${today()}-${slug}.${ext}`;
    const dir = join(ROOT, 'raw', 'images');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, imageFilename), buffer);

    // Describir con GPT-4 Vision
    const base64 = buffer.toString('base64');
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: `Describe esta imagen en detalle en español. ${caption ? `Contexto del usuario: "${caption}".` : ''} Incluye: qué se ve, colores, composición, texto si lo hay, y cualquier detalle relevante.` }
        ]
      }]
    });
    const description = visionResponse.choices[0].message.content;

    // Guardar markdown con descripción
    const mdFilename = `${today()}-${slug}.md`;
    const mdContent = `---\nsource_image: raw/images/${imageFilename}\ningested: ${nowISO()}\ntype: image\nstatus: pending\nsource: telegram\n---\n\n## Descripción\n\n${description}\n\n## Contexto\n\n${caption || '<!-- El usuario puede añadir contexto aquí antes de compilar -->'}\n`;
    writeFileSync(join(dir, mdFilename), mdContent);

    const state = readPending();
    state.pending.push({ path: `raw/images/${mdFilename}`, type: 'image', ingested: nowISO() });
    writePending(state);

    ctx.reply(`✅ Imagen analizada y guardada.\n\n_${description.slice(0, 200)}${description.length > 200 ? '…' : ''}_\n\n${state.pending.length} items pendientes.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error procesando foto:', err.message);
    ctx.reply(`⚠️ Error procesando la foto: ${err.message}`);
  }
});

// Notas de voz → transcripción automática con Whisper
bot.on('voice', async (ctx) => {
  const voice = ctx.message.voice;
  const duration = voice.duration;

  await ctx.reply(`🎙 Nota de voz recibida (${duration}s). Transcribiendo...`);

  let transcription;
  try {
    transcription = await transcribeVoice(ctx, voice.file_id);
  } catch (err) {
    console.error('Error transcribiendo:', err.message);
    // Fallback: guardar sin transcripción
    const filename = `${today()}-voice-${voice.file_id.slice(-8)}.md`;
    const dir = join(ROOT, 'raw', 'notes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename),
      `---\nsource_audio: telegram:${voice.file_id.slice(-8)}\ningested: ${nowISO()}\ntype: note\nstatus: pending\nsource: telegram-voice\n---\n\n<!-- Transcripción fallida — revisar logs del servidor -->\n`
    );
    const state = readPending();
    state.pending.push({ path: `raw/notes/${filename}`, type: 'note', ingested: nowISO() });
    writePending(state);
    return ctx.reply(`⚠️ Error en transcripción. Guardada sin texto.\n${state.pending.length} items pendientes.`);
  }

  // Guardar nota con la transcripción
  const r = saveNote(transcription);
  ctx.reply(`✅ Transcripción lista:\n\n_"${transcription}"_\n\n📝 Guardada como nota.\n${r.pending} items pendientes.`, { parse_mode: 'Markdown' });
});

// Documentos / ficheros
bot.on('document', (ctx) => {
  const doc = ctx.message.document;
  ctx.reply(`📎 Ficheros no soportados aún (${doc.file_name}).\nPor ahora manda la URL o el texto del contenido.`);
});

// Arrancar
bot.launch().then(() => {
  console.log(`🧠 Second Brain Bot arrancado`);
  console.log(`   Modo single-user activo (ID: ...${String(ALLOWED_ID).slice(-3)})`);
  console.log(`   Esperando mensajes...\n`);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
