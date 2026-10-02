/**
 * Tripwire: BSV mode v1 has no wallet, no keys, no chain and no outbound network code beyond a short allowlist, and nothing in it can arm mainnet.
 * The scan (test/bsv-scan.ts) reads ALL of src/ and ui/src: the day someone adds a wallet name, the wallet port, an unlisted
 * network or process user, or a wallet-shaped tool anywhere, the build fails, so that change has to be a deliberate, reviewed one
 * (the wallet phase), not a drive-by. It is a static scan, not a sandbox: docs/BSV-MODE.md says what it cannot see. The scan is
 * checked against itself in bsv-review-tripwire.test.ts (every evasion the review found is planted in a copy and must be caught).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBsv } from '../src/shared/config.js';
import { BsvState } from '../src/core/bsv/state.js';
import { lex, scanTree } from './bsv-scan.js';

// Tests run from dist/test, so sources are resolved from the repo root.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const BSV_DIR = join(REPO, 'src/core/bsv');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Source with comments and string literals blanked, so only executable code is judged. */
const code = (src: string): string => lex(src).code;

test('tripwire: the scan is not vacuous (it reads all of src and ui/src, and sees the tool registrations)', () => {
  const r = scanTree(REPO);
  assert.ok(r.files.length > 100, `files scanned: ${r.files.length}`);
  assert.ok(r.files.some((f) => f.startsWith('src/core/bsv/')) && r.files.some((f) => f.startsWith('ui/src/bsv/')), 'the bsv sources are scanned');
  assert.ok(r.toolNames.length >= 25, `tool names found: ${r.toolNames.length}`);
  for (const known of ['legion_run', 'legion_vm', 'kg_recall', 'kg_search']) assert.ok(r.toolNames.includes(known), `scan did not see tool ${known}`);
});

test('tripwire: nothing in src or ui/src has a wallet, key or chain call, an unlisted network or process user, or a wallet-shaped tool (planted cases: bsv-review-tripwire.test.ts)', () => {
  assert.deepEqual(scanTree(REPO).violations, []);
});

test('tripwire: nothing under src imports @bsv/*, and package.json has no @bsv or wallet dependency', () => {
  const files = tsFiles(join(REPO, 'src'));
  assert.ok(files.length > 40, `src files: ${files.length}`);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /from\s+['"]@bsv\/|require\(\s*['"]@bsv\//, f);
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.ok(deps.length > 5);
  assert.deepEqual(deps.filter((d) => /^@bsv\/|bsv|bitcoin|wallet|secp256k1|ethers/i.test(d)), []);
});

test('tripwire: BsvNetwork stays the literal testnet and no input can make the network mainnet', () => {
  const types = readFileSync(join(BSV_DIR, 'types.ts'), 'utf8');
  assert.match(types, /export type BsvNetwork = 'testnet';/);
  const state = readFileSync(join(BSV_DIR, 'state.ts'), 'utf8');
  assert.match(state, /readonly network = 'testnet' as const;/);
  for (const attempt of ['mainnet', 'main', 'MAINNET', 'live', '', null, undefined, 7, { network: 'mainnet' }, ['mainnet']]) {
    for (const wrap of [(v: unknown) => ({ enabled: true, network: v }), (v: unknown) => v]) {
      assert.equal(normalizeBsv(wrap(attempt)).network, 'testnet', JSON.stringify(attempt));
    }
  }
  assert.equal(new BsvState({ dataDir: mkdtempSync(join(tmpdir(), 'legion-tripwire-state-')), config: { bsv: { enabled: true, network: 'mainnet' } } as never }).network, 'testnet');
  // The knowledge mode names no mainnet value. Mainnet exists only as the spend network, behind the hard-off switch: the files that must not spell it at all
  // (the spend path, the audit log and the status tool take the network as an opaque value) are held to that by the NET_LITERAL rule in test/bsv-scan.ts; the
  // files that may (the network table, the policy, the probe, the module's views and routes) are listed there with their reasons.
  for (const f of ['spend.ts', 'audit.ts', 'wallet-tool.ts', 'state.ts', 'types.ts']) assert.doesNotMatch(code(readFileSync(join(BSV_DIR, f), 'utf8')), /\bmainnet\b/, f);
});
