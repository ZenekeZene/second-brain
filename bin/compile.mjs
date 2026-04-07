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

// Paso previo: routing incremental (genera .state/routing.json)
const ROUTING_PATH = join(ROOT, '.state', 'routing.json');
const ROUTE_SCRIPT = join(ROOT, 'bin', 'route.mjs');

console.log('Paso 1/2: Calculando routing incremental...\n');
try {
  execSync(`node "${ROUTE_SCRIPT}" --skip-llm`, { cwd: ROOT, stdio: 'inherit' });
} catch {
  console.warn('⚠ Routing falló, compilando sin contexto incremental.\n');
}

// Leer routing para añadirlo al prompt de compilación
let routingContext = '';
if (existsSync(ROUTING_PATH)) {
  try {
    const routing = JSON.parse(readFileSync(ROUTING_PATH, 'utf8'));
    routingContext = `\n\n## Routing incremental (usa esto para compilar solo los artículos afectados)\n\n` +
      routing.routes.map(r =>
        `- ${r.path} → acción: ${r.routing.action}, artículos: [${(r.routing.articles || []).join(', ')}]`
      ).join('\n');
  } catch { /* si falla, compilar sin routing */ }
}

if (!existsSync(PROMPT_PATH)) {
  console.error(`Error: no se encuentra el prompt en ${PROMPT_PATH}`);
  process.exit(1);
}

const prompt = readFileSync(PROMPT_PATH, 'utf8') + routingContext;

console.log('\nPaso 2/2: Lanzando Claude para compilar...\n');

try {
  execSync(`claude -p "${prompt.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
    cwd: ROOT,
    stdio: 'inherit'
  });
} catch (err) {
  if (err.status && err.status !== 0) {
    console.error(`\nError en la compilación: ${err.message}`);
    process.exit(1);
  }
}
