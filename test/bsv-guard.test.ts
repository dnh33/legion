import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Tests run from dist/test, so the module sources are resolved from the repo root: dist/test -> repo -> src/core/bsv.
const DIRS = ['../../src/core/bsv/', '../../ui/src/bsv/'].map((p) => fileURLToPath(new URL(p, import.meta.url)));

/** Source with comments and string/template literals blanked out, so only executable code is judged. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""');
}

const files = DIRS.flatMap((d) => readdirSync(d).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => ({ path: d + f, src: readFileSync(d + f, 'utf8') })));

test('BSV v0 has files to guard', () => { assert.ok(files.length >= 3); });

test('BSV v0 code imports nothing wallet, crypto or chain related', () => {
  const bad = /from\s+['"](?:node:)?crypto['"]|from\s+['"]@bsv\/|from\s+['"](?:bsv|bsv-mcp|bitcoinjs-lib|elliptic|tiny-secp256k1|ethers|@noble\/[^'"]*|@scure\/[^'"]*)['"]|require\(\s*['"](?:node:)?crypto['"]\s*\)/;
  for (const f of files) assert.equal(bad.test(f.src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), false, `${f.path} imports a wallet/crypto library`);
});

test('BSV v0 code has no key, signing, transaction or wallet identifiers', () => {
  const forbidden = /\b(?:sign\w*|wif|privateKey|private_key|mnemonic|seedPhrase|xprv|broadcast\w*|createAction|WalletClient|walletUrl|armedUntil|PrivateKey)\b/i;
  for (const f of files) {
    const hit = forbidden.exec(code(f.src));
    assert.equal(hit, null, `${f.path}: forbidden identifier "${hit?.[0]}" outside comments and strings`);
  }
});

test('the only strings that mention keys or seed phrases are prohibitions', () => {
  const lit = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
  for (const f of files) {
    for (const s of f.src.replace(/\/\*[\s\S]*?\*\//g, '').match(lit) ?? []) {
      if (!/seed phrase|private key|\bwif\b|mnemonic/i.test(s)) continue;
      assert.match(s, /never|not |no |don't|do not|nothing/i, `${f.path}: ${s}`);
    }
  }
});

test('BSV v0 server code makes no network or process calls of its own', () => {
  for (const f of files.filter((x) => x.path.includes('src/core/bsv'))) {
    assert.equal(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/.test(code(f.src)), false, `${f.path} talks to the network`);
    assert.equal(/from\s+['"]node:(?:https?|net|tls|dgram|child_process)['"]/.test(f.src.replace(/\/\*[\s\S]*?\*\//g, '')), false, `${f.path} imports a network/process module`);
  }
});
