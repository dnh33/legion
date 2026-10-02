/**
 * Tests and scripts never reach the owner's own wallet port (C24). A static walk over test/ and scripts/ fails on any use of that port number
 * except an explicit allowlist, each entry with its reason; and the fake wallet's transport refuses the port at run time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeTransport, FORBIDDEN_WALLET_PORT, startFakeWallet } from './bsv-fake-wallet.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PORT = /(?<![\w.])3321(?!\w)/;

/** Files that may contain the number, and why. None of them connects to it. */
const ALLOWED: Record<string, string> = {
  'test/bsv-port-guard.test.ts': 'this guard',
  'test/bsv-fake-wallet.ts': 'the fake wallet refuses to bind or call the number',
  'test/bsv-scan.ts': 'the tripwire regex that forbids the number in src',
  'test/bsv-review-tripwire.test.ts': 'plants the number in a temp copy of src to prove the tripwire reports it',
  'test/bsv-spend-tripwire.test.ts': 'plants the number in a temp copy of src to prove the tripwire reports it',
  'test/bsv-wallet-probe.test.ts': 'URL parsing cases: strings handed to parseWalletUrl, no connection is made',
  'test/bsv-module-wallet.test.ts': 'a hand-edited config.json address that must be ignored, and URLs the Connect route must refuse',
  'test/bsv-fix-round.test.ts': 'a non-loopback URL the Connect route must refuse',
  'test/kg-bsv-seed.test.ts': 'a regex over the bundled knowledge pack text',
  'scripts/harness/fake-wallet.mjs': 'the harness fake wallet refuses to bind or call the number',
};

function walk(dir: string, out: string[]): void {
  for (const n of readdirSync(join(REPO, dir))) {
    if (n === 'node_modules' || n === 'dist' || n === 'fixtures' && dir === 'test') continue;
    const rel = `${dir}/${n}`;
    if (statSync(join(REPO, rel)).isDirectory()) walk(rel, out); else if (/\.(ts|tsx|js|mjs|cjs|json|ps1|py|sh)$/.test(n)) out.push(rel);
  }
}

test('port guard: the number appears in test/ and scripts/ only in the allowlisted files', () => {
  const files: string[] = [];
  walk('test', files); walk('scripts', files);
  assert.ok(files.length > 50);
  const hits = files.filter((f) => PORT.test(readFileSync(join(REPO, f), 'utf8')));
  assert.deepEqual(hits.filter((f) => !(f in ALLOWED)), [], 'a test or script names the real wallet port');
  for (const f of Object.keys(ALLOWED)) assert.ok(files.includes(f), `${f} is allowlisted but missing (a dead entry)`);
});

test('port guard: a planted number in a new test file would be reported', () => {
  assert.ok(PORT.test('const u = "http://127.0.0.1:3321";'));
  assert.ok(!PORT.test('const n = 133215;'));
});

test('port guard: the fake wallet never listens on the real port, and its transport refuses that port and any non-loopback host', async () => {
  const w = await startFakeWallet();
  try {
    assert.notEqual(w.port, FORBIDDEN_WALLET_PORT);
    const t = fakeTransport();
    const base = { path: '/getVersion', body: '{}', headers: {}, timeoutMs: 500, maxBytes: 1000 };
    assert.throws(() => t({ ...base, host: '127.0.0.1', port: FORBIDDEN_WALLET_PORT }), /real wallet port/);
    assert.throws(() => t({ ...base, host: '192.0.2.1', port: w.port }), /loopback/);
    const r = await t({ ...base, host: '127.0.0.1', port: w.port });
    assert.equal(r.status, 200);
    assert.match(r.body, /wallet-brc100-1\.0\.0/, 'the default shapes are what the real wallet was seen to answer');
  } finally { await w.stop(); }
});
