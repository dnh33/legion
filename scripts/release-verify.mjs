#!/usr/bin/env node
// Final check before publishing: runs the app's own verifier and parser over the release files, as an installed Legion would.
// If SHA256SUMS.txt has been signed (scripts/release-sign-sums.mjs), the signature is verified here too, against the same key.
// usage: node scripts/release-verify.mjs --dir <folder with the release files> [--trust-module <path>]
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
// SHA256SUMS.txt may be signed with the same key (scripts/release-sign-sums.mjs). Optional, so a release signed before
// that script existed still verifies; when the .sig is present it must verify against SHA256SUMS.txt and a trusted key.
const sumsSigPath = join(dir, 'SHA256SUMS.txt.sig');
if (existsSync(sumsSigPath)) {
  let ss;
  try { ss = JSON.parse(readFileSync(sumsSigPath, 'utf8')); } catch { die('SHA256SUMS.txt.sig is not valid JSON'); }
  if (!ss || ss.alg !== 'ed25519' || typeof ss.keyId !== 'string' || typeof ss.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(ss.sig)) die('SHA256SUMS.txt.sig has the wrong shape');
  const key = trust.UPDATE_KEYS.find((k) => k.id === ss.keyId);
  if (!key) die('SHA256SUMS.txt.sig names a key this build does not trust');
  if (!verify(null, Buffer.from(sums), createPublicKey(key.publicKeyPem), Buffer.from(ss.sig, 'hex'))) die('SHA256SUMS.txt.sig does not verify against SHA256SUMS.txt');
}
console.log(`OK: ${man.version} (${readdirSync(dir).length} files) verifies against key ${v.keyId}.`);
