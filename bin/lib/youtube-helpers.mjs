/**
 * YouTube ingestion helpers.
 *
 * Uses yt-dlp to extract captions — the only reliable approach since YouTube
 * started blocking server-side timedtext API requests (2024+).
 *
 * Requires: brew install yt-dlp  (or pipx install yt-dlp)
 *
 * Strategy:
 *   1. Metadata via YouTube's public oEmbed API (free, no auth)
 *   2. Captions via yt-dlp --write-auto-sub (downloads .vtt, no video download)
 *   3. VTT cleaned into plain text (deduped, timing stripped)
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { log } from './logger.mjs';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** Returns true for youtube.com, youtu.be, m.youtube.com URLs. */
export function isYouTubeUrl(url) {
  try {
    const { hostname } = new URL(url);
    return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Extracts the video ID from any YouTube URL format.
 * Returns null for playlists, channels, or unrecognized formats.
 */
export function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0] || null;
    return u.searchParams.get('v') || null;
  } catch {
    return null;
  }
}

/**
 * Fetches video title and channel via YouTube's public oEmbed API.
 * No auth required. Works for any public video.
 */
export async function fetchYouTubeMetadata(url) {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const res = await fetch(endpoint, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`oEmbed failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return {
    title: data.title || 'Untitled',
    channel: data.author_name || '',
  };
}

/**
 * Checks whether yt-dlp is available on the system.
 * Throws with install instructions if not found.
 */
function requireYtDlp() {
  try {
    execSync('yt-dlp --version', { stdio: 'ignore' });
  } catch {
    throw new Error(
      'yt-dlp is required for YouTube transcript extraction.\n' +
      'Install it with: brew install yt-dlp\n' +
      'Or: pip install yt-dlp'
    );
  }
}

/**
 * Cleans a VTT subtitle file into a single plain text string.
 * Removes timing lines, strips inline tags, deduplicates rolling captions.
 */
function cleanVtt(vtt) {
  const seen = new Set();
  const result = [];

  for (const line of vtt.split('\n')) {
    const t = line.trim();
    // Skip VTT headers, timing lines, cue numbers, and empties
    if (!t || t.startsWith('WEBVTT') || t.startsWith('Kind:') || t.startsWith('Language:')) continue;
    if (/^\d+$/.test(t)) continue;
    if (/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(t)) continue;

    // Strip inline timing tags and color/style markup
    const clean = t
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }

  return result
    .join(' ')
    .replace(/\[.*?\]/g, '')   // strip [Music], [Applause], etc.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Downloads and returns the transcript for a YouTube video using yt-dlp.
 * Fetches only the subtitle file — no video or audio is downloaded.
 *
 * @param {string} videoId - YouTube video ID
 * @param {string} url     - Full YouTube URL (passed to yt-dlp for context)
 * @returns {Promise<string>} Clean transcript text
 */
export async function fetchYouTubeTranscript(videoId, url) {
  requireYtDlp();

  const tmpPrefix = join('/tmp', `brain-yt-${videoId}`);
  const outputTemplate = `${tmpPrefix}.%(ext)s`;

  // Build yt-dlp command: captions only, prefer English, no video download
  const cmd = [
    'yt-dlp',
    '--write-auto-sub',
    '--skip-download',
    '--sub-format vtt',
    '--sub-langs en',
    `--output "${tmpPrefix}"`,
    `"${url}"`,
  ].join(' ');

  log('info', 'ingest:youtube yt-dlp start', { videoId });

  try {
    execSync(cmd, { timeout: 60_000, stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    if (stderr.includes('no subtitles') || stderr.includes('No automatic captions')) {
      throw new Error('No captions available for this video.');
    }
    throw new Error(`yt-dlp failed: ${stderr.slice(0, 200)}`);
  }

  // Find the generated VTT file (yt-dlp may name it e.g. brain-yt-ID.en.vtt)
  let vttPath = null;
  try {
    const files = readdirSync('/tmp').filter(
      f => f.startsWith(`brain-yt-${videoId}`) && f.endsWith('.vtt')
    );
    if (files.length) vttPath = join('/tmp', files[0]);
  } catch {}

  if (!vttPath || !existsSync(vttPath)) {
    throw new Error('No captions file generated. The video may not have subtitles.');
  }

  log('info', 'ingest:youtube vtt found', { path: vttPath });

  try {
    const vtt = readFileSync(vttPath, 'utf8');
    const transcript = cleanVtt(vtt);
    if (!transcript) throw new Error('Transcript is empty after parsing.');
    return transcript;
  } finally {
    try { unlinkSync(vttPath); } catch {}
  }
}
