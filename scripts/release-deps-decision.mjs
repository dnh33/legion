#!/usr/bin/env node
// Decides, from data, whether a release changes dependencies and so must ship (and sign) the full package.
// Uses the app's own dependencyHash (src/core/updater/package.ts), so CI and an installed Legion cannot disagree.
// usage: node scripts/release-deps-decision.mjs --lock <package-lock.json> [--previous-lock <the last release's package-lock.json>] [--stone-lock <the stepping stone's package-lock.json>]
// Prints one JSON line: { requiresFullInstall, reason, previousHash, hash, carryFull, carryReason, stoneHash }.
// No previous lock = fail closed (full package required).
//
// requiresFullInstall is computed against the PREVIOUS release. carryFull is computed against the STEPPING STONE (0.3.0, whose updater is frozen):
// an install that still holds the stone's lock refuses a code-only package whose lock differs and can only fall back to the release's own
// full package, so while the lock differs a code-only release must carry it (docs/SHIPPING.md, Stepping stones). A missing or unreadable
// stone lock fails closed: carryFull true.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { args, die, loadDist } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { lock: 'v', 'previous-lock': 'v', 'stone-lock': 'v' });
if (!a.lock) die('usage: node scripts/release-deps-decision.mjs --lock <package-lock.json> [--previous-lock <package-lock.json>] [--stone-lock <package-lock.json>]');
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
// The stone comparison never dies: whatever is wrong with the stone lock reads as "differs", so the release carries the full package.
let stoneHash = null;
let carryFull = true;
let carryReason;
if (!a['stone-lock']) carryReason = 'no stepping-stone lock was given, so the release carries the full package (fail closed)';
else {
  try {
    const text = readFileSync(resolve(a['stone-lock']), 'utf8');
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object') throw new Error('not an object');
    stoneHash = dependencyHash(text);
    carryFull = stoneHash !== hash;
    carryReason = carryFull
      ? 'the dependency tree differs from the stepping stone (0.3.0): installs that still hold the stone lock can only reach this release through its own full package'
      : 'the dependency tree equals the stepping stone: every install can take the code-only package';
  } catch (e) { carryReason = `the stepping-stone lock is missing or unreadable (${e.message}), so the release carries the full package (fail closed)`; }
}
console.log(JSON.stringify({ ...out, carryFull, carryReason, stoneHash }));
