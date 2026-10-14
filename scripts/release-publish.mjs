#!/usr/bin/env node
// Publishes a release the safe way (docs/SHIPPING.md, step 9): a DRAFT first, every asset uploaded to the draft, and only then
// `--draft=false --latest`. The release becomes "latest" with all ten assets already in place, so there is no moment when `releases/latest`
// serves a manifest whose second name, signature or package is not there yet (a 0.3.0+ install would read a 404 and fall back to the stone).
// It refuses to start when any of the ten files is missing. Run release-preflight and release-verify first; this does not replace them.
// usage: node scripts/release-publish.mjs --dir <folder> --version <v> --notes-file <file> [--repo dnh33/legion] [--title <text>] [--dry-run]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, loadDist, REPO } from './lib/release-lib.mjs';
import { fetchBytes, hashUrl, NEW_NAME, OLD_NAME, stoneProblems } from './lib/stepping-stone.mjs';

const a = args(process.argv.slice(2), { dir: 'v', version: 'v', 'notes-file': 'v', repo: 'v', title: 'v', 'dry-run': 'flag', 'trust-module': 'v', 'no-network': 'flag' });
if (!a.dir || !a.version || !a['notes-file']) die('usage: node scripts/release-publish.mjs --dir <folder> --version <v> --notes-file <file> [--repo dnh33/legion] [--title <text>] [--dry-run]');
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
const steps = [
  ['release', 'create', tag, '--repo', repo, '--title', a.title ?? `Legion ${tag}`, '--notes-file', resolve(a['notes-file']), '--draft'],
  ['release', 'upload', tag, '--repo', repo, ...assets.map((n) => join(dir, n))],
  ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'],
];
for (const s of steps) {
  if (a['dry-run']) { console.log(`gh ${s.join(' ')}`); continue; }
  console.log(`gh ${s.slice(0, 3).join(' ')} ...`);
  try { execFileSync('gh', s, { stdio: 'inherit' }); } catch { die(`gh ${s[1]} failed; the release stays a draft (nothing is latest yet). Fix it and run the missing step by hand.`); }
}
console.log(a['dry-run'] ? 'dry run: nothing was published.' : `published ${tag}. Next: wait for the CDN, then verify from the live URLs (docs/SHIPPING.md, step 10).`);
