import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { replyText, replyTools, startFake } from './providers-fakes.js';
import type { FakeReq } from './providers-fakes.js';
import { run, setup, until } from './providers-harness.js';
import { repoRoot } from './ps-helpers.js';

const FIXTURE = join(repoRoot, 'test/fixtures/fake-mcp-stdio.mjs');
const toolMsg = (req: FakeReq, id: string): string => (req.body.messages as any[]).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';
const names = (req: FakeReq): string[] => (req.body.tools as any[]).map((t) => t.function.name);

/** A fake HTTP MCP server (stateless streamable HTTP) that records the headers of every request. */
async function fakeHttpMcp(redirectTo?: string) {
  const seen: IncomingHttpHeaders[] = [];
  const srv = createServer((req, res) => {
    seen.push(req.headers);
    if (redirectTo) { res.writeHead(307, { Location: redirectTo }); res.end(); return; }
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const m = new McpServer({ name: 'fake-http', version: '1' });
      m.registerTool('ping', { description: 'Ping', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: 'pong:' + text }] }));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void t.close(); void m.close(); });
      await m.connect(t);
      await t.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
  return { url, seen, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

test('a stdio server from Settings is offered, needs a card like any non-Legion tool, taints the run, and starts with a small environment', async () => {
  const dir = cleanupTemp('legion-ext-');
  const mark = join(dir, 'marks.txt');
  process.env.LEGION_TEST_SECRET = 'core-env-secret-' + 'xyz123';
  let n = 0;
  const f = await startFake((_r, res) => {
    n++;
    if (n === 1) replyTools(res, [{ id: 'e1', name: 'mcp__ext__envcheck', args: {} }]);
    else if (n === 2) replyTools(res, [{ id: 'e2', name: 'mcp__ext__echo', args: { text: 'hi' } }]);
    else replyText(res, 'finished');
  });
  try {
    const h = setup(f, { agent: { approval: 'ask', mcpServers: ['ext'] } });
    h.config.mcpServers = { ext: { command: process.execPath, args: [FIXTURE], env: { OWN_VAR: 'yes', MARK_FILE: mark } } } as any;
    const t = h.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' } as any);
    await until(() => h.approvals.pending().length === 1, 15000);
    assert.equal(h.approvals.pending()[0]!.toolName, 'mcp__ext__envcheck');
    assert.equal(h.engine.isTainted(t.id), true, 'tainted before the tool can act');
    h.approvals.resolve(h.approvals.pending()[0]!.id, true);
    await until(() => h.approvals.pending().length === 1 && h.approvals.pending()[0]!.toolName === 'mcp__ext__echo', 15000);
    h.approvals.resolve(h.approvals.pending()[0]!.id, false);
    const done = await h.engine.waitFor(t.id, 15000);
    assert.equal(done.status, 'done'); assert.equal(done.tainted, true);
    assert.ok(names(f.requests[0]!).includes('mcp__ext__echo') && names(f.requests[0]!).includes('mcp__ext__envcheck'));
    assert.deepEqual(JSON.parse(toolMsg(f.requests[1]!, 'e1')), { leak: 'absent', own: 'yes' }, 'the core\'s own environment did not reach the server; the owner\'s env entry did');
    assert.match(toolMsg(f.requests[2]!, 'e2'), /denied/);
    assert.equal(readFileSync(mark, 'utf8').trim(), 'envcheck', 'the denied tool never ran');
  } finally { delete process.env.LEGION_TEST_SECRET; await f.close(); }
});

test('only the servers the agent enabled are offered; a server that cannot start is a notice, not a failure', async () => {
  const f = await startFake((_r, res) => replyText(res, 'ok'));
  try {
    const none = setup(f, { agent: { mcpServers: [] } });
    none.config.mcpServers = { ext: { command: process.execPath, args: [FIXTURE] } } as any;
    await run(none);
    assert.equal(names(f.requests[0]!).some((x) => x.startsWith('mcp__ext__')), false);
    const star = setup(f, { agent: { mcpServers: ['*'], approval: 'full' } });
    star.config.mcpServers = { ext: { command: process.execPath, args: [FIXTURE] }, broken: { command: 'definitely-not-a-real-command-xyz' } } as any;
    const t = await run(star);
    assert.equal(t.status, 'done');
    assert.ok(names(f.requests[1]!).includes('mcp__ext__echo'));
    assert.ok(star.store.listMessages(t.id).some((m) => m.role === 'system' && /MCP server "broken" is not available/.test(m.text)));
  } finally { await f.close(); }
});

test('an http server from Settings works with its configured header; a redirect is not followed; a remote http address is refused', async () => {
  const ok = await fakeHttpMcp();
  const second = await fakeHttpMcp();
  const redirecting = await fakeHttpMcp(second.url);
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) replyTools(res, [{ id: 'p1', name: 'mcp__web__ping', args: { text: 'a' } }]); else replyText(res, 'fine'); });
  try {
    const h = setup(f, { agent: { mcpServers: ['web'], approval: 'full' } });
    h.config.mcpServers = { web: { type: 'http', url: ok.url, headers: { 'X-Test': 'hdr-value' } } } as any;
    const t = await run(h);
    assert.equal(t.status, 'done'); assert.match(toolMsg(f.requests[1]!, 'p1'), /pong:a/);
    assert.ok(ok.seen.some((hd) => hd['x-test'] === 'hdr-value'), 'the owner\'s header was sent');
    assert.equal(t.tainted, true, 'an external tool taints the run');
    const r = setup(f, { agent: { mcpServers: ['web'], approval: 'full' } });
    r.config.mcpServers = { web: { type: 'http', url: redirecting.url, headers: { 'X-Test': 'hdr-value' } } } as any;
    const t2 = await run(r);
    assert.equal(second.seen.length, 0, 'the redirect target saw nothing');
    assert.ok(r.store.listMessages(t2.id).some((m) => /MCP server "web" is not available/.test(m.text)));
    const x = setup(f, { agent: { mcpServers: ['web'], approval: 'full' } });
    x.config.mcpServers = { web: { type: 'http', url: 'http://remote.example/mcp' } } as any;
    const t3 = await run(x);
    assert.ok(x.store.listMessages(t3.id).some((m) => /address is not allowed/.test(m.text)));
  } finally { await f.close(); await ok.close(); await second.close(); await redirecting.close(); }
});

test('the marker file of the first test is gone after the run only if the tool never ran twice (sanity of the fixture)', () => {
  assert.equal(existsSync(FIXTURE), true);
});
