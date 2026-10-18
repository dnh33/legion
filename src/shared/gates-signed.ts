/**
 * Does the gates folder hold a file that carries a signature? Only such a folder can be one whose key was lost. A data folder from 0.3.4 (or
 * 0.3.0) has state.json and projects.json but no signed gates file and no gates-key.bin: that is a first keyed start, not a lost key. The core
 * store and Electron's key-state hint both ask this, so they cannot disagree. Reads only; a file that does not parse counts as unsigned.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ID_RE } from './projects.js';

const FILE_RE = /^(.+)\.json$/;
const MAX_BYTES = 64 * 1024;

export function hasSignedGatesFile(gatesDir: string): boolean {
  try {
    if (!existsSync(gatesDir)) return false;
    for (const n of readdirSync(gatesDir)) {
      const m = FILE_RE.exec(n);
      if (!m || (m[1] !== 'app' && !PROJECT_ID_RE.test(m[1]!))) continue;
      try {
        const f = join(gatesDir, n);
        if (statSync(f).size > MAX_BYTES) continue;
        const raw: unknown = JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'sig' in raw) return true;
      } catch { /* not valid JSON: not a signed file */ }
    }
  } catch { /* an unreadable folder is read as having none */ }
  return false;
}
