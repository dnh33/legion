/** The full-install rehearsal injects a preload through NODE_OPTIONS on a CI runner. These pin what it does, and that production cannot be steered the same way. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './tmp-cleanup.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PRELOAD = join(REPO, 'scripts', 'rehearsal', 'preload.mjs');
const hasHooks = typeof (await import('node:module') as { registerHooks?: unknown }).registerHooks === 'function';

function child(env: Record<string, string>, code: string): Promise<{ code: number | null; out: string; err: string }> {
  const dir = tempDir('rh-pre-');
  const probe = join(dir, 'probe.mjs'); writeFileSync(probe, code);
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', pathToFileURL(PRELOAD).href, probe], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d: Buffer) => { out += d; }); c.stderr.on('data', (d: Buffer) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

test('rehearsal preload: swaps the baked key and sends GitHub fetches to loopback', { skip: !hasHooks }, async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyFile = join(tempDir('rh-key-'), 'pub.pem'); writeFileSync(keyFile, pem);
  const seen: string[] = [];
  const srv = createServer((req, res) => { seen.push(req.url ?? ''); res.end('hello'); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = String((srv.address() as { port: number }).port);
  try {
    const trustUrl = pathToFileURL(join(REPO, 'dist', 'src', 'core', 'updater', 'trust.js')).href;
    const r = await child({ REHEARSAL_PORT: port, REHEARSAL_PUBKEY_FILE: keyFile }, `
      const { UPDATE_KEYS } = await import(${JSON.stringify(trustUrl)});
      const res = await fetch('https://github.com/dnh33/legion/releases/latest/download/x');
      const other = await fetch('https://objects.githubusercontent.com/a/b').then((x) => x.text());
      console.log(JSON.stringify({ pem: UPDATE_KEYS[0].publicKeyPem.trim(), body: await res.text(), other }));`);
    assert.equal(r.code, 0, r.err);
    const o = JSON.parse(r.out) as { pem: string; body: string; other: string };
    assert.equal(o.pem, pem.trim());
    assert.equal(o.body, 'hello'); assert.equal(o.other, 'hello');
    assert.deepEqual(seen, ['/github.com/dnh33/legion/releases/latest/download/x', '/objects.githubusercontent.com/a/b']);
  } finally { srv.close(); }
});

test('rehearsal preload: without its two variables it does nothing', { skip: !hasHooks }, async () => {
  const trustUrl = pathToFileURL(join(REPO, 'dist', 'src', 'core', 'updater', 'trust.js')).href;
  const real = readFileSync(join(REPO, 'src', 'core', 'updater', 'trust.ts'), 'utf8').match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/)![0].replace(/\s+/g, '');
  const r = await child({ REHEARSAL_PORT: '', REHEARSAL_PUBKEY_FILE: '' }, `
    const { UPDATE_KEYS } = await import(${JSON.stringify(trustUrl)});
    console.log(JSON.stringify(UPDATE_KEYS[0].publicKeyPem));`);
  assert.equal(r.code, 0, r.err);
  assert.equal((JSON.parse(r.out) as string).replace(/\s+/g, ''), real);
});

test('rehearsal preload: delays the start of the core of ONE named version, and no other', { skip: !hasHooks }, async () => {
  const root = tempDir('rh-core-');
  mkdirSync(join(root, 'dist', 'src', 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.99.0' }));
  const core = join(root, 'dist', 'src', 'bin', 'legion-core.js');
  writeFileSync(core, 'console.log("ran");');
  const keyFile = join(tempDir('rh-key-'), 'pub.pem');
  const { publicKey } = generateKeyPairSync('ed25519'); writeFileSync(keyFile, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const delayFile = join(tempDir('rh-delay-'), 'delay.txt');
  const timed = (version: string) => {
    writeFileSync(delayFile, `${version}:700`);
    const t0 = Date.now();
    return new Promise<number>((resolve) => {
      const c = spawn(process.execPath, ['--import', pathToFileURL(PRELOAD).href, core], { env: { ...process.env, REHEARSAL_PORT: '1', REHEARSAL_PUBKEY_FILE: keyFile, REHEARSAL_DELAY_FILE: delayFile }, stdio: 'ignore' });
      c.on('close', () => resolve(Date.now() - t0));
    });
  };
  assert.ok(await timed('0.99.0') >= 700, 'the named version waits');
  assert.ok(await timed('0.2.7') < 700, 'another version does not');
});

// ---- tripwires: no way to point a production build at a test source or key

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) srcFiles(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p); }
  return out;
}

test('tripwire: nothing under src/ reads the rehearsal variables or NODE_EXTRA_CA_CERTS, and the update source and key code reads no environment variable', () => {
  const hits = srcFiles(join(REPO, 'src')).filter((f) => /REHEARSAL_|NODE_EXTRA_CA_CERTS/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(REPO.length));
  assert.deepEqual(hits, []);
  const env = srcFiles(join(REPO, 'src', 'core', 'updater')).filter((f) => !f.endsWith('apply.ts') && /process\.env/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(REPO.length));
  assert.deepEqual(env, [], 'the update source and key cannot be steered from the environment (apply.ts only passes the environment to the helper it starts)');
});

test('tripwire: the baked trust list still holds exactly one key', () => {
  const trust = readFileSync(join(REPO, 'src', 'core', 'updater', 'trust.ts'), 'utf8');
  assert.equal((trust.match(/-----BEGIN PUBLIC KEY-----/g) ?? []).length, 1);
});

test('tripwire: the rehearsal workflow has no secrets, no pull_request_target, read-only permissions and a repository guard', () => {
  const wf = readFileSync(join(REPO, '.github', 'workflows', 'full-install-rehearsal.yml'), 'utf8');
  assert.doesNotMatch(wf, /secrets\./);
  assert.doesNotMatch(wf, /pull_request_target/);
  assert.doesNotMatch(wf, /contents:\s*write|id-token|attestations:\s*write/);
  assert.match(wf, /permissions:\s*\n\s+contents: read/);
  assert.match(wf, /github\.repository == 'dnh33\/legion'/);
  assert.doesNotMatch(wf, /gh release|gh api|release-sign\.mjs --key [^$\n]*legion-update-k1/);
});
