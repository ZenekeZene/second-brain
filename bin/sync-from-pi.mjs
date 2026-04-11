#!/usr/bin/env node
/**
 * sync-from-pi — pulls raw/ and .state/ from the Raspberry Pi to this machine.
 *
 * Usage:
 *   node bin/sync-from-pi.mjs
 *
 * Config (env vars in .env):
 *   PI_HOST=192.168.1.163
 *   PI_USER=zeneke
 *   PI_PATH=/home/zeneke/second-brain
 */

import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env without dotenv dependency
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}

const host = process.env.PI_HOST;
const user = process.env.PI_USER;
const path = process.env.PI_PATH || `/home/${user}/second-brain`;

if (!host || !user) {
  console.error('sync-from-pi: PI_HOST and PI_USER must be set in .env');
  process.exit(1);
}

const src = `${user}@${host}:${path}`;

const targets = [
  { src: `${src}/raw/`,      dst: join(ROOT, 'raw') + '/'    },
  { src: `${src}/.state/`,   dst: join(ROOT, '.state') + '/' },
  { src: `${src}/wiki/`,     dst: join(ROOT, 'wiki') + '/'   },
  { src: `${src}/INDEX.md`,  dst: join(ROOT, 'INDEX.md')     },
];

console.log(`\nSync from Pi ← ${host}`);

for (const { src, dst } of targets) {
  console.log(`  rsync ${src}`);
  try {
    execFileSync('rsync', ['-az', '--update', src, dst], {
      stdio: 'inherit',
    });
  } catch (err) {
    console.error(`  Error syncing ${src}: ${err.message}`);
    process.exit(1);
  }
}

console.log('  Done.\n');
