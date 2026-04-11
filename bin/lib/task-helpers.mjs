/**
 * task-helpers — Task and reminder storage + natural language date parsing.
 *
 * Task files live in raw/tasks/YYYY-MM-DD-<slug>.md
 * Frontmatter fields: text, due (ISO datetime), done (bool), created (ISO)
 *
 * Exported functions:
 *   parseTaskMessage(message, apiKey) → { text, due: Date } | null
 *   saveTask(root, text, due)         → { path }
 *   readTasks(root)                   → Task[]
 *   markDone(root, taskPath)          → void
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

// ── parseTaskMessage ──────────────────────────────────────────────────────────

/**
 * Use Claude Haiku to extract task text and due date from a natural language message.
 * Handles Spanish and English, relative dates ("mañana a las 10", "in 2 hours").
 *
 * Returns null if the message doesn't look like a reminder.
 *
 * @param {string} message
 * @param {string} apiKey
 * @returns {Promise<{ text: string, due: Date } | null>}
 */
export async function parseTaskMessage(message, apiKey) {
  const now = new Date();
  const nowStr = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: `Extract the reminder task and due date from this message.
Current date/time: ${nowStr}
Message: "${message}"

Rules:
- "mañana" = tomorrow, "pasado mañana" = day after tomorrow
- "en X horas/minutos" = relative from now
- If only a time is given (e.g. "a las 10"), assume today if the time hasn't passed, otherwise tomorrow
- If no time given, use 09:00
- If no date/time found at all, use tomorrow at 09:00
- Extract what needs to be done (remove "recuérdame", "remind me", "tarea:", etc.)

Respond with JSON only, no explanation:
{"text": "<clean task description>", "due": "<YYYY-MM-DDTHH:MM>"}`,
    }],
  });

  const raw = response.content[0]?.text?.trim() || '';
  try {
    const parsed = JSON.parse(raw.match(/\{.*\}/s)?.[0] || raw);
    if (!parsed.text || !parsed.due) return null;
    const due = new Date(parsed.due);
    if (isNaN(due.getTime())) return null;
    return { text: parsed.text.trim(), due };
  } catch {
    return null;
  }
}

// ── saveTask ──────────────────────────────────────────────────────────────────

/**
 * Save a task to raw/tasks/.
 *
 * @param {string} root
 * @param {string} text  - task description
 * @param {Date}   due   - when to remind
 * @returns {{ path: string }}
 */
export function saveTask(root, text, due) {
  const tasksDir = join(root, 'raw', 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  const dateStr = due.toISOString().slice(0, 10);
  const slug = text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50);

  const filename = `${dateStr}-${slug}.md`;
  const filePath = join(tasksDir, filename);

  // If file already exists, add a suffix to avoid collision
  const finalPath = existsSync(filePath)
    ? filePath.replace('.md', `-${Date.now()}.md`)
    : filePath;

  const dueISO = due.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const content = `---
text: "${text.replace(/"/g, '\\"')}"
due: ${dueISO}
done: false
created: ${new Date().toISOString()}
---

${text}
`;

  writeFileSync(finalPath, content, 'utf8');
  return { path: finalPath.replace(root + '/', '') };
}

// ── readTasks ─────────────────────────────────────────────────────────────────

/**
 * Read all task files from raw/tasks/.
 * Returns tasks sorted by due date (ascending).
 *
 * @param {string} root
 * @returns {{ path: string, text: string, due: Date, done: boolean, created: string }[]}
 */
export function readTasks(root) {
  const tasksDir = join(root, 'raw', 'tasks');
  if (!existsSync(tasksDir)) return [];

  const files = readdirSync(tasksDir).filter(f => f.endsWith('.md'));
  const tasks = [];

  for (const file of files) {
    const filePath = join(tasksDir, file);
    try {
      const content = readFileSync(filePath, 'utf8');
      const text    = content.match(/^text:\s*"?(.+?)"?\s*$/m)?.[1]?.trim() || file.replace('.md', '');
      const dueStr  = content.match(/^due:\s*(.+)$/m)?.[1]?.trim();
      const doneStr = content.match(/^done:\s*(.+)$/m)?.[1]?.trim();
      if (!dueStr) continue;
      // "YYYY-MM-DDTHH:MM" without seconds/timezone is ambiguous — force local time
      const dueNorm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dueStr) ? dueStr + ':00' : dueStr;
      const due  = new Date(dueNorm);
      if (isNaN(due.getTime())) continue;
      tasks.push({
        path: `raw/tasks/${file}`,
        text: text.replace(/^"|"$/g, ''),
        due,
        done: doneStr === 'true',
        created: content.match(/^created:\s*(.+)$/m)?.[1]?.trim() || null,
      });
    } catch { /* skip malformed files */ }
  }

  return tasks.sort((a, b) => a.due - b.due);
}

// ── markDone ──────────────────────────────────────────────────────────────────

/**
 * Mark a task as done by updating its frontmatter.
 *
 * @param {string} root
 * @param {string} taskPath - relative path like "raw/tasks/2026-04-15-foo.md"
 */
export function markDone(root, taskPath) {
  const filePath = join(root, taskPath);
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  const updated = content.replace(/^done:\s*.+$/m, 'done: true');
  writeFileSync(filePath, updated, 'utf8');
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Detect if a message is a task/reminder request.
 * Returns the cleaned message (without the trigger prefix) or null.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function looksLikeTask(text) {
  const t = text.trim();
  const patterns = [
    /^rec[uú]erdame\s+/i,
    /^remind\s+me\s+/i,
    /^tarea:\s*/i,
    /^task:\s*/i,
    /^a[ñn]ade\s+(a\s+)?tarea[s]?[:\s]+/i,
    /^add\s+task[:\s]+/i,
    /^nota\s+para\s+/i,
    /^apunta\s+que\s+/i,
  ];
  for (const p of patterns) {
    if (p.test(t)) return t; // return full text — Claude will clean the prefix
  }
  return null;
}

/**
 * Format a due date for display in Telegram.
 * @param {Date} due
 * @returns {string}
 */
export function formatDue(due) {
  const now = new Date();
  const diffMs = due - now;
  const diffH  = diffMs / 3_600_000;
  const diffD  = diffMs / 86_400_000;

  const timeStr = due.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });

  if (diffH < 1)   return `en ${Math.max(1, Math.round(diffMs / 60_000))} min`;
  if (diffH < 24)  return `hoy a las ${timeStr}`;
  if (diffD < 2)   return `mañana a las ${timeStr}`;
  if (diffD < 7)   {
    const days = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    return `el ${days[due.getDay()]} a las ${timeStr}`;
  }
  return due.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
