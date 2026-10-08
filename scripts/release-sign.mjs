#!/usr/bin/env node
// Signs the RAW bytes of a manifest with the owner's private key (kept outside the repo) and checks the result with the app's own verifier.
// usage: node scripts/release-sign.mjs --key <private key pem> --manifest <file> [--trust-module <path to trust.js>]
// Refuses a key inside the repo or any git work tree, and refuses a key whose public half is not embedded in the built app (dist trust.js).
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, insideGitTree, REPO } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { key: 'v', manifest: 'v', 'trust-module': 'v' });
if (!a.key || !a.manifest) die('usage: node scripts/release-sign.mjs --key <private key pem> --manifest <file>');
if (insideGitTree(a.key)) die('refusing: the private key is inside the repo or a git work tree. Keep it outside, offline.');
const trust = await import(pathToFileURL(a['trust-module'] ? resolve(a['trust-module']) : join(REPO, 'dist/src/core/updater/trust.js')).href);
const priv = createPrivateKey(readFileSync(resolve(a.key)));
if (priv.asymmetricKeyType !== 'ed25519') die('the key is not an Ed25519 key');
const spki = (k) => createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('hex');
const mine = spki(priv);
const embedded = trust.UPDATE_KEYS.find((k) => spki(k.publicKeyPem) === mine);
if (!embedded) die('the public half of this key is not in UPDATE_KEYS of the built app (src/core/updater/trust.ts). Add it, rebuild, repackage, then sign: otherwise no installed Legion would accept the release.');
const mPath = resolve(a.manifest);
const bytes = readFileSync(mPath);
const sigText = JSON.stringify({ keyId: embedded.id, alg: 'ed25519', sig: sign(null, bytes, priv).toString('hex') });
const v = trust.verifyManifestSignature(bytes, sigText, trust.UPDATE_KEYS);
if (!v.ok) die(`the signature did not verify: ${v.reason}`);
writeFileSync(`${mPath}.sig`, sigText + '\n');
console.log(`wrote ${mPath}.sig (key ${embedded.id}, verified with the app's own verifier). Next: sign SHA256SUMS.txt with scripts/release-sign-sums.mjs. Publish the zip, the manifest, the .sig, SHA256SUMS.txt and its .sig on the GitHub release v<version>.`);
