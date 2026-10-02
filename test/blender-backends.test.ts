import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { defaultBlenderConfig } from '../src/shared/blender.js';
import { CommunityBackend } from '../src/core/blender/backends/community.js';
import { OfficialBackend, resolveArg, resolveTool } from '../src/core/blender/backends/official.js';
import type { McpLike, McpToolInfo } from '../src/core/blender/backends/official.js';
import { jsonRequest, tcpProbe } from '../src/core/blender/tcp.js';

// ---------------------------------------------------------------------------------------------------------------- fake add-on socket
interface Fake { port: number; seen: any[]; close(): Promise<void>; handler: (req: any, write: (s: string) => void) => void }
async function fakeAddon(handler: Fake['handler']): Promise<Fake> {
  const seen: any[] = [];
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      try { const req = JSON.parse(buf); buf = ''; seen.push(req); fake.handler(req, (x) => s.write(x)); } catch { /* wait */ }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const fake: Fake = { port: (srv.address() as net.AddressInfo).port, seen, handler, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }) };
  return fake;
}
const cfg = (port: number) => ({ ...defaultBlenderConfig(), port });

test('tcpProbe: open port true, closed port false, non-loopback refused without connecting', async () => {
  const f = await fakeAddon(() => undefined);
  assert.equal(await tcpProbe('127.0.0.1', f.port), true);
  await f.close();
  assert.equal(await tcpProbe('127.0.0.1', f.port), false);
  assert.equal(await tcpProbe('10.255.255.1', 9876, 100), false);
  await assert.rejects(jsonRequest('10.0.0.5', 9876, {}, { timeoutMs: 100 }), /only talks to this computer/);
});

test('community: exec sends {"type","params":{"code"}} and returns the captured output', async () => {
  const f = await fakeAddon((req, w) => w(JSON.stringify({ status: 'success', result: { executed: true, result: 'hello\n' } })));
  try {
    const b = new CommunityBackend(cfg(f.port));
    const r = await b.exec('print("hello")');
    assert.deepEqual(f.seen[0], { type: 'execute_code', params: { code: 'print("hello")' } });
    assert.equal(r.ok, true);
    assert.equal(r.text, 'hello\n');
    assert.equal(b.isConnected(), true);
  } finally { await f.close(); }
});

test('community: command names are config, not code', async () => {
  const f = await fakeAddon((req, w) => w(JSON.stringify({ status: 'success', result: { ok: 1 } })));
  try {
    const c = cfg(f.port);
    c.advanced.community.commands.exec = 'run_python';
    c.advanced.community.commands.inspect = 'scene';
    const b = new CommunityBackend(c);
    await b.exec('x = 1');
    await b.inspect({});
    assert.deepEqual(f.seen.map((r) => r.type), ['run_python', 'scene']);
  } finally { await f.close(); }
});

test('community: an error reply is a failed result, not an exception', async () => {
  const f = await fakeAddon((req, w) => w(JSON.stringify({ status: 'error', message: 'NameError: name x is not defined' })));
  try {
    const r = await new CommunityBackend(cfg(f.port)).exec('x');
    assert.equal(r.ok, false);
    assert.match(r.text, /NameError/);
  } finally { await f.close(); }
});

test('community: a reply that arrives in pieces is reassembled', async () => {
  const f = await fakeAddon((req, w) => {
    const all = JSON.stringify({ status: 'success', result: { executed: true, result: 'x'.repeat(5000) } });
    w(all.slice(0, 100));
    setTimeout(() => w(all.slice(100, 3000)), 20);
    setTimeout(() => w(all.slice(3000)), 40);
  });
  try {
    const r = await new CommunityBackend(cfg(f.port)).exec('1');
    assert.equal(r.text.length, 5000);
  } finally { await f.close(); }
});

test('community: inspect with an object name asks for object info', async () => {
  const f = await fakeAddon((req, w) => w(JSON.stringify({ status: 'success', result: { name: req.params.name ?? 'scene' } })));
  try {
    const b = new CommunityBackend(cfg(f.port));
    const a = await b.inspect({ object: 'Cube' });
    assert.deepEqual(f.seen[0], { type: 'get_object_info', params: { name: 'Cube' } });
    assert.match(a.text, /Cube/);
    await b.inspect({});
    assert.equal(f.seen[1].type, 'get_scene_info');
  } finally { await f.close(); }
});

test('community: screenshot asks Blender to write a PNG, reads it back as base64 and deletes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-bl-shot-'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const f = await fakeAddon((req, w) => { writeFileSync(req.params.filepath, png); w(JSON.stringify({ status: 'success', result: { success: true, width: 640, height: 360 } })); });
  try {
    const r = await new CommunityBackend(cfg(f.port), { tempDir: dir }).screenshot({ maxSize: 640 });
    assert.equal(r.ok, true);
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0]!.mime, 'image/png');
    assert.deepEqual(Buffer.from(r.images[0]!.data, 'base64'), png);
    assert.equal(f.seen[0].params.max_size, 640);
    assert.ok(f.seen[0].params.filepath.startsWith(dir));
    assert.deepEqual(readdirSync(dir), [], 'temp file removed');
    assert.match(r.text, /640x360/);
  } finally { await f.close(); }
});

test('community: screenshot where Blender wrote nothing is a failure', async () => {
  const f = await fakeAddon((req, w) => w(JSON.stringify({ status: 'success', result: {} })));
  try {
    const r = await new CommunityBackend(cfg(f.port), { tempDir: mkdtempSync(join(tmpdir(), 'legion-bl-shot-')) }).screenshot({});
    assert.equal(r.ok, false);
  } finally { await f.close(); }
});

test('community: connection refused gives a plain instruction; a silent Blender times out; docs say they need the official backend', async () => {
  const f = await fakeAddon(() => undefined);
  const port = f.port;
  const b = new CommunityBackend(cfg(port));
  await assert.rejects(new CommunityBackend(cfg(port)).exec('1', { timeoutMs: 150 }), /did not answer within|Blender did not answer/);
  await f.close();
  await assert.rejects(b.connect(), /Cannot reach the Blender add-on/);
  assert.equal(b.isConnected(), false);
  const d = await b.docs('mesh');
  assert.equal(d.ok, false);
  assert.match(d.text, /official/);
});

test('community: a reply over the size limit is cut off', async () => {
  const f = await fakeAddon((req, w) => w('{"status":"success","result":"' + 'x'.repeat(2000)));
  try {
    await assert.rejects(jsonRequest('127.0.0.1', f.port, { type: 'x' }, { timeoutMs: 1000, maxBytes: 1000 }), /larger than the limit/);
  } finally { await f.close(); }
});

// ---------------------------------------------------------------------------------------------------------------- official (MCP)
const SERVER_TOOLS = ['execute_blender_code', 'execute_blender_code_for_cli', 'get_scene_info', 'get_viewport_screenshot', 'search_docs'] as const;

async function fakeOfficial(over: { tools?: string[]; calls?: any[]; failOnce?: boolean } = {}) {
  const calls = over.calls ?? [];
  const names = new Set<string>(over.tools ?? SERVER_TOOLS);
  const launches: any[] = [];
  let connects = 0;
  const schemaOf = (n: string): z.ZodRawShape => (n === 'get_scene_info' ? { object_name: z.string().optional() } : n === 'get_viewport_screenshot' ? { max_size: z.number().optional() } : n === 'search_docs' ? { q: z.string() } : { code: z.string() });
  const connectClient = async (launch: any): Promise<McpLike> => {
    connects++;
    const nth = connects;
    launches.push(launch);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const srv = new McpServer({ name: 'fake-blender', version: '1' });
    for (const n of names) {
      srv.registerTool(n, { inputSchema: schemaOf(n) }, async (args: any) => {
        calls.push({ name: n, args });
        if (n === 'execute_blender_code') return { content: [{ type: 'text' as const, text: args.code.includes('boom') ? 'Traceback: boom' : 'ran: ' + args.code }], isError: args.code.includes('boom') };
        if (n === 'get_scene_info') return { content: [{ type: 'text' as const, text: 'scene ' + (args.object_name ?? '*') }] };
        if (n === 'get_viewport_screenshot') return { content: [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }, { type: 'text' as const, text: 'shot' }] };
        if (n === 'search_docs') return { content: [{ type: 'text' as const, text: 'docs for ' + args.q }] };
        return { content: [{ type: 'text' as const, text: 'CLI' }] };
      });
    }
    await srv.connect(b);
    const client = new Client({ name: 'legion-blender', version: '1' }, { capabilities: {} });
    await client.connect(a);
    if (over.failOnce && nth === 1) {
      return { listTools: () => client.listTools() as any, callTool: async () => { throw new Error('server died'); }, close: () => client.close() };
    }
    return client as unknown as McpLike;
  };
  return { calls, launches, connectClient, connects: () => connects };
}

test('official: connects, resolves tools by configured name, never uses the _for_cli variant', async () => {
  const f = await fakeOfficial();
  const c = defaultBlenderConfig();
  c.advanced.official.tools = { exec: 'execute_blender_code', execArg: 'code', inspect: 'get_scene_info', screenshot: 'get_viewport_screenshot', docs: 'search_docs' };
  const b = new OfficialBackend(c, { connectClient: f.connectClient });
  assert.equal(b.isConnected(), false);
  const r = await b.exec('print(1)');
  assert.equal(r.text, 'ran: print(1)');
  assert.equal(r.ok, true);
  assert.equal(b.isConnected(), true);
  assert.deepEqual(b.toolNames().sort(), [...SERVER_TOOLS].sort());
  assert.equal(f.calls[0].name, 'execute_blender_code');
  assert.ok(f.calls.every((x) => !x.name.endsWith('_for_cli')));
  await b.close();
  assert.equal(b.isConnected(), false);
});

test('official: when the configured names are wrong, patterns find the real tools (and skip CLI variants)', async () => {
  const f = await fakeOfficial();
  const b = new OfficialBackend(defaultBlenderConfig(), { connectClient: f.connectClient }); // defaults: execute_python / get_scene_info ...
  const r = await b.exec('x = 2');
  assert.equal(r.text, 'ran: x = 2');
  assert.equal(f.calls[0].name, 'execute_blender_code');
  assert.match((await b.inspect({ object: 'Cube' })).text, /scene Cube/);
  assert.match((await b.docs('bpy.ops.mesh')).text, /docs for bpy.ops.mesh/, 'argument name found from the schema');
  const s = await b.screenshot({ maxSize: 512 });
  assert.equal(s.images[0]!.data, 'AAAA');
  assert.equal(f.calls.find((x) => x.name === 'get_viewport_screenshot').args.max_size, 512);
});

test('official: isError results are failures; images and text are split', async () => {
  const f = await fakeOfficial();
  const b = new OfficialBackend(defaultBlenderConfig(), { connectClient: f.connectClient });
  const r = await b.exec('boom');
  assert.equal(r.ok, false);
  assert.match(r.text, /Traceback/);
});

test('official: no execute tool means the backend refuses to connect', async () => {
  const f = await fakeOfficial({ tools: ['get_scene_info', 'search_docs'] });
  const b = new OfficialBackend(defaultBlenderConfig(), { connectClient: f.connectClient });
  await assert.rejects(b.connect(), /no code-execution tool/);
  assert.equal(b.isConnected(), false);
});

test('official: a missing optional tool is reported by the call that needs it', async () => {
  const f = await fakeOfficial({ tools: ['execute_blender_code'] });
  const b = new OfficialBackend(defaultBlenderConfig(), { connectClient: f.connectClient });
  const r = await b.docs('x');
  assert.equal(r.ok, false);
  assert.match(r.text, /no tool for "docs"/);
});

test('official: the launch command comes from the entry when Setup wrote one, with {host} {port} {serverDir} filled in', async () => {
  const f = await fakeOfficial();
  const c = defaultBlenderConfig();
  c.port = 9911;
  c.entry = { command: 'uv', args: ['run', '--project', '{serverDir}', 'x', '--port', '{port}', '--host', '{host}'], env: { A: 'b' }, serverDir: '/srv/bl', at: '' };
  await new OfficialBackend(c, { connectClient: f.connectClient }).connect();
  assert.deepEqual(f.launches[0], { command: 'uv', args: ['run', '--project', '/srv/bl', 'x', '--port', '9911', '--host', '127.0.0.1'], env: { A: 'b' } });
  const d = defaultBlenderConfig();
  const g = await fakeOfficial();
  await new OfficialBackend(d, { connectClient: g.connectClient }).connect();
  assert.equal(g.launches[0].command, 'uv', 'falls back to advanced.official.command');
});

test('official: a call that throws drops the connection so the next call reconnects', async () => {
  const f = await fakeOfficial({ failOnce: true });
  const b = new OfficialBackend(defaultBlenderConfig(), { connectClient: f.connectClient });
  const first = await b.exec('1');
  assert.equal(first.ok, false);
  assert.equal(b.isConnected(), false);
  const second = await b.exec('2');
  assert.equal(second.ok, true);
  assert.equal(f.connects(), 2);
});

test('resolveTool and resolveArg', () => {
  const t = (name: string, props?: Record<string, { type: string }>): McpToolInfo => ({ name, inputSchema: { properties: props } });
  assert.equal(resolveTool('exec', [t('a'), t('run_python_code'), t('x')], 'nope'), 'run_python_code');
  assert.equal(resolveTool('exec', [t('run_python_for_cli'), t('x')], 'nope'), undefined);
  assert.equal(resolveTool('exec', [t('run_python_for_cli'), t('execute_python')], 'execute_python'), 'execute_python');
  assert.equal(resolveTool('screenshot', [t('viewport_screenshot_cli'), t('area_screenshot')], 'x'), 'area_screenshot');
  assert.equal(resolveArg(t('x', { code: { type: 'string' } }), 'code'), 'code');
  assert.equal(resolveArg(t('x', { script: { type: 'string' }, n: { type: 'number' } }), 'code'), 'script');
  assert.equal(resolveArg(t('x'), 'code'), 'code');
});
