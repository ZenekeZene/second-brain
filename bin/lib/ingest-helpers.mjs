/**
 * Shared ingest helpers — used by ingest.mjs, telegram-bot.mjs, and wiki-server.mjs.
 *
 * All functions accept `root` (path to the repo root) so they work from any caller.
 * Functions return { path, pending } on success and throw on failure — no process.exit().
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, createReadStream,
} from 'fs';
import { join, extname } from 'path';
import TurndownService from 'turndown';
import { autoTag } from './autotag.mjs';
import { log } from './logger.mjs';
import { isYouTubeUrl, extractVideoId, fetchYouTubeMetadata, fetchYouTubeTranscript } from './youtube-helpers.mjs';

// ── Utilities ─────────────────────────────────────────────────────────────────

export function toSlug(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

export function today() { return new Date().toISOString().slice(0, 10); }
export function nowISO() { return new Date().toISOString(); }

export function readPending(root) {
  try {
    const data = JSON.parse(readFileSync(join(root, '.state', 'pending.json'), 'utf8'));
    if (!Array.isArray(data.pending)) data.pending = [];
    return data;
  } catch {
    return { pending: [], lastCompile: null };
  }
}

export function writePending(root, state) {
  writeFileSync(join(root, '.state', 'pending.json'), JSON.stringify(state, null, 2) + '\n');
}

export function addToPending(root, state, item) {
  state.pending.push(item);
  writePending(root, state);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

// ── Type detection ─────────────────────────────────────────────────────────────
// mimeType takes priority over content inspection.

export function detectType(content, mimeType, filename) {
  if (mimeType) {
    if (mimeType.startsWith('image/'))           return 'image';
    if (mimeType.startsWith('audio/'))           return 'voice';
    if (mimeType === 'application/pdf')          return 'pdf';
    if (mimeType !== 'text/plain')               return 'file';
  }
  // Text-based detection
  const text = (content || '').trim();
  if (/^https?:\/\/\S+$/.test(text))            return 'url';
  return 'note';
}

// ── Ingest: YouTube video ─────────────────────────────────────────────────────

export async function ingestYouTube(root, url, customTitle) {
  log('info', 'ingest:youtube start', { url });

  const videoId = extractVideoId(url);
  if (!videoId) throw new Error(`Could not extract video ID from: ${url}`);

  // 1. Metadata via oEmbed (title + channel)
  let title = customTitle;
  let channel = '';
  try {
    const meta = await fetchYouTubeMetadata(url);
    title = title || meta.title;
    channel = meta.channel;
    log('info', 'ingest:youtube metadata', { title, channel });
  } catch (err) {
    log('warn', 'ingest:youtube metadata failed', { error: err.message });
    title = title || `YouTube ${videoId}`;
  }

  // 2. Transcript via yt-dlp (captions only, no video download)
  let transcript;
  try {
    transcript = await fetchYouTubeTranscript(videoId, url);
    log('info', 'ingest:youtube transcript', { chars: transcript.length });
  } catch (err) {
    log('error', 'ingest:youtube transcript failed', { error: err.message });
    throw new Error(`Could not get transcript: ${err.message}`);
  }

  // 3. Save to raw/articles/
  const slug = toSlug(title);
  const filename = `${today()}-${slug}.md`;
  const dir = join(root, 'raw', 'articles');
  ensureDir(dir);

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const channelLine = channel ? `channel: "${channel}"\n` : '';
  const tags = await autoTag(`${title} ${channel} ${transcript.slice(0, 300)}`);
  const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';

  const fileContent = `---
source: ${canonicalUrl}
title: "${title.replace(/"/g, '\\"')}"
${channelLine}ingested: ${nowISO()}
type: video
status: pending
${tagsStr}---

# ${title}

> YouTube${channel ? ` — ${channel}` : ''}

## Transcript

${transcript}
`;

  writeFileSync(join(dir, filename), fileContent);

  const state = readPending(root);
  addToPending(root, state, { path: `raw/articles/${filename}`, ingested: nowISO(), type: 'video' });

  log('info', 'ingest:youtube saved', { path: `raw/articles/${filename}`, tags, pending: state.pending.length });
  return { path: `raw/articles/${filename}`, title, channel, pending: state.pending.length };
}

// ── Ingest: URL ───────────────────────────────────────────────────────────────

export async function ingestUrl(root, url, customTitle) {
  // YouTube video URLs → transcript extraction
  if (isYouTubeUrl(url) && extractVideoId(url)) {
    return ingestYouTube(root, url, customTitle);
  }

  log('info', 'ingest:url start', { url });

  let html;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SecondBrain/1.0)' },
    });
    html = await res.text();
  } catch (err) {
    log('error', 'ingest:url fetch failed', { url, error: err.message });
    throw new Error(`Error fetching URL: ${err.message}`);
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = customTitle || (titleMatch ? titleMatch[1].trim() : url);

  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const cleanHtml = html
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const markdown = td.turndown(cleanHtml);

  const slug = toSlug(title);
  const filename = `${today()}-${slug}.md`;
  const dir = join(root, 'raw', 'articles');
  ensureDir(dir);

  const tags = await autoTag(`${title} ${markdown.slice(0, 500)}`);
  const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';

  const fileContent = `---
source: ${url}
title: "${title.replace(/"/g, '\\"')}"
ingested: ${nowISO()}
type: article
status: pending
${tagsStr}---

# ${title}

${markdown}
`;

  writeFileSync(join(dir, filename), fileContent);

  const state = readPending(root);
  addToPending(root, state, { path: `raw/articles/${filename}`, ingested: nowISO(), type: 'article' });

  log('info', 'ingest:url saved', { path: `raw/articles/${filename}`, tags, pending: state.pending.length });
  return { path: `raw/articles/${filename}`, pending: state.pending.length };
}

// ── Ingest: Note ──────────────────────────────────────────────────────────────

export async function ingestNote(root, text, source) {
  const slug = toSlug(text.split(' ').slice(0, 6).join(' '));
  const filename = `${today()}-${slug}.md`;
  const dir = join(root, 'raw', 'notes');
  ensureDir(dir);

  const tags = await autoTag(text);
  const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';
  const sourceLine = source ? `source: ${source}\n` : '';

  const fileContent = `---
ingested: ${nowISO()}
type: note
status: pending
${sourceLine}${tagsStr}---

${text}
`;

  writeFileSync(join(dir, filename), fileContent);

  const state = readPending(root);
  addToPending(root, state, { path: `raw/notes/${filename}`, ingested: nowISO(), type: 'note' });

  log('info', 'ingest:note saved', { path: `raw/notes/${filename}`, tags, pending: state.pending.length });
  return { path: `raw/notes/${filename}`, pending: state.pending.length };
}

// ── Ingest: Bookmark ──────────────────────────────────────────────────────────

export async function ingestBookmark(root, url, source) {
  const filename = `${today()}-bookmarks.md`;
  const dir = join(root, 'raw', 'bookmarks');
  ensureDir(dir);
  const filepath = join(dir, filename);
  const line = `- [ ] ${url} — (process)\n`;
  const sourceLine = source ? `source: ${source}\n` : '';

  if (!existsSync(filepath)) {
    const tags = await autoTag(url);
    const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';
    const header = `---\ningested: ${nowISO()}\ntype: bookmark\nstatus: pending\n${sourceLine}${tagsStr}---\n\n# Bookmarks ${today()}\n\n`;
    writeFileSync(filepath, header + line);
    const state = readPending(root);
    addToPending(root, state, { path: `raw/bookmarks/${filename}`, ingested: nowISO(), type: 'bookmark' });
  } else {
    writeFileSync(filepath, readFileSync(filepath, 'utf8') + line);
  }

  const state = readPending(root);
  log('info', 'ingest:bookmark saved', { path: `raw/bookmarks/${filename}`, url, pending: state.pending.length });
  return { path: `raw/bookmarks/${filename}`, pending: state.pending.length };
}

// ── Ingest: File (generic binary/text) ────────────────────────────────────────

export async function ingestFile(root, buffer, filename, mimeType) {
  const ext = extname(filename).toLowerCase();
  const name = filename.slice(0, filename.length - ext.length);
  const slug = toSlug(name);
  const mdFilename = `${today()}-${slug}.md`;
  const dir = join(root, 'raw', 'files');
  ensureDir(dir);

  let fileContent;
  if (ext === '.md' || ext === '.txt' || mimeType === 'text/plain') {
    const text = buffer.toString('utf8');
    const tags = await autoTag(`${name} ${text.slice(0, 500)}`);
    const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';
    fileContent = `---
original_name: ${filename}
ingested: ${nowISO()}
type: file
status: pending
${tagsStr}---

${text}
`;
  } else {
    // Save original binary + create stub md
    writeFileSync(join(dir, filename), buffer);
    const tags = await autoTag(name);
    const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';
    fileContent = `---
original_name: ${filename}
ingested: ${nowISO()}
type: file
status: pending
${tagsStr}---

# ${name}

> Original file: raw/files/${filename}
> Format: ${ext.slice(1).toUpperCase() || mimeType}

<!-- The LLM will process this file during compilation -->
`;
  }

  writeFileSync(join(dir, mdFilename), fileContent);

  const state = readPending(root);
  addToPending(root, state, { path: `raw/files/${mdFilename}`, ingested: nowISO(), type: 'file' });

  log('info', 'ingest:file saved', { path: `raw/files/${mdFilename}`, pending: state.pending.length });
  return { path: `raw/files/${mdFilename}`, pending: state.pending.length };
}

// ── AI: Image description (GPT-4o Vision) ─────────────────────────────────────

export async function describeImage(openai, buffer, mimeType, caption) {
  const base64 = buffer.toString('base64');
  const effectiveMime = mimeType || 'image/jpeg';
  const visionResponse = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${effectiveMime};base64,${base64}` } },
        { type: 'text', text: `Describe this image in detail. ${caption ? `User context: "${caption}".` : ''} Include: what is shown, colors, composition, any text visible, and any other relevant details.` },
      ],
    }],
  });
  return visionResponse.choices[0].message.content;
}

// ── AI: Audio transcription (Whisper) ─────────────────────────────────────────

export async function transcribeAudio(openai, buffer, filename) {
  const tmpPath = join('/tmp', `brain-audio-${Date.now()}-${filename}`);
  writeFileSync(tmpPath, buffer);
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'es',
    });
    return transcription.text;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

// ── Ingest: Image ─────────────────────────────────────────────────────────────

export async function ingestImage(root, openai, buffer, filename, mimeType, caption) {
  const ext = extname(filename) || '.jpg';
  const name = filename.slice(0, filename.length - ext.length);
  const slug = toSlug((caption || name).slice(0, 40));
  const imageFilename = `${today()}-${slug}${ext}`;
  const mdFilename = `${today()}-${slug}.md`;
  const dir = join(root, 'raw', 'images');
  ensureDir(dir);

  // Save original image
  writeFileSync(join(dir, imageFilename), buffer);
  log('info', 'ingest:image saved binary', { file: imageFilename });

  // Describe with vision
  const description = await describeImage(openai, buffer, mimeType, caption);
  log('info', 'ingest:image described', { chars: description.length });

  const mdContent = `---
source_image: raw/images/${imageFilename}
ingested: ${nowISO()}
type: image
status: pending
source: web
---

## Description

${description}

## Context

${caption || '<!-- User can add context here before compiling -->'}
`;

  writeFileSync(join(dir, mdFilename), mdContent);

  const state = readPending(root);
  addToPending(root, state, { path: `raw/images/${mdFilename}`, type: 'image', ingested: nowISO() });

  log('info', 'ingest:image ingested', { path: `raw/images/${mdFilename}`, pending: state.pending.length });
  return { path: `raw/images/${mdFilename}`, description, pending: state.pending.length };
}

// ── Ingest: Voice ─────────────────────────────────────────────────────────────

export async function ingestVoice(root, openai, buffer, filename) {
  log('info', 'ingest:voice transcribing', { filename });
  let transcription;
  try {
    transcription = await transcribeAudio(openai, buffer, filename);
    log('info', 'ingest:voice transcribed', { chars: transcription.length });
  } catch (err) {
    log('error', 'ingest:voice transcription failed', { error: err.message });
    // Fallback: save stub note
    const stub = `<!-- Transcription failed: ${err.message} -->`;
    const state = readPending(root);
    const fallbackSlug = `voice-${Date.now()}`;
    const fallbackFilename = `${today()}-${fallbackSlug}.md`;
    const dir = join(root, 'raw', 'notes');
    ensureDir(dir);
    const mdContent = `---\ningested: ${nowISO()}\ntype: note\nstatus: pending\nsource: web-voice\n---\n\n${stub}\n`;
    writeFileSync(join(dir, fallbackFilename), mdContent);
    addToPending(root, state, { path: `raw/notes/${fallbackFilename}`, type: 'note', ingested: nowISO() });
    throw new Error(`Transcription failed: ${err.message}`);
  }
  return ingestNote(root, transcription, 'web-voice');
}

// ── Ingest: PDF ───────────────────────────────────────────────────────────────

export async function ingestPdf(root, buffer, filename) {
  const name = filename.replace(/\.pdf$/i, '');
  const slug = toSlug(name);
  const mdFilename = `${today()}-${slug}.md`;
  const dir = join(root, 'raw', 'files');
  ensureDir(dir);

  // Save original PDF
  writeFileSync(join(dir, filename), buffer);

  let extractedText = '';
  try {
    // Dynamic import so servers without pdf-parse still load
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const data = await pdfParse(buffer);
    extractedText = data.text || '';
    log('info', 'ingest:pdf parsed', { chars: extractedText.length, pages: data.numpages });
  } catch (err) {
    log('warn', 'ingest:pdf parse failed', { error: err.message });
    extractedText = '<!-- PDF text extraction failed — LLM will process the original file -->';
  }

  const tags = await autoTag(`${name} ${extractedText.slice(0, 500)}`);
  const tagsStr = tags.length ? `tags: [${tags.join(', ')}]\n` : '';

  const mdContent = `---
original_name: ${filename}
source_file: raw/files/${filename}
ingested: ${nowISO()}
type: file
status: pending
${tagsStr}---

# ${name}

> Original PDF: raw/files/${filename}

${extractedText}
`;

  writeFileSync(join(dir, mdFilename), mdContent);

  const state = readPending(root);
  addToPending(root, state, { path: `raw/files/${mdFilename}`, ingested: nowISO(), type: 'file' });

  log('info', 'ingest:pdf saved', { path: `raw/files/${mdFilename}`, pending: state.pending.length });
  return { path: `raw/files/${mdFilename}`, pending: state.pending.length };
}
