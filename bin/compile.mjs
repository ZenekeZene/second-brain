#!/usr/bin/env node
/**
 * second-brain compile
 * Lanza Claude CLI con el prompt de compilación.
 *
 * Uso:
 *   node bin/compile.mjs             → compila todos los pendientes
 *   node bin/compile.mjs --dry-run   → muestra qué se compilaría sin hacerlo
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');
const PROMPT_PATH = join(ROOT, 'prompts', 'compile.md');

const [,, flag] = process.argv;
const dryRun = flag === '--dry-run';

function readPending() {
  try {
    return JSON.parse(readFileSync(PENDING_PATH, 'utf8'));
  } catch {
    return { pending: [], lastCompile: null };
  }
}

const state = readPending();

if (state.pending.length === 0) {
  console.log('✓ No hay items pendientes de compilación.');
  process.exit(0);
}

console.log(`\n🧠 Second Brain — Compilación`);
console.log(`   Items pendientes: ${state.pending.length}\n`);
state.pending.forEach(item => {
  console.log(`   - [${item.type}] ${item.path}`);
});
console.log('');

if (dryRun) {
  console.log('(dry-run: no se ejecuta la compilación)');
  process.exit(0);
}

if (!existsSync(PROMPT_PATH)) {
  console.error(`Error: no se encuentra el prompt en ${PROMPT_PATH}`);
  process.exit(1);
}

const prompt = readFileSync(PROMPT_PATH, 'utf8');

console.log('Lanzando Claude para compilar...\n');

try {
  execSync(`claude -p "${prompt.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
    cwd: ROOT,
    stdio: 'inherit'
  });
} catch (err) {
  // claude -p puede devolver exit code != 0 en algunos casos, no es siempre error
  if (err.status && err.status !== 0) {
    console.error(`\nError en la compilación: ${err.message}`);
    process.exit(1);
  }
}
