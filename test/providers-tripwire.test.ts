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
  assert.deepEqual(listed.sort(), [`${DIR}/external-mcp.ts`, `${DIR}/http.ts`]);
  assert.deepEqual(ALLOWLIST[`${DIR}/http.ts`]!.kinds, ['fetch']);
  const r = scanTree(repoRoot);
  assert.deepEqual(r.violations, []);
  assert.ok(r.files.includes(`${DIR}/http.ts`));
  assert.ok(r.matchedAllow.includes(`${DIR}/http.ts#fetch`));
});

test('C23 no providers file spawns a process, imports a socket module, or names a non-loopback address in the one file that may fetch', () => {
  for (const f of files) {
    const text = readFileSync(join(repoRoot, f), 'utf8');
    assert.doesNotMatch(text, /child_process|node:net|node:tls|node:http['"]|node:https|node:dns|undici|\baxios\b/, f);
    if (f !== `${DIR}/http.ts` && f !== `${DIR}/external-mcp.ts`) assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/, f);
  }
  const http = readFileSync(join(repoRoot, `${DIR}/http.ts`), 'utf8');
  for (const m of http.matchAll(/https?:\/\/([^\/'"`\s:${}]+)/g)) assert.match(m[1]!, /^(?:127\.0\.0\.1|localhost|\[::1\])$/, `non-loopback host in http.ts: ${m[1]}`);
});

test('C23 only external-mcp.ts imports an MCP transport (stdio, http, sse): that file is the one place a configured command may start or a configured server be reached', () => {
  for (const f of files) {
    const t = readFileSync(join(repoRoot, f), 'utf8');
    if (f === `${DIR}/external-mcp.ts`) { assert.match(t, /client\/stdio\.js/); continue; }
    assert.doesNotMatch(t, /client\/(?:stdio|sse|streamableHttp)\.js/, f);
  }
});

test('C23 a planted fetch in another providers file is caught by the tripwire (the scan is not a no-op here)', () => {
  const r = scanTree(repoRoot, { ...ALLOWLIST, [`${DIR}/http.ts`]: { kinds: [], reason: 'removed' } });
  assert.ok(r.violations.some((v) => v.startsWith(`${DIR}/http.ts:`) && /outbound network access/.test(v)));
});

test('the provider code registers no tool of its own (tool names come from the Legion modules)', () => {
  const r = scanTree(repoRoot);
  assert.equal(r.toolNames.some((n) => /provider/i.test(n)), false);
});
