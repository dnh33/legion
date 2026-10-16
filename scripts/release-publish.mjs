#!/usr/bin/env node
// Publishes a release the safe way (docs/SHIPPING.md, step 9): a DRAFT first, every asset uploaded to the draft, and only then
// `--draft=false --latest`. The release becomes "latest" with all ten assets already in place, so there is no moment when `releases/latest`
// serves a manifest whose second name, signature or package is not there yet (a 0.3.0+ install would read a 404 and fall back to the stone).
// It refuses to start when any of the ten files is missing. Run release-preflight and release-verify first; this does not replace them.
// usage: node scripts/release-publish.mjs --dir <folder> --version <v> --notes-file <file> [--repo dnh33/legion] [--title <text>] [--dry-run] [--prerelease]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, loadDist, REPO, requireRehearsalFor } from './lib/release-lib.mjs';
import { fetchBytes, hashUrl, NEW_NAME, OLD_NAME, readStones, stoneProblems } from './lib/stepping-stone.mjs';
import { folderFullPackageProblems } from './lib/stone-carry.mjs';

const a = args(process.argv.slice(2), { dir: 'v', version: 'v', 'notes-file': 'v', repo: 'v', title: 'v', 'dry-run': 'flag', prerelease: 'flag', 'trust-module': 'v', 'no-network': 'flag', stones: 'v', 'stone-lock': 'v' });
requireRehearsalFor(a, ['no-network', 'trust-module', 'stones']);
if (!a.dir || !a.version || !a['notes-file']) die('usage: node scripts/release-publish.mjs --dir <folder> --version <v> --notes-file <file> [--repo dnh33/legion] [--title <text>] [--dry-run] [--prerelease] [--stone-lock <package-lock.json of the stepping stone>]');
const dir = resolve(a.dir), v = a.version, repo = a.repo ?? 'dnh33/legion', tag = `v${v}`;
const assets = [`legion-${v}-app.zip`, `legion-${v}-win-x64.zip`, OLD_NAME, `${OLD_NAME}.sig`, NEW_NAME, `${NEW_NAME}.sig`, 'SHA256SUMS.txt', 'SHA256SUMS.txt.sig', 'install.ps1', 'install.sh'];
const missing = assets.filter((n) => !existsSync(join(dir, n)));
if (missing.length) die(`not publishing: ${missing.join(', ')} missing in ${dir}. A release publishes all ${assets.length} files, both manifest names with their signatures included.`);
// The same stone checks as release-preflight and release-verify, so a folder that was changed after them is refused before a draft exists.
// --trust-module and --no-network are for tests and rehearsals only.
const trust = await import(pathToFileURL(a['trust-module'] ? resolve(a['trust-module']) : join(REPO, 'dist/src/core/updater/trust.js')).href);
const { parseManifest } = await loadDist('src/core/updater/manifest.js');
const problems = await stoneProblems({ oldBytes: readFileSync(join(dir, OLD_NAME)), oldSig: readFileSync(join(dir, `${OLD_NAME}.sig`), 'utf8'), newBytes: readFileSync(join(dir, NEW_NAME)), trust, parseManifest, publishing: true, ...(!a['no-network'] ? { fetchAsset: hashUrl, getBytes: fetchBytes } : {}) });
if (problems.length) die(`not publishing, stepping stone: ${problems.join('; ')}`);
// The carry rule too (docs/SHIPPING.md, Stepping stones): a code-only release whose lock differs from the stone's must carry its full package, and one
// whose lock equals the stone's must not. A manifest is signed, so it cannot be fixed here; this refuses a folder that skipped preflight and verify.
const man = parseManifest(readFileSync(join(dir, NEW_NAME)));
const { dependencyHash } = await loadDist('src/core/updater/package.js');
const stones = a.stones ? a.stones.split(',') : readStones();
const carry = await folderFullPackageProblems({ manifest: man, dir, sums: readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8'), stones, appZip: readFileSync(join(dir, man.asset.name)), oldManifestBytes: readFileSync(join(dir, OLD_NAME)), parseManifest, dependencyHash, stoneLockPath: a['stone-lock'] });
if (carry.lockProblems.length || carry.fullProblems.length) die(`not publishing, full package: ${[...carry.lockProblems, ...carry.fullProblems].join('; ')}`);
const steps = [
  ['release', 'create', tag, '--repo', repo, '--title', a.title ?? `Legion ${tag}`, '--notes-file', resolve(a['notes-file']), '--draft'],
  ['release', 'upload', tag, '--repo', repo, ...assets.map((n) => join(dir, n))],
  // --prerelease: public but NOT latest, so the live walk can run on the real assets first (docs/SHIPPING.md). Making it latest later is one
  // `gh release edit <tag> --prerelease=false --latest`, after the walk.
  ['release', 'edit', tag, '--repo', repo, '--draft=false', ...(a.prerelease ? ['--prerelease', '--latest=false'] : ['--latest'])],
];
for (const s of steps) {
  if (a['dry-run']) { console.log(`gh ${s.join(' ')}`); continue; }
  console.log(`gh ${s.slice(0, 3).join(' ')} ...`);
  try { execFileSync('gh', s, { stdio: 'inherit' }); } catch { die(`gh ${s[1]} failed; the release stays a draft (nothing is latest yet). Fix it and run the missing step by hand.`); }
}
console.log(a['dry-run'] ? 'dry run: nothing was published.' : `published ${tag}. Next: wait for the CDN, then verify from the live URLs (docs/SHIPPING.md, step 10).`);
