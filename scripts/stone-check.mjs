#!/usr/bin/env node
// Daily check (.github/workflows/stone-check.yml) of the LATEST release: it must publish the second manifest name (a 404 there is a failure, not a
// fallback: every 0.3.0+ install would silently say "up to date" forever), that manifest must be the latest tag's own, the old name must be the
// stepping stone exactly as published at its tag, and the stone's package must still be downloadable with exactly the signed size and sha256.
// A deleted or replaced stone asset strands every 0.2.7 install silently, so this fails loudly instead.
// usage: node scripts/stone-check.mjs [--base <url>] [--trust-module <path>]  (needs `npm run build:ts` first)
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, loadDist, REPO } from './lib/release-lib.mjs';
import { fetchBytes, hashUrl, latestTagOf, liveProblems, readStones, REPO_BASE } from './lib/stepping-stone.mjs';

const a = args(process.argv.slice(2), { base: 'v', 'trust-module': 'v' });
const base = a.base ?? REPO_BASE;
const trust = await import(pathToFileURL(a['trust-module'] ? resolve(a['trust-module']) : join(REPO, 'dist/src/core/updater/trust.js')).href);
const { parseManifest } = await loadDist('src/core/updater/manifest.js');
let problems;
try { problems = await liveProblems({ base, getBytes: fetchBytes, latestTag: () => latestTagOf(base), fetchAsset: hashUrl, trust, parseManifest, stones: readStones() }); }
catch (e) { problems = [e.message]; } // a stalled or unreachable GitHub is a red run too, with a plain line
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  die(`the stepping-stone check FAILED (${problems.length} problem(s)). Restore the release or asset at once (docs/SHIPPING.md, Stepping stones).`);
}
console.log('OK: the latest release publishes both manifest names, the old name is the stepping stone as published, and its package matches the signed size and sha256.');
