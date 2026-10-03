#!/usr/bin/env node
// Generates the Ed25519 update-signing key pair. Run it ONCE, on the owner's own machine, with --out pointing OUTSIDE the repo.
// The private key is written to a 0600 file there and is never printed. Only the public key goes into src/core/updater/trust.ts.
// Store the private key offline (hardware key, or an encrypted USB stick / password manager attachment) and keep two backups.
// Never put it in GitHub secrets, CI, the repo, a chat or an agent session.
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { args, die, insideGitTree } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { out: 'v', id: 'v' });
if (!a.out) die('usage: node scripts/release-keygen.mjs --out <folder outside the repo> [--id k1]');
const id = a.id ?? 'k1';
if (!/^[A-Za-z0-9._-]{1,32}$/.test(id)) die('the key id may use letters, digits, dot, dash, underscore (max 32)');
const out = resolve(a.out);
if (insideGitTree(out)) die(`refusing: ${out} is inside a git work tree or this repo. Choose a folder outside it (a private, encrypted location).`);
mkdirSync(out, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keyFile = join(out, `legion-update-${id}.key.pem`);
const pubFile = join(out, `legion-update-${id}.pub.pem`);
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
writeFileSync(pubFile, pub, { flag: 'wx' });
console.log(`Private key written to ${keyFile} (not shown). Keep it offline; back it up twice.`);
console.log(`Public key written to ${pubFile}. Paste this into UPDATE_KEYS in src/core/updater/trust.ts:\n`);
console.log(`  { id: '${id}', publicKeyPem: \`${pub.trim()}\` },`);
