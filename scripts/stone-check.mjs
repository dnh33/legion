#!/usr/bin/env node
// Daily check (.github/workflows/stone-check.yml): the LATEST release's old-name manifest must verify, and the package it names must still be
// downloadable with exactly the signed size and sha256. A deleted or replaced stepping-stone asset strands every 0.2.7 install silently, so this
// fails loudly instead. usage: node scripts/stone-check.mjs [--base <url>] [--trust-module <path>]  (needs `npm run build:ts` first)
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, loadDist, REPO } from './lib/release-lib.mjs';
import { hashUrl, liveProblems, REPO_BASE } from './lib/stepping-stone.mjs';

const a = args(process.argv.slice(2), { base: 'v', 'trust-module': 'v' });
const trust = await import(pathToFileURL(a['trust-module'] ? resolve(a['trust-module']) : join(REPO, 'dist/src/core/updater/trust.js')).href);
const { parseManifest } = await loadDist('src/core/updater/manifest.js');
const getBytes = async (url) => { const r = await fetch(url, { redirect: 'follow' }); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; };
const problems = await liveProblems({ base: a.base ?? REPO_BASE, getBytes, fetchAsset: hashUrl, trust, parseManifest });
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  die(`the stepping-stone check FAILED (${problems.length} problem(s)). Restore the release or asset at once (docs/SHIPPING.md, Stepping stones).`);
}
console.log('OK: the live old-name manifest verifies and its package matches the signed size and sha256.');
