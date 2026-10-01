/**
 * Tripwire: BSV mode v1 has no wallet, no keys, no chain and no network code, and nothing in it can arm mainnet.
 * This is the test that proves "knowledge only". It fails the build the day someone adds a wallet call to src/core/bsv or to
 * any tool registration, so that change has to be a deliberate, reviewed one (the wallet phase), not a drive-by.
 * The scan is checked against itself: it must find enough files, and a planted string in a temp copy must trip it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBsv } from '../src/shared/config.js';
import { BsvState } from '../src/core/bsv/state.js';

// Tests run from dist/test, so sources are resolved from the repo root.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CORE = join(REPO, 'src/core');
const BSV_DIR = join(CORE, 'bsv');

/** What no BSV or tool file may contain, anywhere (comments included: a wallet name in a comment is where a wallet call starts). */
const FORBIDDEN = ['3321', 'WalletClient', '@bsv/sdk', 'createAction', 'HTTPWalletJSON'];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Source with comments and string literals blanked, so only executable code is judged for outbound calls. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""');
}

/** Source with comments removed but string literals kept (an import specifier is a string). */
const noComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const TOOL_REG = /\bregisterTool\s*\(|\btool\(\s*['"`]/;
const TOOL_NAME = /(?:registerTool|\btool)\(\s*['"`]([A-Za-z0-9_.-]+)['"`]/g;
const OUTBOUND_CALL = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\bhttps?\.(?:request|get)\s*\(/;
const OUTBOUND_IMPORT = /from\s+['"](?:node:)?(?:https?|http2|net|tls|dgram|undici|axios|node-fetch)['"]|require\(\s*['"](?:node:)?(?:https?|http2|net|tls|dgram|undici|axios|node-fetch)['"]\s*\)/;
const WALLETY_TOOL_NAME = /wallet|bsv|spend|pay|sign|broadcast|createaction|arm|freeze/i;

interface Scan { bsvFiles: number; toolFiles: number; toolNames: string[]; violations: string[] }

/** Scans a src/core-shaped directory. */
function scan(core: string): Scan {
  const violations: string[] = [];
  const rel = (p: string) => p.slice(core.length + 1);
  const bsvFiles = tsFiles(join(core, 'bsv'));
  for (const f of bsvFiles) {
    const src = readFileSync(f, 'utf8');
    for (const tok of FORBIDDEN) if (src.includes(tok)) violations.push(`${rel(f)} contains ${tok}`);
    if (OUTBOUND_CALL.test(code(src)) || OUTBOUND_IMPORT.test(noComments(src))) violations.push(`${rel(f)} makes an outbound http/https/fetch call`);
    if (/\bmainnet\b/.test(code(src))) violations.push(`${rel(f)} names mainnet in code`);
  }
  const toolNames: string[] = [];
  const toolFiles = tsFiles(core).filter((f) => TOOL_REG.test(readFileSync(f, 'utf8')));
  for (const f of toolFiles) {
    const src = readFileSync(f, 'utf8');
    for (const tok of FORBIDDEN) if (src.includes(tok)) violations.push(`${rel(f)} (a tool registration) contains ${tok}`);
    if (/from\s+['"]@bsv\//.test(src)) violations.push(`${rel(f)} imports @bsv/*`);
    for (const m of src.matchAll(TOOL_NAME)) {
      toolNames.push(m[1]!);
      if (WALLETY_TOOL_NAME.test(m[1]!)) violations.push(`${rel(f)} registers a wallet-like tool name: ${m[1]}`);
    }
  }
  return { bsvFiles: bsvFiles.length, toolFiles: toolFiles.length, toolNames, violations };
}

test('tripwire: the scan is not vacuous (it finds the bsv files, the tool files and plenty of tool names)', () => {
  const r = scan(CORE);
  assert.ok(r.bsvFiles >= 3, `bsv files: ${r.bsvFiles}`);
  assert.ok(r.toolFiles >= 4, `tool-registering files: ${r.toolFiles}`);
  assert.ok(r.toolNames.length >= 25, `tool names found: ${r.toolNames.length}`);
  for (const known of ['legion_run', 'legion_vm', 'kg_recall', 'kg_search']) assert.ok(r.toolNames.includes(known), `scan did not see tool ${known}`);
});

test('tripwire: src/core/bsv and every tool registration have no wallet, key or chain call, and no tool is wallet-shaped', () => {
  assert.deepEqual(scan(CORE).violations, []);
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

test('tripwire: a planted wallet string, import, port or outbound call in a copy of src/core is caught', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'legion-tripwire-'));
  const copy = join(tmp, 'core');
  cpSync(CORE, copy, { recursive: true, filter: (p) => !p.endsWith('.json') && !p.endsWith('.jsonl') });
  assert.deepEqual(scan(copy).violations, [], 'the untouched copy is clean');
  const plants: Array<[string, string, RegExp]> = [
    ['bsv/index.ts', '\n// talks to 127.0.0.1:3321\n', /3321/],
    ['bsv/state.ts', "\nconst w = new WalletClient();\n", /WalletClient/],
    ['bsv/types.ts', "\nimport { PrivateKey } from '@bsv/sdk';\n", /@bsv\/sdk/],
    ['bsv/types.ts', '\nconst a = createAction;\n', /createAction/],
    ['bsv/index.ts', '\nconst t = HTTPWalletJSON;\n', /HTTPWalletJSON/],
    ['bsv/state.ts', "\nvoid fetch('http://127.0.0.1:3321/getVersion');\n", /outbound/],
    ['bsv/state.ts', "\nimport https from 'node:https';\n", /outbound/],
    ['mcp-tools.ts', "\nconst x = 'createAction';\n", /createAction/],
    ['kg/tools.ts', '\n// WalletClient\n', /WalletClient/],
  ];
  for (const [file, text, expect] of plants) {
    const path = join(copy, file);
    const before = readFileSync(path, 'utf8');
    writeFileSync(path, before + text);
    const v = scan(copy).violations;
    assert.ok(v.some((x) => expect.test(x)), `planting ${JSON.stringify(text.trim())} in ${file} was not caught: ${JSON.stringify(v)}`);
    writeFileSync(path, before);
  }
  // a wallet-shaped tool registration is caught too
  const toolsPath = join(copy, 'mcp-tools.ts');
  const before = readFileSync(toolsPath, 'utf8');
  writeFileSync(toolsPath, before + "\nserver.registerTool('legion_wallet_spend', {}, async () => ({}));\n");
  assert.ok(scan(copy).violations.some((x) => /wallet-like tool name: legion_wallet_spend/.test(x)));
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
  // no bsv source ever names a mainnet value in code: it is not a representable state
  for (const f of tsFiles(BSV_DIR)) assert.doesNotMatch(code(readFileSync(f, 'utf8')), /\bmainnet\b/, f);
});
