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

/**
 * The marker Electron writes with a NEW gates key, before the core builds its store. The store removes it after its first signed write. A key file
 * with this marker and no signed file in gates/ is still a first keyed start (the core never got to sign anything), not a lost folder. The marker is
 * one of the protected data-folder names, so an agent cannot make or delete it; next to a signed file it means nothing.
 */
export const UNCONFIRMED_MARKER = 'gates-key.unconfirmed';
export const unconfirmedMarkerPath = (dataDir: string): string => join(dataDir, UNCONFIRMED_MARKER);
export function keyUnconfirmed(dataDir: string): boolean {
  try { return existsSync(unconfirmedMarkerPath(dataDir)) && !hasSignedGatesFile(join(dataDir, 'gates')); } catch { return false; }
}
