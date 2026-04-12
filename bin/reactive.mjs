#!/usr/bin/env node
/**
 * second-brain reactive compilation check.
 * Triggers compile automatically when:
 *   - N items are pending (default: 5), OR
 *   - items are pending AND X hours have passed since last compile (default: 48h)
 *
 * Usage:
 *   node bin/reactive.mjs          Check and compile if triggered
 *   node bin/reactive.mjs --check  Check only — print status without compiling
 *
 * Thresholds (env vars):
 *   REACTIVE_THRESHOLD_ITEMS=5
 *   REACTIVE_THRESHOLD_HOURS=48
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { shouldCompile, triggerMessage } from './lib/reactive.mjs';
import { readConfig } from './lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env so REACTIVE_THRESHOLD_* vars are honoured when called directly
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) {
      process.env[key.trim()] ??= rest.join('=').trim();
    }
  }
}
const PENDING_PATH = join(ROOT, '.state', 'pending.json');

const checkOnly = process.argv[2] === '--check';

let state;
try {
  state = JSON.parse(readFileSync(PENDING_PATH, 'utf8'));
} catch {
  state = { pending: [], lastCompile: null };
}

const cfg = readConfig(ROOT);
const trigger = shouldCompile(state, cfg);

if (!trigger) {
  if (checkOnly) {
    if (cfg.reactive_enabled === false) {
      console.log(`Reactive: ${state.pending.length} pending — disabled (Settings → Reactive Compilation)`);
    } else {
      const tItems = cfg.reactive_threshold_items ?? parseInt(process.env.REACTIVE_THRESHOLD_ITEMS || '5', 10);
      const tHours = parseInt(process.env.REACTIVE_THRESHOLD_HOURS || '48', 10);
      console.log(`Reactive: ${state.pending.length} pending — no trigger (threshold: ${tItems} items or ${tHours}h)`);
    }
  }
  process.exit(0);
}

console.log(`\nReactive compilation triggered: ${triggerMessage(trigger)}`);

if (checkOnly) {
  console.log('(--check mode: compile not executed)');
  process.exit(0);
}

execFileSync(process.execPath, [join(ROOT, 'bin', 'compile.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});
