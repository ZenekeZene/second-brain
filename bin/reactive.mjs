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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');

const checkOnly = process.argv[2] === '--check';

let state;
try {
  state = JSON.parse(readFileSync(PENDING_PATH, 'utf8'));
} catch {
  state = { pending: [], lastCompile: null };
}

const trigger = shouldCompile(state);

if (!trigger) {
  if (checkOnly) {
    console.log(`Reactive: ${state.pending.length} pending — no trigger (threshold: ${process.env.REACTIVE_THRESHOLD_ITEMS || '5'} items or ${process.env.REACTIVE_THRESHOLD_HOURS || '48'}h)`);
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
