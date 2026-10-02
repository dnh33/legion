import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWLIST, scanTree } from './bsv-scan.js';
import { repoRoot } from './ps-helpers.js';

const DIR = 'src/core/providers';
const files = readdirSync(join(repoRoot, DIR)).filter((n) => n.endsWith('.ts')).map((n) => `${DIR}/${n}`);

test('C23 only providers/http.ts may use the network, and it is the only providers file on the allowlist', () => {
  const listed = Object.keys(ALLOWLIST).filter((k) => k.startsWith(`${DIR}/`));
  assert.deepEqual(listed.sort(), [`${DIR}/external-mcp.ts`, `${DIR}/http.ts`, `${DIR}/proc.ts`]);
  assert.deepEqual(ALLOWLIST[`${DIR}/proc.ts`]!.kinds, ['child-process']);
  assert.deepEqual(ALLOWLIST[`${DIR}/external-mcp.ts`]!.kinds, ['fetch']);
  assert.deepEqual(ALLOWLIST[`${DIR}/http.ts`]!.kinds, ['fetch']);
  const r = scanTree(repoRoot);
  assert.deepEqual(r.violations, []);
  assert.ok(r.files.includes(`${DIR}/http.ts`));
  assert.ok(r.matchedAllow.includes(`${DIR}/http.ts#fetch`));
});

test('C23 no providers file spawns a process, imports a socket module, or names a non-loopback address in the one file that may fetch', () => {
  for (const f of files) {
    const text = readFileSync(join(repoRoot, f), 'utf8');
    assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), f === `${DIR}/proc.ts` ? /node:net|node:tls|node:http['"]|node:https|node:dns|undici|\baxios\b/ : /child_process|cross-spawn|\bexeca\b|node:net|node:tls|node:http['"]|node:https|node:dns|undici|\baxios\b/, f);
    if (f !== `${DIR}/http.ts` && f !== `${DIR}/external-mcp.ts`) assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/, f);
  }
  const http = readFileSync(join(repoRoot, `${DIR}/http.ts`), 'utf8');
  for (const m of http.matchAll(/https?:\/\/([^\/'"`\s:${}]+)/g)) assert.match(m[1]!, /^(?:127\.0\.0\.1|localhost|\[::1\])$/, `non-loopback host in http.ts: ${m[1]}`);
});

test('A1 no file under src/core/providers imports an MCP transport that spawns (the SDK stdio client, cross-spawn, execa), and the other transports only in external-mcp.ts', () => {
  for (const f of files) {
    const t = readFileSync(join(repoRoot, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(t, /client\/stdio(?:\.js)?['"]|cross-spawn|\bexeca\b|server\/stdio/, `${f} imports a transport that spawns`);
    if (f !== `${DIR}/external-mcp.ts`) assert.doesNotMatch(t, /client\/(?:sse|streamableHttp)\.js/, f);
  }
  // only proc.ts imports child_process, and only stdio-transport.ts / cli.ts / external-mcp.ts / tool-loop.ts reach it, through proc.ts
  for (const f of files) {
    const t = readFileSync(join(repoRoot, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const spawnsViaProc = /from '\.\/proc\.js'/.test(t);
    if (spawnsViaProc) assert.ok(['stdio-transport.ts', 'cli.ts', 'runtime.ts'].includes(f.split('/').pop()!), `${f} may not use proc.ts`);
  }
});

test('A1 the tripwire catches a spawning import planted in another providers file (the scan is not a no-op for child processes)', () => {
  const r = scanTree(repoRoot, { ...ALLOWLIST, [`${DIR}/proc.ts`]: { kinds: [], reason: 'removed' } });
  assert.ok(r.violations.some((v) => v.startsWith(`${DIR}/proc.ts:`) && /child_process.*child-process/.test(v)), r.violations.join('\n'));
});

test('C23 a planted fetch in another providers file is caught by the tripwire (the scan is not a no-op here)', () => {
  const r = scanTree(repoRoot, { ...ALLOWLIST, [`${DIR}/http.ts`]: { kinds: [], reason: 'removed' } });
  assert.ok(r.violations.some((v) => v.startsWith(`${DIR}/http.ts:`) && /outbound network access/.test(v)));
});

test('the provider code registers no tool of its own (tool names come from the Legion modules)', () => {
  const r = scanTree(repoRoot);
  assert.equal(r.toolNames.some((n) => /provider/i.test(n)), false);
});
