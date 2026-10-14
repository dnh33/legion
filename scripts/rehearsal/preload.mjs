// Rehearsal-only preload. It is loaded through NODE_OPTIONS="--import <this file>" by the full-install rehearsal workflow, on a CI
// runner, into a throwaway install. Nothing in src/ knows about it, and an install without those two variables ignores it.
//   REHEARSAL_PORT         a loopback http server (scripts/rehearsal/serve.mjs) standing in for GitHub
//   REHEARSAL_PUBKEY_FILE  a throwaway Ed25519 public key (PEM) standing in for the baked release key k1
// What it does, in memory only (no installed file is edited):
//   1. fetch() calls to the three GitHub hosts the updater may use go to the loopback server instead. The updater has already
//      checked the real URL against its allowlist by then, so every redirect hop is still validated by production code.
//   2. when the updater's trust module loads, the PEM of the baked key is swapped for the throwaway one.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

const port = process.env.REHEARSAL_PORT;
const pemFile = process.env.REHEARSAL_PUBKEY_FILE;

if (port && pemFile) {
  const HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw);
    if (!HOSTS.has(u.hostname)) return realFetch(input, init);
    return realFetch(`http://127.0.0.1:${port}/${u.hostname}${u.pathname}${u.search}`, init);
  };

  const pem = readFileSync(pemFile, 'utf8').trim();
  if (!/^-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----$/.test(pem)) throw new Error('rehearsal preload: REHEARSAL_PUBKEY_FILE is not a public key PEM');
  registerHooks({
    load(url, context, nextLoad) {
      const r = nextLoad(url, context);
      if (!/\/dist\/src\/core\/updater\/trust\.js$/.test(url)) return r;
      const src = Buffer.from(r.source).toString('utf8');
      const re = /-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----/g;
      if ((src.match(re) ?? []).length !== 1) throw new Error('rehearsal preload: expected exactly one baked key in trust.js');
      return { ...r, source: src.replace(re, () => pem) };
    },
  });
}
