#!/usr/bin/env node
// Signs the RAW bytes of SHA256SUMS.txt with the owner's private key (kept outside the repo), so the hashes a downloader
// checks are covered by a signature and not only by a file that travelled beside them. Complements release-sign.mjs, which
// signs the update manifest. Run both at the same step (docs/SHIPPING.md, step 6); the key NEVER goes to CI.
// usage: node scripts/release-sign-sums.mjs --key <private key pem> --sums <SHA256SUMS.txt> [--trust-module <path to trust.js>]
// Refuses a key inside the repo or any git work tree, refuses a key whose public half is not embedded in the built app
// (dist trust.js), and checks the signature it just made against that public key before writing it.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, insideGitTree, REPO } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { key: 'v', sums: 'v', 'trust-module': 'v' });
if (!a.key || !a.sums) die('usage: node scripts/release-sign-sums.mjs --key <private key pem> --sums <SHA256SUMS.txt> [--trust-module <path>]');
if (insideGitTree(a.key)) die('refusing: the private key is inside the repo or a git work tree. Keep it outside, offline.');
const trust = await import(pathToFileURL(a['trust-module'] ? resolve(a['trust-module']) : join(REPO, 'dist/src/core/updater/trust.js')).href);
const priv = createPrivateKey(readFileSync(resolve(a.key)));
if (priv.asymmetricKeyType !== 'ed25519') die('the key is not an Ed25519 key');
const spki = (k) => createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('hex');
const pub = createPublicKey(priv);
const mine = spki(priv);
const embedded = trust.UPDATE_KEYS.find((k) => spki(k.publicKeyPem) === mine);
if (!embedded) die('the public half of this key is not in UPDATE_KEYS of the built app (src/core/updater/trust.ts). Sign with the key the app trusts, so the sums are checked with the same key users already have.');
const sumsPath = resolve(a.sums);
const bytes = readFileSync(sumsPath);
const sigBytes = sign(null, bytes, priv);
if (!verify(null, bytes, pub, sigBytes)) die('the signature did not verify against its own public key');
const sigText = JSON.stringify({ keyId: embedded.id, alg: 'ed25519', sig: sigBytes.toString('hex') });
writeFileSync(`${sumsPath}.sig`, sigText + '\n');
console.log(`wrote ${sumsPath}.sig (key ${embedded.id}, verified against its public key). Publish it beside SHA256SUMS.txt on the GitHub release v<version>.`);
