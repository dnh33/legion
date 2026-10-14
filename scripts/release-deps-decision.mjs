#!/usr/bin/env node
// Decides, from data, whether a release changes dependencies and so must ship (and sign) the full package.
// Uses the app's own dependencyHash (src/core/updater/package.ts), so CI and an installed Legion cannot disagree.
// usage: node scripts/release-deps-decision.mjs --lock <package-lock.json> [--previous-lock <the last release's package-lock.json>]
// Prints one JSON line: { requiresFullInstall, reason, previousHash, hash }. No previous lock = fail closed (full package required).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { args, die, loadDist } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { lock: 'v', 'previous-lock': 'v' });
if (!a.lock) die('usage: node scripts/release-deps-decision.mjs --lock <package-lock.json> [--previous-lock <package-lock.json>]');
const readLock = (p, what) => {
  const text = readFileSync(resolve(p), 'utf8');
  try { const j = JSON.parse(text); if (!j || typeof j !== 'object') throw new Error('not an object'); } catch (e) { die(`${what} is not a readable package-lock.json (${e.message})`); }
  return text;
};
const { dependencyHash } = await loadDist('src/core/updater/package.js');
const next = readLock(a.lock, 'the new lock');
const hash = dependencyHash(next);
let out;
if (!a['previous-lock']) {
  out = { requiresFullInstall: true, reason: 'no previous release lock to compare with: the full package is required', previousHash: null, hash };
} else {
  const previousHash = dependencyHash(readLock(a['previous-lock'], 'the previous lock'));
  out = previousHash === hash
    ? { requiresFullInstall: false, reason: 'the dependency tree is unchanged since the previous release (only version fields differ)', previousHash, hash }
    : { requiresFullInstall: true, reason: 'the dependency tree changed since the previous release', previousHash, hash };
}
console.log(JSON.stringify(out));
