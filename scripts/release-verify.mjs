#!/usr/bin/env node
// Final check before publishing: runs the app's own verifier and parser over the release files, as an installed Legion would.
// If SHA256SUMS.txt has been signed (scripts/release-sign-sums.mjs), the signature is verified here too, against the same key.
// usage: node scripts/release-verify.mjs --dir <folder with the release files> [--trust-module <path>]
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, loadDist, REPO } from './lib/release-lib.mjs';
import { fullAssetProblems } from './lib/full-asset-check.mjs';
import { hashUrl, NEW_NAME, OLD_NAME, readStones, stoneProblems } from './lib/stepping-stone.mjs';

const a = args(process.argv.slice(2), { dir: 'v', 'trust-module': 'v', 'no-network': 'flag' });
if (!a.dir) die('usage: node scripts/release-verify.mjs --dir <folder>');
const dir = resolve(a.dir);
const trust = await import(pathToFileURL(a['trust-module'] ? resolve(a['trust-module']) : join(REPO, 'dist/src/core/updater/trust.js')).href);
const { parseManifest } = await loadDist('src/core/updater/manifest.js');
// This release's OWN manifest is the second-name file; a release publishes both names (docs/SHIPPING.md, Stepping stones).
if (!existsSync(join(dir, NEW_NAME)) || !existsSync(join(dir, OLD_NAME))) die(`a release publishes both ${OLD_NAME} and ${NEW_NAME}; one is missing`);
const m = readFileSync(join(dir, NEW_NAME));
const v = trust.verifyManifestSignature(m, readFileSync(join(dir, `${NEW_NAME}.sig`), 'utf8'), trust.UPDATE_KEYS);
if (!v.ok) die(`signature: ${v.reason}`);
const man = parseManifest(m);
// The old name must be a signed stepping stone (full-install release) or the same manifest (code-only); its package must still be served as signed.
const stoneErr = await stoneProblems({ oldBytes: readFileSync(join(dir, OLD_NAME)), oldSig: existsSync(join(dir, `${OLD_NAME}.sig`)) ? readFileSync(join(dir, `${OLD_NAME}.sig`), 'utf8') : '', newBytes: m, trust, parseManifest, stones: readStones(), ...(man.requiresFullInstall && !a['no-network'] ? { fetchAsset: hashUrl } : {}) });
if (stoneErr.length) die(`stepping stone: ${stoneErr.join('; ')}`);
const zip = readFileSync(join(dir, man.asset.name));
if (zip.length !== man.asset.size) die('the zip size differs from the manifest');
if (createHash('sha256').update(zip).digest('hex') !== man.asset.sha256) die('the zip sha256 differs from the manifest');
const sums = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8');
if (!sums.includes(man.asset.sha256)) die('SHA256SUMS.txt does not list the zip hash');
const fullProblems = await fullAssetProblems({ manifest: man, version: man.version, dir, sums });
if (fullProblems.length) die(`full package: ${fullProblems.join('; ')}`);
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
