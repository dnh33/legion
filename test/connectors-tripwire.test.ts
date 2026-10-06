import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWLIST, scanTree } from './bsv-scan.js';
import { repoRoot } from './ps-helpers.js';
import { tempDir } from './tmp-cleanup.js';

const DIR = 'src/core/connectors';
const CLIENT = `${DIR}/github/client.ts`;

test('only github/client.ts may use the network among the connector files, with a reason, and the scan finds no violation', () => {
  const listed = Object.keys(ALLOWLIST).filter((k) => k.startsWith(`${DIR}/`));
  assert.deepEqual(listed, [CLIENT]);
  assert.deepEqual(ALLOWLIST[CLIENT]!.kinds, ['fetch']);
  assert.ok(ALLOWLIST[CLIENT]!.reason.length > 100);
  const r = scanTree(repoRoot);
  assert.deepEqual(r.violations, []);
  assert.ok(r.matchedAllow.includes(`${CLIENT}#fetch`));
});

test('without its entry the client is flagged (the scan reads it), and a planted fetch in another connectors file fails', () => {
  const r = scanTree(repoRoot, { ...ALLOWLIST, [CLIENT]: { kinds: [], reason: 'removed' } });
  assert.ok(r.violations.some((v) => v.startsWith(`${CLIENT}:`) && /outbound network access/.test(v)));
  const root = tempDir('legion-trip-');
  mkdirSync(join(root, DIR), { recursive: true });
  mkdirSync(join(root, 'ui/src'), { recursive: true });
  writeFileSync(join(root, DIR, 'sneaky.ts'), "export const go = () => fetch('http://127.0.0.1:1/x');\n");
  assert.ok(scanTree(root, ALLOWLIST).violations.some((v) => v.startsWith(`${DIR}/sneaky.ts:`) && /outbound network access/.test(v)));
});

test('no other connector file names the network, a socket module, a child process or a base64 decode; real addresses live in hosts.ts only', () => {
  const walk = (d: string): string[] => readdirSync(join(repoRoot, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.ts') ? [`${d}/${e.name}`] : []));
  for (const f of walk(DIR)) {
    const text = readFileSync(join(repoRoot, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    if (f !== CLIENT) assert.doesNotMatch(text, /\bfetch\b|XMLHttpRequest|WebSocket|EventSource/, f);
    assert.doesNotMatch(text, /child_process|node:net|node:tls|node:https?['"]|node:dns|undici|\baxios\b|'base64'/, f);
    if (f !== `${DIR}/github/hosts.ts`) assert.doesNotMatch(text, /https?:\/\/[a-z]/i, `${f} names an address`);
  }
});
