#!/usr/bin/env node
// Final check before publishing: runs the app's own verifier and parser over the release files, as an installed Legion would.
// If SHA256SUMS.txt has been signed (scripts/release-sign-sums.mjs), the signature is verified here too, against the same key.
// usage: node scripts/release-verify.mjs --dir <folder with the release files> [--trust-module <path>] [--stone-lock <package-lock.json of the stepping stone>] [--published] [--base <url>]
// --published: the release is live, so a fullAsset is also fetched from its public URL and its size and sha256 must equal the signed manifest (post-publish check; before publishing the URL does not exist yet). The folder then needs only the small files (manifest, sig, app.zip, SHA256SUMS): the full zip is NOT compared with a local copy.
// --base is for rehearsals and tests (a loopback server in place of GitHub).
// A code-only release whose lock differs from the stone's must carry its full package (docs/SHIPPING.md); the stone lock comes from --stone-lock or `git show v<stone>:package-lock.json`.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, loadDist, REPO, requireRehearsalFor } from './lib/release-lib.mjs';
import { fetchBytes, hashUrl, NEW_NAME, OLD_NAME, readStones, REPO_BASE, stoneProblems } from './lib/stepping-stone.mjs';
import { folderFullPackageProblems, liveFullAssetProblems } from './lib/stone-carry.mjs';

const a = args(process.argv.slice(2), { dir: 'v', 'trust-module': 'v', 'no-network': 'flag', stones: 'v', 'stone-lock': 'v', published: 'flag', base: 'v' });
requireRehearsalFor(a, ['no-network', 'stones', 'trust-module', 'base']);
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
// The old name must be the signed stepping stone (the stone release itself: its own manifest); its package must still be served as signed.
const stoneErr = await stoneProblems({ oldBytes: readFileSync(join(dir, OLD_NAME)), oldSig: existsSync(join(dir, `${OLD_NAME}.sig`)) ? readFileSync(join(dir, `${OLD_NAME}.sig`), 'utf8') : '', newBytes: m, trust, parseManifest, stones: a.stones ? a.stones.split(',') : readStones(), publishing: true, ...(!a['no-network'] ? { fetchAsset: hashUrl, getBytes: fetchBytes } : {}) });
if (stoneErr.length) die(`stepping stone: ${stoneErr.join('; ')}`);
const zip = readFileSync(join(dir, man.asset.name));
if (zip.length !== man.asset.size) die('the zip size differs from the manifest');
if (createHash('sha256').update(zip).digest('hex') !== man.asset.sha256) die('the zip sha256 differs from the manifest');
const sums = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8');
if (!sums.includes(man.asset.sha256)) die('SHA256SUMS.txt does not list the zip hash');
const stones = a.stones ? a.stones.split(',') : readStones();
const { dependencyHash } = await loadDist('src/core/updater/package.js');
const { lockProblems, fullProblems } = await folderFullPackageProblems({ manifest: man, dir, sums, stones, appZip: zip, oldManifestBytes: readFileSync(join(dir, OLD_NAME)), parseManifest, dependencyHash, stoneLockPath: a['stone-lock'], published: !!a.published });
if (lockProblems.length) die(`stepping stone lock: ${lockProblems.join('; ')}`);
if (fullProblems.length) die(`full package: ${fullProblems.join('; ')}`);
// A published release: the full package must come back from its live URL with exactly the signed size and sha256 (a 285 MB download must not be a user's first test).
// stone-check.mjs does the same for the stone's package.
// --no-network skips only the stepping-stone downloads above; --published exists to do this one.
if (a.published && man.fullAsset) {
  const live = await liveFullAssetProblems({ manifest: man, base: a.base ?? REPO_BASE, fetchAsset: hashUrl });
  if (live.length) die(`live full package: ${live.join('; ')}`);
}
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
