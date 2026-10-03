#!/usr/bin/env node
// Final check before publishing: runs the app's own verifier and parser over the four files, as an installed Legion would.
// usage: node scripts/release-verify.mjs --dir <folder with the four release files> [--trust-module <path>]
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, loadDist, REPO } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { dir: 'v', 'trust-module': 'v' });
if (!a.dir) die('usage: node scripts/release-verify.mjs --dir <folder>');
const dir = resolve(a.dir);
const trust = await import(pathToFileURL(a['trust-module'] ? resolve(a['trust-module']) : join(REPO, 'dist/src/core/updater/trust.js')).href);
const { parseManifest } = await loadDist('src/core/updater/manifest.js');
const m = readFileSync(join(dir, 'legion-update-manifest.json'));
const v = trust.verifyManifestSignature(m, readFileSync(join(dir, 'legion-update-manifest.json.sig'), 'utf8'), trust.UPDATE_KEYS);
if (!v.ok) die(`signature: ${v.reason}`);
const man = parseManifest(m);
const zip = readFileSync(join(dir, man.asset.name));
if (zip.length !== man.asset.size) die('the zip size differs from the manifest');
if (createHash('sha256').update(zip).digest('hex') !== man.asset.sha256) die('the zip sha256 differs from the manifest');
const sums = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8');
if (!sums.includes(man.asset.sha256)) die('SHA256SUMS.txt does not list the zip hash');
console.log(`OK: ${man.version} (${readdirSync(dir).length} files) verifies against key ${v.keyId}.`);
