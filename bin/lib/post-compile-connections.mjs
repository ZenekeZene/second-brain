/**
 * post-compile-connections — detects non-obvious connections between newly compiled
 * wiki articles and the rest of the wiki. Called after a successful compilation.
 *
 * Exported functions:
 *   detectConnections(root, newArticlePaths, apiKey) → string | null
 *
 * Returns a Telegram-ready message string, or null if nothing interesting was found
 * or if the detection should be skipped (too few articles, API error, etc.).
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Extract title and one-line summary from a wiki article.
 * Returns null if neither can be found.
 */
function extractMeta(content) {
  const title   = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const summary = content.match(/^>\s+(.+)$/m)?.[1]?.trim() ?? null;
  return title || summary ? { title, summary } : null;
}

/**
 * Extract all [[wikilinks]] already present in a piece of text.
 */
function extractWikilinks(content) {
  return [...content.matchAll(/\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g)]
    .map(m => m[1].trim().toLowerCase().replace(/\s+/g, '-'));
}

/**
 * Detect non-obvious connections between new articles and the rest of the wiki.
 *
 * @param {string}   root             - Absolute path to the project root
 * @param {string[]} newArticlePaths  - Relative paths like ["wiki/foo.md", "wiki/bar.md"]
 * @param {string}   apiKey
 * @returns {Promise<string | null>}  - Formatted Telegram message, or null
 */
export async function detectConnections(root, newArticlePaths, apiKey) {
  const wikiDir = join(root, 'wiki');
  if (!existsSync(wikiDir)) return null;

  const newSlugs = newArticlePaths
    .filter(p => p.startsWith('wiki/') && p.endsWith('.md'))
    .map(p => p.replace('wiki/', '').replace('.md', ''));

  if (newSlugs.length === 0) return null;

  // Read new articles — full content
  const newArticles = newSlugs
    .map(slug => {
      const path = join(wikiDir, `${slug}.md`);
      if (!existsSync(path)) return null;
      return { slug, content: readFileSync(path, 'utf8') };
    })
    .filter(Boolean);

  if (newArticles.length === 0) return null;

  // Collect wikilinks already in the new articles (skip re-detecting these)
  const alreadyLinked = new Set(newArticles.flatMap(a => extractWikilinks(a.content)));

  // Read existing articles — title + summary only (keep prompt small)
  const allSlugs = readdirSync(wikiDir)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
    .map(f => f.replace('.md', ''));

  const existingArticles = allSlugs
    .filter(slug => !newSlugs.includes(slug))
    .map(slug => {
      try {
        const content = readFileSync(join(wikiDir, `${slug}.md`), 'utf8');
        const meta = extractMeta(content);
        if (!meta) return null;
        const label = [meta.title, meta.summary].filter(Boolean).join(' — ');
        return `- [[${slug}]]: ${label}`;
      } catch { return null; }
    })
    .filter(Boolean);

  if (existingArticles.length === 0) return null;

  // Build prompt
  const newSection = newArticles.map(a =>
    `=== ${a.slug} ===\n${a.content.slice(0, 3000)}` // cap at 3 KB per article
  ).join('\n\n');

  const existingSection = existingArticles.join('\n');

  const alreadyLinkedNote = alreadyLinked.size > 0
    ? `\nAlready linked in the new articles (skip these): ${[...alreadyLinked].join(', ')}`
    : '';

  const model = process.env.CONNECTIONS_MODEL || 'claude-haiku-4-5-20251001';
  const client = new Anthropic({ apiKey });

  let raw;
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You find non-obvious intellectual connections in a personal knowledge wiki.

NEW articles just compiled:
${newSection}

EXISTING articles (title + summary):
${existingSection}
${alreadyLinkedNote}

Find 2–4 non-obvious connections between the NEW articles and the EXISTING ones.
A good connection:
- Is NOT already a [[wikilink]] in the new articles
- Shares a principle, mental model, structural pattern, or complementary idea
- Can be explained in one specific sentence (not vague like "both are interesting")

If there are fewer than 2 genuinely interesting connections, respond with exactly: none

Otherwise respond in this exact format (no intro, no outro):
[[new-slug]] ↔ [[existing-slug]]
One sentence explanation.

[[new-slug]] ↔ [[existing-slug]]
One sentence explanation.`,
      }],
    });
    raw = response.content[0]?.text?.trim() ?? '';
  } catch {
    return null; // silently skip if API fails
  }

  if (!raw || raw.toLowerCase() === 'none') return null;

  // Convert [[wikilinks]] to Telegram-safe *bold* and format message
  const body = raw
    .replace(/\[\[([^\]]+)\]\]/g, '*$1*')
    .replace(/↔/g, '↔');

  return `🔗 *Conexiones detectadas*\n\n${body}`;
}
