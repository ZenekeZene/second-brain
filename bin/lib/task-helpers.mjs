/**
 * task-helpers — Task and reminder storage, daily carryover, and date parsing.
 *
 * Tasks live in .state/todos/YYYY-MM-DD.json (daily JSON files).
 * Each task: { id, text, done, carriedOver, createdAt, postponed, postponeCount, due, completedAt }
 *
 * Exported functions:
 *   getTodayWithCarryover(root)              → { date, context, tasks[] }
 *   saveTodayData(root, { context?, tasks? })
 *   postponeTask(root, taskId, targetDate)
 *   getUpcoming(root)                        → [{ date, tasks[] }]
 *   pullToToday(root, taskId, sourceDate)
 *   readAllTasks(root)                       → Task[]  (sorted by due, for reminder-check + bot)
 *   markTaskDone(root, taskId)
 *   saveTask(root, text, due)                → { id, date }  (for telegram bot + CLI)
 *   parseTaskMessage(message, apiKey)        → [{ text, due }] | null
 *   looksLikeTask(text)                      → string | null
 *   formatDue(due)                           → string
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

// ── Internal helpers ──────────────────────────────────────────────────────────

function todosDir(root) {
  const dir = join(root, '.state', 'todos');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function toDateStr(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toLocalISO(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function todayStr() {
  return toDateStr(new Date());
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function readDayFile(root, dateStr) {
  const dir = todosDir(root);
  const fp = join(dir, `${dateStr}.json`);
  if (!existsSync(fp)) return { date: dateStr, context: '', tasks: [] };
  try { return JSON.parse(readFileSync(fp, 'utf8')); } catch { return { date: dateStr, context: '', tasks: [] }; }
}

function writeDayFile(root, dateStr, data) {
  const dir = todosDir(root);
  writeFileSync(join(dir, `${dateStr}.json`), JSON.stringify(data, null, 2), 'utf8');
}

function listDayFiles(root) {
  const dir = todosDir(root);
  return readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort();
}

// Normalise a due string to a Date object (handles "YYYY-MM-DDTHH:MM" without seconds)
function parseDue(dueStr) {
  if (!dueStr) return null;
  const norm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dueStr) ? dueStr + ':00' : dueStr;
  const d = new Date(norm);
  return isNaN(d.getTime()) ? null : d;
}

// ── Carryover ─────────────────────────────────────────────────────────────────

/**
 * Return today's tasks with automatic carryover from all previous days.
 */
export function getTodayWithCarryover(root) {
  const today = todayStr();
  const todayData = readDayFile(root, today);
  const previousDates = listDayFiles(root).filter(d => d < today);

  // Build consolidated task map from all previous files (later file wins per id)
  const taskMap = new Map();
  for (const date of previousDates) {
    const { tasks } = readDayFile(root, date);
    for (const t of tasks) taskMap.set(t.id, t);
  }

  const todayIds = new Set(todayData.tasks.map(t => t.id));
  let changed = false;

  // Carry over undone, non-postponed tasks not already in today
  for (const [id, t] of taskMap) {
    if (t.done || t.postponed) continue;
    if (todayIds.has(id)) continue;
    todayData.tasks.unshift({ ...t, carriedOver: true });
    todayIds.add(id);
    changed = true;
  }

  // Prune stale: carried task that is now done in its source file
  const before = todayData.tasks.length;
  todayData.tasks = todayData.tasks.filter(t => {
    if (!t.carriedOver || !t.done) return true; // keep non-carried or incomplete
    const source = taskMap.get(t.id);
    return !(source && source.done); // remove if source is done
  });
  if (todayData.tasks.length !== before) changed = true;

  if (changed) writeDayFile(root, today, todayData);
  return todayData;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Save today's file (context and/or tasks array).
 * Called by PUT /api/today (debounced from UI).
 */
export function saveTodayData(root, { context, tasks } = {}) {
  const today = todayStr();
  const data = readDayFile(root, today);
  if (context !== undefined) data.context = context;
  if (tasks   !== undefined) data.tasks   = tasks;
  writeDayFile(root, today, data);
  return data;
}

/**
 * Postpone a task to a future date.
 * Marks it postponed in all files that contain it, inserts into target day.
 */
export function postponeTask(root, taskId, targetDate) {
  const today = todayStr();
  if (targetDate <= today) throw new Error('Target date must be in the future');

  let task = null;

  // Mark postponed in all existing day files
  for (const date of listDayFiles(root)) {
    const data = readDayFile(root, date);
    let found = false;
    data.tasks = data.tasks.map(t => {
      if (t.id !== taskId) return t;
      task = { ...t };
      found = true;
      return { ...t, postponed: true };
    });
    if (found) writeDayFile(root, date, data);
  }

  if (!task) return;

  // Insert into target day
  const targetData = readDayFile(root, targetDate);
  const alreadyThere = targetData.tasks.some(t => t.id === taskId);
  if (!alreadyThere) {
    targetData.tasks.push({
      ...task,
      carriedOver: true,
      done: false,
      postponed: false,
      postponeCount: (task.postponeCount || 0) + 1,
      // Update due to target date but preserve original time
      due: task.due ? task.due.replace(/^\d{4}-\d{2}-\d{2}/, targetDate) : `${targetDate}T09:00`,
    });
    writeDayFile(root, targetDate, targetData);
  }
}

/**
 * Get upcoming days (next 7) with pending tasks.
 */
export function getUpcoming(root) {
  const result = [];
  const now = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const dateStr = toDateStr(d);
    const { tasks } = readDayFile(root, dateStr);
    const pending = tasks.filter(t => !t.done);
    if (pending.length) result.push({ date: dateStr, tasks: pending });
  }
  return result;
}

/**
 * Pull a task from a future day into today.
 */
export function pullToToday(root, taskId, sourceDate) {
  const today = todayStr();
  const srcData = readDayFile(root, sourceDate);
  const idx = srcData.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;

  const [task] = srcData.tasks.splice(idx, 1);
  writeDayFile(root, sourceDate, srcData);

  const todayData = readDayFile(root, today);
  if (!todayData.tasks.some(t => t.id === taskId)) {
    todayData.tasks.push({ ...task, carriedOver: false, done: false, postponed: false });
    writeDayFile(root, today, todayData);
  }
}

// ── Read all / mark done (for reminder-check + telegram bot) ──────────────────

/**
 * Read ALL tasks across all day files, sorted by due date.
 * Returns tasks with a `date` field (the day file they belong to).
 */
export function readAllTasks(root) {
  const tasks = [];
  for (const date of listDayFiles(root)) {
    const { tasks: dayTasks } = readDayFile(root, date);
    for (const t of dayTasks) {
      const due = parseDue(t.due);
      if (!due) continue;
      tasks.push({ ...t, due, _fileDate: date });
    }
  }
  return tasks.sort((a, b) => a.due - b.due);
}

/**
 * Mark a task as done by ID, searching across all day files.
 */
export function markTaskDone(root, taskId) {
  const today = new Date().toISOString().split('T')[0];
  for (const date of listDayFiles(root)) {
    const data = readDayFile(root, date);
    let found = false;
    data.tasks = data.tasks.map(t => {
      if (t.id !== taskId) return t;
      found = true;
      return { ...t, done: true, completedAt: today };
    });
    if (found) { writeDayFile(root, date, data); return; }
  }
}

/**
 * Remove a task by ID, searching across all day files.
 */
export function removeTaskById(root, taskId) {
  for (const date of listDayFiles(root)) {
    const data = readDayFile(root, date);
    const before = data.tasks.length;
    data.tasks = data.tasks.filter(t => t.id !== taskId);
    if (data.tasks.length !== before) { writeDayFile(root, date, data); return true; }
  }
  return false;
}

/**
 * Save a new task to the appropriate day file (keyed by due date).
 * Used by Telegram bot, web frontend, and CLAUDE.md CLI instructions.
 *
 * @param {string} root
 * @param {string} text
 * @param {Date}   due
 * @returns {{ id: string, date: string }}
 */
export function saveTask(root, text, due) {
  const dateStr = toDateStr(due);
  const data = readDayFile(root, dateStr);
  const id = generateId();
  data.tasks.push({
    id,
    text,
    done: false,
    carriedOver: false,
    createdAt: new Date().toISOString(),
    postponed: false,
    postponeCount: 0,
    due: toLocalISO(due),
    completedAt: null,
  });
  writeDayFile(root, dateStr, data);
  return { id, date: dateStr };
}

// ── parseTaskMessage ──────────────────────────────────────────────────────────

export async function parseTaskMessage(message, apiKey) {
  const now = new Date();
  const nowStr = toLocalISO(now);

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Decide if this message contains tasks, reminders, or to-do items the user wants saved.
The message may contain one or multiple tasks.

A task/reminder: the user wants to be reminded of something, has a future action item, or is explicitly creating a to-do.
NOT a task: a note about a topic, a question, a URL to save, a random observation or thought.

Current date/time: ${nowStr}
Message: "${message}"

Date parsing rules:
- "mañana" = tomorrow, "pasado mañana" = day after tomorrow
- "en X horas/minutos" = relative from now
- Time only (e.g. "a las 10"): today if not yet passed, otherwise tomorrow
- No time given: 09:00
- No date at all: tomorrow at 09:00
- If multiple tasks share the same date/time, apply it to all of them
- Strip prefixes from task text ("recuérdame", "remind me", "añade tarea:", "tarea:", etc.)

If tasks found:    {"tasks": [{"text": "<clean description>", "due": "<YYYY-MM-DDTHH:MM>"}, ...]}
If NOT tasks:      {"tasks": []}

Respond with JSON only, no explanation.`,
    }],
  });

  const raw = response.content[0]?.text?.trim() || '';
  try {
    const parsed = JSON.parse(raw.match(/\{.*\}/s)?.[0] || raw);
    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) return null;
    const tasks = parsed.tasks
      .map(t => {
        if (!t.text || !t.due) return null;
        const due = parseDue(t.due) || new Date(t.due);
        return isNaN(due.getTime()) ? null : { text: t.text.trim(), due };
      })
      .filter(Boolean);
    return tasks.length > 0 ? tasks : null;
  } catch {
    return null;
  }
}

// ── looksLikeTask ─────────────────────────────────────────────────────────────

export function looksLikeTask(text) {
  const t = text.trim();
  const n = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const patterns = [
    /^recuerdame\s+/,
    /^remind\s+me\s+/,
    /^tarea:\s*/,
    /^task:\s*/,
    /^recordatorio:\s*/,
    /^reminder:\s*/,
    /^anade\s+(a\s+)?tareas?[:\s]+/,
    /^anade\s+(este\s+|un\s+|el\s+)?recordatorio[:\s]+/,
    /^add\s+task[:\s]+/,
    /^add\s+(this\s+|a\s+)?reminder[:\s]+/,
    /^nota\s+para\s+/,
    /^apunta\s+que\s+/,
    /^pon\s+(un\s+|este\s+)?recordatorio[:\s]+/,
  ];
  for (const p of patterns) {
    if (p.test(n)) return t;
  }
  return null;
}

// ── formatDue ─────────────────────────────────────────────────────────────────

export function formatDue(due) {
  const now = new Date();
  const diffMs = due - now;
  const diffH  = diffMs / 3_600_000;
  const diffD  = diffMs / 86_400_000;

  const timeStr = due.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });

  if (diffH < 1)  return `en ${Math.max(1, Math.round(diffMs / 60_000))} min`;
  if (diffH < 24) return `hoy a las ${timeStr}`;
  if (diffD < 2)  return `mañana a las ${timeStr}`;
  if (diffD < 7) {
    const days = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    return `el ${days[due.getDay()]} a las ${timeStr}`;
  }
  return due.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
