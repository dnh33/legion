/**
 * The tripwire for the pinned spend module (plan section 5 and 12.5). Every case is planted in a temp copy of src and ui/src and must be reported;
 * the untouched tree must be clean. Where the file's hash would otherwise fail the pin, the pin is injected to match (`opts.pins`), which proves the RULES
 * (not just the hash) reject the planted text.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORKS_FILE, SPEND_FILE, SPEND_METHOD_ALLOWLIST, SPEND_PINS, scanTree } from './bsv-scan.js';
import { SPEND_METHODS } from '../src/core/bsv/spend.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const copy = (): string => {
  const root = cleanupTemp('legion-spendwire-');
  for (const d of ['src', 'ui/src']) cpSync(join(REPO, d), join(root, d), { recursive: true, filter: (p) => !/\.(json|jsonl|png|svg|woff2?|ttf|css|md)$/.test(p) });
  return root;
};
const hashOf = (root: string, f: string) => createHash('sha256').update(readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
/** The pins for this copy, as the files now are (so only the rules can object). */
const pinsFor = (root: string) => ({ [SPEND_FILE]: hashOf(root, SPEND_FILE), [NETWORKS_FILE]: hashOf(root, NETWORKS_FILE) });
const append = (root: string, f: string, text: string) => writeFileSync(join(root, f), readFileSync(join(root, f), 'utf8') + '\n' + text + '\n');
const create = (root: string, f: string, text: string) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); };
const caught = (root: string, f: string, re: RegExp, pins = true) => {
  const v = scanTree(root, undefined, pins ? { pins: pinsFor(root) } : {}).violations;
  assert.ok(v.some((x) => x.startsWith(f) && re.test(x)), `not caught in ${f}: ${re}\n${JSON.stringify(v.filter((x) => x.startsWith(f)))}`);
};

test('spend tripwire: the real tree is clean with the committed pins, and the pins are the hashes of the real files', () => {
  assert.deepEqual(scanTree(REPO).violations, []);
  for (const f of [SPEND_FILE, NETWORKS_FILE]) assert.equal(hashOf(REPO, f), SPEND_PINS[f], `${f}: update SPEND_PINS with scripts/bsv-spend-pin.mjs after a review`);
  const crlf = copy();
  writeFileSync(join(crlf, SPEND_FILE), readFileSync(join(crlf, SPEND_FILE), 'utf8').replace(/\n/g, '\r\n'));
  assert.deepEqual(scanTree(crlf).violations, [], 'a CRLF checkout hashes the same');
});

test('spend tripwire: one changed byte in spend.ts reports the pin AND grants no exemption', () => {
  const root = copy();
  append(root, SPEND_FILE, '// x');
  caught(root, SPEND_FILE, /differs from the reviewed pin/, false);
  caught(root, SPEND_FILE, /contains createAction/, false);
  caught(root, SPEND_FILE, /abortAction/, false);
  const n = copy(); append(n, NETWORKS_FILE, '// x');
  caught(n, NETWORKS_FILE, /differs from the reviewed pin/, false);
});

test('spend tripwire: the three spend method names are reported in any other file, however spelled', () => {
  for (const [file, text, re] of [
    ['src/core/bsv/state.ts', '// createAction', /createAction/i], ['src/core/bsv/index.ts', "const m = 'signAction'; void m;", /signAction/],
    ['src/core/comms/hub.ts', "const m = 'sign' + 'Action'; void m;", /signAction/], ['src/core/kg/graph.ts', 'const m = `abort${"Action"}`; void m;', /abortAction/],
    ['src/core/bsv/audit.ts', "const m = ['create', 'Action'].join(''); void m;", /createAction/i],
    ['src/core/bsv/extra.ts', "export const m = 'createAction';", /createAction/i],
  ] as const) { const root = copy(); if (file.endsWith('extra.ts')) create(root, file, text); else append(root, file, text); caught(root, file, re); }
});

test('spend tripwire: with the pin matching, the spend file still may not name any other wallet method, the wallet port, the probe four or a network module', () => {
  const plants: Array<[string, RegExp]> = [
    ["const m = 'listOutputs'; void m;", /listOutputs/], ["const m = 'getPublicKey'; void m;", /getPublicKey/], ["const m = 'internalizeAction'; void m;", /internalizeAction/],
    ["const m = 'getVersion'; void m;", /getVersion/], ["const m = 'waitForAuthentication'; void m;", /waitForAuthentication/], ['const p = 33 + "21"; void p; // 3321', /3321/],
    ["const f = (globalThis as any).fetch; void f; fetch('http://127.0.0.1');", /outbound network|fetch/], ["import http from 'node:http'; void http;", /node:http|inbound-http/],
    ["import net from 'node:net'; void net;", /node:net|network module/], ["import cp from 'node:child_process'; void cp;", /child_process|child-process/],
    ["eval('1');", /eval/], ['void (globalThis as Record<string, unknown>)[k];', /computed/], ['const ѕ = 1; void ѕ;', /non-ASCII/],
    ['declare const x: Record<string, () => void>; declare const k: string; x[k]();', /computed call/],
    ["declare function tool(...a: unknown[]): void; tool('bsv_send', 'd', {}, async () => 1);", /wallet-like tool name: bsv_send/],
    ["declare function tool(...a: unknown[]): void; declare const n: string; tool(n, 'd', {}, async () => 1);", /tool name is not a string literal/],
    ["const t = 'bsv_status'; void t; declare function tool(...a: unknown[]): void; tool('bsv_status', 'd', {}, async () => 1);", /wallet-like tool name: bsv_status/],
  ];
  for (const [text, re] of plants) { const root = copy(); append(root, SPEND_FILE, text); caught(root, SPEND_FILE, re); }
});

test('spend tripwire: a network is never spelled in spend.ts, audit.ts or wallet-tool.ts (quoted, as a key or as a member)', () => {
  for (const f of [SPEND_FILE, 'src/core/bsv/audit.ts', 'src/core/bsv/wallet-tool.ts']) {
    for (const text of ["const n = 'main'; void n;", 'const n = "mainnet"; void n;', 'const n = `testnet`; void n;', 'const o = { main: 1 }; void o;', 'declare const x: { main: number }; void x.main;', "const n = 'LIVE'; void n;"]) {
      const root = copy(); append(root, f, text); caught(root, f, /spells a network/);
    }
  }
  const ok = copy(); append(ok, 'src/core/bsv/policy.ts', "const n = 'main'; void n;");
  assert.deepEqual(scanTree(ok).violations, [], 'the policy and the network table may spell networks (they are listed with a reason)');
});

test('spend tripwire: the spend path may only make things safer: setMainnetEnabled / arm / unfreeze / setCaps / setAllowlist are reported there, and setMainnetEnabled elsewhere', () => {
  for (const text of ['declare const p: any; p.setMainnetEnabled(true);', 'declare const p: any; p.arm(5);', 'declare const p: any; p.unfreeze();', 'declare const p: any; p.setCaps({});', 'declare const p: any; p.setAllowlist([]);']) {
    const root = copy(); append(root, SPEND_FILE, text); caught(root, SPEND_FILE, /may only make things safer|setMainnetEnabled/);
  }
  const r = copy(); append(r, 'src/core/bsv/index.ts', 'declare const p: any; p.setMainnetEnabled(true);'); caught(r, 'src/core/bsv/index.ts', /setMainnetEnabled/);
});

test('spend tripwire: the tool name, the transport, the mainnet route and the network table have one home each', () => {
  { const r = copy(); append(r, 'src/core/bsv/wallet-tool.ts', "declare function tool(...a: unknown[]): void; tool('bsv_spend_request', 'd', {}, async () => 1);"); caught(r, 'src/core/bsv/wallet-tool.ts', /wallet-like tool name: bsv_spend_request/); }
  { const r = copy(); append(r, 'src/core/bsv/policy.ts', 'declare const httpTransport: unknown; void httpTransport;'); caught(r, 'src/core/bsv/policy.ts', /httpTransport/); }
  { const r = copy(); append(r, 'src/core/bsv/policy.ts', "const route = '/api/bsv/policy/mainnet'; void route;"); caught(r, 'src/core/bsv/policy.ts', /mainnet switch route/); }
  for (const text of ["import { createHmac } from 'node:fs'; void createHmac;", "void fetch('http://127.0.0.1');", 'export const extra = 1;']) {
    const r = copy(); append(r, NETWORKS_FILE, text);
    const v = scanTree(r, undefined, { pins: pinsFor(r) }).violations.filter((x) => x.startsWith(NETWORKS_FILE));
    if (text.startsWith('export')) assert.deepEqual(v, [], 'an extra export is a pin matter (the hash), not a rule');
    else assert.ok(v.length > 0, text);
  }
});

test('spend tripwire: a pin or a tool entry with no file is a dead allowance', () => {
  const root = copy();
  const v = scanTree(root, undefined, { pins: { ...pinsFor(root), 'src/core/bsv/missing.ts': 'a'.repeat(64) } }).violations;
  assert.ok(v.some((x) => /missing\.ts.*dead allowance/.test(x)), JSON.stringify(v));
});

test('spend tripwire: the vocabulary is exactly three names, in the scan and in the module', () => {
  assert.deepEqual([...SPEND_METHOD_ALLOWLIST], ['createAction', 'signAction', 'abortAction']);
  assert.deepEqual([...SPEND_METHODS], ['createAction', 'signAction', 'abortAction']);
  const src = readFileSync(join(REPO, SPEND_FILE), 'utf8');
  assert.deepEqual([...new Set([...src.matchAll(/['"`]((?:get|is|create|sign|abort|internalize|list|relinquish|reveal|verify|acquire|prove|discover|wait)[A-Z][A-Za-z]{2,40})['"`]/g)].map((m) => m[1]))].sort(), ['abortAction', 'createAction', 'signAction']);
});

test('spend tripwire: package.json has no bsv, bitcoin, wallet or secp256k1 dependency, and spend.ts imports only the reviewed modules', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert.deepEqual(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /^@bsv\/|bsv|bitcoin|wallet|secp256k1|ethers/i.test(d)), []);
  const specs = [...readFileSync(join(REPO, SPEND_FILE), 'utf8').matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]).sort();
  assert.deepEqual(specs, ['../../shared/types.js', '../modules.js', './audit.js', './audit.js', './networks.js', './networks.js', './policy.js', './policy.js', './wallet-probe.js', './wallet-probe.js', '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', 'node:crypto', 'zod']);
});
