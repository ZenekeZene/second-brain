/**
 * config — Read and write .state/config.json
 *
 * Exported functions:
 *   readConfig(root)         → { llm_backend: 'api' | 'claude', ... }
 *   writeConfig(root, patch) → updated config object
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DEFAULTS = {
  llm_backend: 'api',          // 'api' | 'claude'
  reactive_enabled: false,      // trigger compilation automatically
  reactive_threshold_items: 5,  // items pending to trigger (when enabled)
};

export function readConfig(root) {
  const fp = join(root, '.state', 'config.json');
  if (!existsSync(fp)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(fp, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(root, patch) {
  const dir = join(root, '.state');
  mkdirSync(dir, { recursive: true });
  const current = readConfig(root);
  const updated = { ...current, ...patch };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}
