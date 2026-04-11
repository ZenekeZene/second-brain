#!/usr/bin/env node
/**
 * Migrate raw/tasks/*.md → .state/todos/*.json (one-time)
 *
 * Usage: node bin/migrate-tasks.mjs
 *
 * Groups existing markdown task files by due date and writes them into
 * the new daily JSON format. Idempotent — safe to re-run.
 * Never deletes raw/tasks/ files (project rule: raw/ is read-only).
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function toDateStr(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toLocalISO(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function parseDue(dueStr) {
  const norm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dueStr) ? dueStr + ':00' : dueStr;
  const d = new Date(norm);
  return isNaN(d.getTime()) ? null : d;
}

// Read existing markdown tasks
const tasksDir = join(ROOT, 'raw', 'tasks');
if (!existsSync(tasksDir)) {
  console.log('No raw/tasks/ directory found — nothing to migrate.');
  process.exit(0);
}

const files = readdirSync(tasksDir).filter(f => f.endsWith('.md'));
if (!files.length) {
  console.log('No task files found in raw/tasks/ — nothing to migrate.');
  process.exit(0);
}

// Parse markdown tasks
const parsed = [];
for (const file of files) {
  try {
    const content = readFileSync(join(tasksDir, file), 'utf8');
    const text    = content.match(/^text:\s*"?(.+?)"?\s*$/m)?.[1]?.trim()?.replace(/^"|"$/g, '');
    const dueStr  = content.match(/^due:\s*(.+)$/m)?.[1]?.trim();
    const doneStr = content.match(/^done:\s*(.+)$/m)?.[1]?.trim();
    const created = content.match(/^created:\s*(.+)$/m)?.[1]?.trim() || null;
    const completedAt = content.match(/^completedAt:\s*(.+)$/m)?.[1]?.trim() || null;
    if (!text || !dueStr) continue;
    const due = parseDue(dueStr);
    if (!due) continue;
    parsed.push({ text, due, done: doneStr === 'true', created, completedAt, sourceFile: file });
  } catch { /* skip malformed */ }
}

console.log(`Found ${parsed.length} task(s) in raw/tasks/`);

// Group by due date
const byDate = {};
for (const t of parsed) {
  const dateStr = toDateStr(t.due);
  if (!byDate[dateStr]) byDate[dateStr] = [];
  byDate[dateStr].push(t);
}

// Write to .state/todos/
const todosDir = join(ROOT, '.state', 'todos');
mkdirSync(todosDir, { recursive: true });

let migrated = 0;
let skipped = 0;

for (const [dateStr, tasks] of Object.entries(byDate)) {
  const fp = join(todosDir, `${dateStr}.json`);

  // Read existing if present
  let existing = { date: dateStr, context: '', tasks: [] };
  if (existsSync(fp)) {
    try { existing = JSON.parse(readFileSync(fp, 'utf8')); } catch {}
  }
  const existingTexts = new Set(existing.tasks.map(t => t.text));

  let added = 0;
  for (const t of tasks) {
    if (existingTexts.has(t.text)) { skipped++; continue; } // idempotent
    existing.tasks.push({
      id: generateId(),
      text: t.text,
      done: t.done,
      carriedOver: false,
      createdAt: t.created || new Date().toISOString(),
      postponed: false,
      postponeCount: 0,
      due: toLocalISO(t.due),
      completedAt: t.completedAt || null,
    });
    added++;
    migrated++;
  }

  writeFileSync(fp, JSON.stringify(existing, null, 2), 'utf8');
  if (added) console.log(`  ${dateStr}.json — added ${added} task(s)`);
}

console.log(`\nMigrated ${migrated} task(s) across ${Object.keys(byDate).length} day file(s). Skipped ${skipped} duplicates.`);
console.log('raw/tasks/ files preserved (never deleted).');
