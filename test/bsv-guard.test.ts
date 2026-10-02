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

/** The three files that hash with node:crypto (sha256 only: the audit chain, the card/request binding and the policy file's fingerprint). No key, signature or cipher code anywhere. */
const HASHING = ['src/core/bsv/audit.ts', 'src/core/bsv/policy.ts', 'src/core/bsv/policy-store.ts'];

test('BSV code imports nothing wallet, crypto or chain related (node:crypto only in the three hashing files, and only createHash)', () => {
  const bad = /from\s+['"]@bsv\/|from\s+['"](?:bsv|bsv-mcp|bitcoinjs-lib|elliptic|tiny-secp256k1|ethers|@noble\/[^'"]*|@scure\/[^'"]*)['"]/;
  const crypto = /from\s+['"](?:node:)?crypto['"]|require\(\s*['"](?:node:)?crypto['"]\s*\)/;
  for (const f of files) {
    const src = f.src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(bad.test(src), false, `${f.path} imports a wallet/chain library`);
    if (crypto.test(src)) {
      assert.ok(HASHING.some((h) => f.path.endsWith(h)), `${f.path} imports node:crypto but is not a hashing file`);
      assert.match(src, /import \{ createHash \} from 'node:crypto';/, `${f.path}: only createHash may be imported`);
      assert.doesNotMatch(src, /\b(?:createSign|createVerify|createPrivateKey|createCipher\w*|createDecipher\w*|generateKeyPair\w*|sign|privateEncrypt|randomBytes|createECDH|createHmac)\s*\(/, `${f.path}: no key, signature or cipher code`);
    }
  }
});

test('BSV v0 code has no key, signing, transaction or wallet identifiers', () => {
  const forbidden = /\b(?:sign\w*|wif|privateKey|private_key|mnemonic|seedPhrase|xprv|broadcast\w*|createAction|WalletClient|PrivateKey)\b/i;
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
      // the audit log's list of field NAMES whose values it blanks (a denylist of words, not a statement about keys)
      if (f.path.endsWith('src/core/bsv/audit.ts') && /^'[a-z_\[\]?|-]+'$/.test(s) && s.includes('|')) continue;
      assert.match(s, /never|not |no |don't|do not|nothing/i, `${f.path}: ${s}`);
    }
  }
});

test('BSV server code makes no network or process calls of its own; the one exception is the probe, a loopback http client (rules in test/bsv-scan.ts)', () => {
  for (const f of files.filter((x) => x.path.includes('src/core/bsv'))) {
    assert.equal(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/.test(code(f.src)), false, `${f.path} talks to the network`);
    const probe = f.path.endsWith('src/core/bsv/wallet-probe.ts');
    const mods = probe ? /from\s+['"]node:(?:https|net|tls|dgram|child_process)['"]/ : /from\s+['"]node:(?:https?|net|tls|dgram|child_process)['"]/;
    assert.equal(mods.test(f.src.replace(/\/\*[\s\S]*?\*\//g, '')), false, `${f.path} imports a network/process module`);
  }
});
