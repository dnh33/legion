// Option A of the stepping stone (docs/SHIPPING.md, Stepping stones): while an install can still hold the stone's lock, every code-only release whose
// lock differs from the stone's carries its own full package (fullAsset), because the frozen 0.3.0 updater refuses the code package and can only fall
// back to a signed fullAsset. Shared by release-preflight and release-verify. Pure except stoneLockText and the injected network.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readZipEntry, REPO } from './release-lib.mjs';

/** True when the release lock's dependency content differs from the stone's. A missing or unparseable stone lock counts as "differs" (fail closed). */
export function lockDiffersFromStone({ releaseLock, stoneLock, dependencyHash }) {
  if (typeof stoneLock !== 'string') return true;
  try { JSON.parse(stoneLock); } catch { return true; }
  return dependencyHash(releaseLock) !== dependencyHash(stoneLock);
}

/** The stone's package-lock.json: the given file, else `git show v<stone>:package-lock.json` in this repo. null when neither works. */
export function stoneLockText({ path, stone, repo = REPO }) {
  try {
    if (path) return readFileSync(resolve(path), 'utf8');
    return execFileSync('git', ['-C', repo, 'show', `v${stone}:package-lock.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch { return null; }
}

/**
 * Does this release have to carry the full package, and is the stone lock we compare against really the stone's?
 * -> { carryRequired, problems }. The stone release itself never carries. The lock must hash (raw bytes) to the depsSha256 the stone's signed manifest
 * names, so a wrong or edited lock file cannot decide.
 */
export function carryDecision({ version, stones, releaseLock, stoneLock, stoneDepsSha256, dependencyHash }) {
  if (stones.includes(version)) return { carryRequired: false, problems: [] };
  const problems = [];
  const stone = stones[stones.length - 1];
  if (typeof stoneLock !== 'string') {
    problems.push(`the stone lock is not available (pass --stone-lock <package-lock.json of v${stone}>, or run where the tag v${stone} exists): without it the release is treated as differing from the stone and must carry the full package`);
  } else if (!stoneDepsSha256 || createHash('sha256').update(stoneLock).digest('hex') !== stoneDepsSha256) {
    problems.push(`the stone lock is not the lock the stepping stone's signed manifest names (depsSha256 ${String(stoneDepsSha256).slice(0, 12)}): a wrong lock file cannot decide whether this release must carry the full package`);
    stoneLock = null;
  }
  return { carryRequired: lockDiffersFromStone({ releaseLock, stoneLock, dependencyHash }), problems };
}

/** Fetches the LIVE fullAsset like an install does and compares size and sha256 with the signed manifest. No fullAsset = nothing to check. */
export async function liveFullAssetProblems({ manifest, base, fetchAsset }) {
  const fa = manifest.fullAsset;
  if (!fa) return [];
  const url = `${base}/releases/download/v${manifest.version}/${fa.name}`;
  try {
    const got = await fetchAsset(url);
    const out = [];
    if (got.size !== fa.size) out.push(`${url} returns ${got.size} bytes, the signed fullAsset size is ${fa.size}`);
    if (got.sha256 !== fa.sha256) out.push(`${url} returns sha256 ${got.sha256}, the signed fullAsset sha256 is ${fa.sha256}`);
    return out;
  } catch (e) { return [`the full package is not reachable at ${url}: ${e.message}`]; }
}

/**
 * The folder-level question for preflight and verify: from the app zip's own lock and the old-name (stone) manifest in the release folder,
 * must this release carry the full package? -> { carryRequired, problems }.
 */
export function carryForFolder({ version, stones, appZip, oldManifestBytes, parseManifest, dependencyHash, stoneLockPath }) {
  if (stones.includes(version)) return { carryRequired: false, problems: [] };
  const lockBuf = readZipEntry(appZip, `legion-${version}/package-lock.json`);
  if (!lockBuf) return { carryRequired: true, problems: ['the app zip has no package-lock.json, so the release cannot be compared with the stepping stone'] };
  let stoneDepsSha256;
  try { stoneDepsSha256 = parseManifest(oldManifestBytes).depsSha256; } catch { /* stoneProblems reports an unparseable old-name manifest */ }
  const stone = stones[stones.length - 1];
  return carryDecision({ version, stones, releaseLock: lockBuf.toString('utf8'), stoneLock: stoneLockText({ path: stoneLockPath, stone }), stoneDepsSha256, dependencyHash });
}
