/**
 * CLI smoke tests — verifies every script handles --help cleanly.
 * No external APIs required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin');

const scripts = [
  'ingest.mjs',
  'status.mjs',
  'search.mjs',
  'compile.mjs',
  'route.mjs',
  'sync-x.mjs',
];

for (const script of scripts) {
  test(`${script} --help exits 0 and prints Usage`, () => {
    const r = spawnSync('node', [join(BIN, script), '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${script} --help should exit 0 (stderr: ${r.stderr})`);
    assert.ok(
      r.stdout.toLowerCase().includes('usage'),
      `${script} --help should print Usage`
    );
  });

  test(`${script} -h is an alias for --help`, () => {
    const r = spawnSync('node', [join(BIN, script), '-h'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${script} -h should exit 0`);
  });
}

test('ingest.mjs with no args exits 0 and prints Usage', () => {
  const r = spawnSync('node', [join(BIN, 'ingest.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.toLowerCase().includes('usage'));
});

test('search.mjs --recent on empty wiki exits 0', () => {
  const r = spawnSync('node', [join(BIN, 'search.mjs'), '--recent', '5'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('compile.mjs --dry-run with no pending exits 0', () => {
  const r = spawnSync('node', [join(BIN, 'compile.mjs'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
});
