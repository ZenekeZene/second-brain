#!/usr/bin/env node
/**
 * second-brain reminder checker
 * Finds tasks whose due time has passed and sends a Telegram reminder.
 *
 * Designed to run every 15 minutes via cron:
 *   *\/15 * * * * cd ~/second-brain && node bin/reminder-check.mjs >> .state/reminders.log 2>&1
 *
 * Required in .env:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_ALLOWED_USER_ID
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './lib/logger.mjs';
import { readAllTasks, markTaskDone } from './lib/task-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load .env ─────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}
loadEnv();

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALLOWED_USER_ID;

if (!TOKEN || !CHAT_ID) {
  console.error('Error: TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID must be set in .env');
  process.exit(1);
}

// ── Find overdue tasks ────────────────────────────────────────────────────────

const now   = new Date();
const tasks = readAllTasks(ROOT);
const overdue = tasks.filter(t => !t.done && t.due <= now);

if (overdue.length === 0) {
  // Silent exit — this runs every 15 min, no noise when nothing is due
  process.exit(0);
}

// ── Send reminder for each overdue task ───────────────────────────────────────

for (const task of overdue) {
  const overdueMins = Math.round((now - task.due) / 60_000);
  const overdueStr = overdueMins <= 1 ? 'ahora' : `hace ${overdueMins} min`;

  const message = `⏰ *Recordatorio*\n\n${task.text}\n\n_Programado para: ${task.due.toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (${overdueStr})_`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || 'Telegram API error');

    markTaskDone(ROOT, task.id);
    log('info', 'reminder:sent', { text: task.text.slice(0, 60) });
    console.log(`Reminder sent: "${task.text.slice(0, 60)}"`);
  } catch (err) {
    log('error', 'reminder:failed', { text: task.text.slice(0, 60), error: err.message });
    console.error(`Error sending reminder: ${err.message}`);
  }
}
