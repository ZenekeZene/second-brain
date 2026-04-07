/**
 * Shared append-only logger for all second-brain scripts.
 * Writes JSONL to .state/brain.log — readable from the Telegram /logs command.
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG_PATH = join(ROOT, '.state', 'brain.log');

export function log(level, msg, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  const line = JSON.stringify(entry) + '\n';
  try { writeFileSync(LOG_PATH, line, { flag: 'a' }); } catch {}
  if (level === 'error') console.error(line.trim());
  else console.log(line.trim());
}

export const LOG_PATH_EXPORT = LOG_PATH;
