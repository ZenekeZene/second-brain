#!/usr/bin/env node
/**
 * second-brain sync-x
 * Sincroniza bookmarks de X/Twitter usando el CLI de Field Theory.
 *
 * Uso:
 *   node bin/sync-x.mjs              → sync incremental (solo nuevos)
 *   node bin/sync-x.mjs --full       → sync completo (toda la historia)
 *   node bin/sync-x.mjs --classify   → sync + clasificar con LLM
 *   node bin/sync-x.mjs --dry-run    → muestra qué haría sin escribir nada
 *
 * Prerequisito: npm install -g fieldtheory + Chrome con sesión de X abierta.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');
const X_STATE_PATH = join(ROOT, '.state', 'x-sync.json');
const X_RAW_DIR = join(ROOT, 'raw', 'x-bookmarks');

// ── helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function checkFtInstalled() {
  const result = spawnSync('ft', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    console.error('Error: fieldtheory CLI no encontrado.');
    console.error('Instálalo con: npm install -g fieldtheory');
    process.exit(1);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fullSync = args.includes('--full');
const classify = args.includes('--classify');
const dryRun = args.includes('--dry-run');

checkFtInstalled();

// 1. Leer estado del último sync
const xState = readJSON(X_STATE_PATH, { lastSync: null, processedIds: [] });
const processedIds = new Set(xState.processedIds || []);

// 2. Ejecutar ft sync
if (!dryRun) {
  console.log('Sincronizando bookmarks de X...');
  const syncArgs = ['sync', '--chrome-profile-directory', 'Profile 1'];
  if (fullSync) syncArgs.push('--full');
  if (classify) syncArgs.push('--classify');

  const syncResult = spawnSync('ft', syncArgs, { encoding: 'utf8', stdio: 'inherit' });
  if (syncResult.status !== 0) {
    console.error('Error durante ft sync. ¿Tienes Chrome abierto con X?');
    process.exit(1);
  }
} else {
  console.log('(dry-run: saltando ft sync)');
}

// 3. Obtener bookmarks nuevos via ft list --json
console.log('\nObteniendo lista de bookmarks...');

let listArgs = ['list', '--json', '--limit', '1000'];

// Si hay un lastSync, filtrar solo los más recientes
// ft list --after filtra por fecha de creación del tweet, no de bookmark
// Usamos el campo afterDate si disponemos de él
if (xState.lastSync && !fullSync) {
  // Tomar los del último mes como margen de seguridad
  const safeDate = new Date(xState.lastSync);
  safeDate.setDate(safeDate.getDate() - 1);
  listArgs.push('--after', safeDate.toISOString().slice(0, 10));
}

const listResult = spawnSync('ft', listArgs, { encoding: 'utf8' });
if (listResult.status !== 0 || !listResult.stdout) {
  console.log('No hay bookmarks disponibles o error al listar. ¿Has ejecutado ft sync primero?');
  process.exit(0);
}

let bookmarks = [];
try {
  const raw = listResult.stdout;
  // ft list --json mezcla ANSI/spinners con el JSON — limpiar antes de parsear
  const clean = raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')  // secuencias ANSI (colores, cursores)
    .replace(/\r/g, '')                         // carriage returns
    .replace(/[^\x20-\x7E\n\t{}[\]",:0-9.\-_]/g, ''); // eliminar chars no-ASCII (spinners, etc.)
  // Extraer el bloque JSON: desde el primer '[' hasta el último ']'
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No se encontró array JSON en el output');
  bookmarks = JSON.parse(clean.slice(start, end + 1));
} catch (err) {
  console.error('Error parseando output de ft list --json:', err.message);
  process.exit(1);
}

// 4. Filtrar solo los nuevos (no procesados aún)
const newBookmarks = bookmarks.filter(b => {
  const id = b.id || b.tweet_id || b.tweetId;
  return id && !processedIds.has(String(id));
});

if (newBookmarks.length === 0) {
  console.log(`✓ Sin bookmarks nuevos. Total disponibles: ${bookmarks.length}`);
  process.exit(0);
}

console.log(`  Nuevos: ${newBookmarks.length} de ${bookmarks.length} total`);

if (dryRun) {
  console.log('\n(dry-run) Bookmarks que se procesarían:');
  newBookmarks.slice(0, 10).forEach(b => {
    const author = b.authorHandle || b.author_handle || b.author || 'unknown';
    const text = (b.full_text || b.text || '').slice(0, 80);
    console.log(`  @${author}: ${text}...`);
  });
  if (newBookmarks.length > 10) console.log(`  ... y ${newBookmarks.length - 10} más`);
  process.exit(0);
}

// 5. Escribir en raw/x-bookmarks/
mkdirSync(X_RAW_DIR, { recursive: true });
const filename = `${today()}-x-bookmarks.jsonl`;
const filepath = join(X_RAW_DIR, filename);

// Si ya existe el fichero del día, añadir al final
const lines = newBookmarks.map(b => JSON.stringify(b)).join('\n') + '\n';
if (existsSync(filepath)) {
  const current = readFileSync(filepath, 'utf8');
  writeFileSync(filepath, current + lines);
} else {
  writeFileSync(filepath, lines);
}

// 6. Añadir a pending.json
const pending = readJSON(PENDING_PATH, { pending: [], lastCompile: null });
const alreadyPending = pending.pending.some(
  item => item.path === `raw/x-bookmarks/${filename}` && item.type === 'x-bookmarks'
);
if (!alreadyPending) {
  pending.pending.push({
    path: `raw/x-bookmarks/${filename}`,
    type: 'x-bookmarks',
    count: newBookmarks.length,
    ingested: nowISO()
  });
  writeJSON(PENDING_PATH, pending);
}

// 7. Actualizar estado del sync
const newIds = newBookmarks.map(b => String(b.id || b.tweetId || b.tweet_id)).filter(Boolean);
writeJSON(X_STATE_PATH, {
  lastSync: nowISO(),
  processedIds: [...processedIds, ...newIds].slice(-10000) // mantener los últimos 10k
});

console.log(`\n✓ ${newBookmarks.length} bookmarks guardados en raw/x-bookmarks/${filename}`);
console.log(`  ${pending.pending.length} item(s) pendientes de compilación.`);
console.log('\n  Para compilarlos: npm run compile  o di "compila el brain" en Claude Code');
