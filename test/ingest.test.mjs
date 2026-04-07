/**
 * Integration smoke tests for ingest.mjs and status.mjs.
 * Writes real files to raw/ and .state/ (both gitignored), cleans up after.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BIN = join(ROOT, 'bin');
const PENDING_PATH = join(ROOT, '.state', 'pending.json');

// Files created during tests — cleaned up in after()
const createdFiles = [];
let pendingSnapshot = null;

before(() => {
  // Snapshot pending.json so we can restore it after tests
  mkdirSync(join(ROOT, '.state'), { recursive: true });
  try {
    pendingSnapshot = readFileSync(PENDING_PATH, 'utf8');
  } catch {
    pendingSnapshot = null; // file didn't exist before
  }
});

after(() => {
  // Remove files created during tests
  for (const f of createdFiles) {
    try { unlinkSync(f); } catch {}
  }

  // Restore pending.json to its pre-test state
  if (pendingSnapshot !== null) {
    writeFileSync(PENDING_PATH, pendingSnapshot);
  } else {
    try { unlinkSync(PENDING_PATH); } catch {}
  }
});

// ── ingest note ───────────────────────────────────────────────────────────────

test('ingest note: exits 0 and prints success', () => {
  const r = spawnSync(
    'node', [join(BIN, 'ingest.mjs'), 'note', 'typescript react frontend smoke test'],
    { encoding: 'utf8', cwd: ROOT }
  );
  assert.equal(r.status, 0, `should exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.includes('✓'), 'should print a success checkmark');
  assert.ok(r.stdout.includes('raw/notes/'), 'should mention the created file path');
  assert.ok(r.stdout.includes('pending compilation'), 'should mention pending count');
});

test('ingest note: creates a markdown file in raw/notes/', () => {
  const notesDir = join(ROOT, 'raw', 'notes');
  const before = existsSync(notesDir) ? readdirSync(notesDir) : [];

  spawnSync(
    'node', [join(BIN, 'ingest.mjs'), 'note', 'docker kubernetes devops automation'],
    { encoding: 'utf8', cwd: ROOT }
  );

  const after = readdirSync(notesDir);
  const newFiles = after.filter(f => !before.includes(f));
  assert.equal(newFiles.length, 1, 'should create exactly one new file');

  const filePath = join(notesDir, newFiles[0]);
  createdFiles.push(filePath);

  const content = readFileSync(filePath, 'utf8');
  assert.ok(content.includes('type: note'), 'frontmatter should have type: note');
  assert.ok(content.includes('status: pending'), 'frontmatter should have status: pending');
  assert.ok(content.includes('ingested:'), 'frontmatter should have ingested timestamp');
  assert.ok(content.includes('docker kubernetes devops automation'), 'body should contain the note text');
});

test('ingest note: slug uses kebab-case from text', () => {
  const notesDir = join(ROOT, 'raw', 'notes');
  const before = existsSync(notesDir) ? readdirSync(notesDir) : [];

  spawnSync(
    'node', [join(BIN, 'ingest.mjs'), 'note', 'Hello World Test Slug'],
    { encoding: 'utf8', cwd: ROOT }
  );

  const after = readdirSync(notesDir);
  const newFiles = after.filter(f => !before.includes(f));
  assert.equal(newFiles.length, 1);

  const filename = newFiles[0];
  createdFiles.push(join(notesDir, filename));

  assert.ok(filename.includes('hello-world-test-slug'), `filename should be kebab-case, got: ${filename}`);
  assert.match(filename, /^\d{4}-\d{2}-\d{2}-/, 'filename should start with YYYY-MM-DD-');
});

test('ingest note: adds entry to .state/pending.json', () => {
  spawnSync(
    'node', [join(BIN, 'ingest.mjs'), 'note', 'pending state test note llm agents'],
    { encoding: 'utf8', cwd: ROOT }
  );

  const notesDir = join(ROOT, 'raw', 'notes');
  const today = new Date().toISOString().slice(0, 10);
  const allFiles = readdirSync(notesDir).filter(f => f.startsWith(today));
  const newest = allFiles.sort().at(-1);
  if (newest) createdFiles.push(join(notesDir, newest));

  const state = JSON.parse(readFileSync(PENDING_PATH, 'utf8'));
  assert.ok(Array.isArray(state.pending), 'pending should be an array');
  const noteItems = state.pending.filter(i => i.type === 'note');
  assert.ok(noteItems.length > 0, 'should have at least one note in pending');
});

// ── ingest bookmark ───────────────────────────────────────────────────────────

test('ingest bookmark: exits 0 and prints success', () => {
  const r = spawnSync(
    'node', [join(BIN, 'ingest.mjs'), 'bookmark', 'https://example.com/smoke-test'],
    { encoding: 'utf8', cwd: ROOT }
  );
  assert.equal(r.status, 0, `should exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.includes('✓'), 'should print success');
  assert.ok(r.stdout.includes('raw/bookmarks/'), 'should mention the bookmarks file');
});

test('ingest bookmark: appends URL to daily bookmarks file', () => {
  const url = 'https://example.com/bookmark-smoke-test-unique';
  spawnSync(
    'node', [join(BIN, 'ingest.mjs'), 'bookmark', url],
    { encoding: 'utf8', cwd: ROOT }
  );

  const today = new Date().toISOString().slice(0, 10);
  const bookmarkFile = join(ROOT, 'raw', 'bookmarks', `${today}-bookmarks.md`);

  if (!createdFiles.includes(bookmarkFile)) {
    createdFiles.push(bookmarkFile);
  }

  assert.ok(existsSync(bookmarkFile), 'daily bookmarks file should exist');
  const content = readFileSync(bookmarkFile, 'utf8');
  assert.ok(content.includes(url), 'bookmarks file should contain the URL');
  assert.ok(content.includes('- [ ]'), 'should use unchecked checkbox format');
});

// ── status ────────────────────────────────────────────────────────────────────

test('status: one-liner output has expected format', () => {
  const r = spawnSync('node', [join(BIN, 'status.mjs')], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('Second Brain:'), 'should include header');
  assert.ok(r.stdout.includes('articles'), 'should mention articles');
  assert.ok(r.stdout.includes('compiled'), 'should mention compiled time');
});

test('status --full: includes all sections', () => {
  const r = spawnSync('node', [join(BIN, 'status.mjs'), '--full'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('Wiki articles'), 'should show article count');
  assert.ok(r.stdout.includes('Pending'), 'should show pending count');
  assert.ok(r.stdout.includes('Last compile'), 'should show last compile time');
});
