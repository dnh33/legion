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
import { CommunityBackend, looksLikeAddon } from '../src/core/blender/backends/community.js';
import { OfficialBackend, resolveArg, resolveTool } from '../src/core/blender/backends/official.js';
import type { McpLike, McpToolInfo } from '../src/core/blender/backends/official.js';
import { jsonRequest, tcpProbe } from '../src/core/blender/tcp.js';

// ---------------------------------------------------------------------------------------------------------------- fake add-on socket
interface Fake { port: number; seen: any[]; /** requests other than the scene reads that double as the identity check */ sent(): any[]; close(): Promise<void>; handler: (req: any, write: (s: string) => void) => void }
const SCENE = { name: 'Scene', object_count: 1, objects: [{ name: 'Cube', type: 'MESH', location: [0, 0, 0] }], materials_count: 0 };
/** `identity: false` makes the fake answer the identity check (get_scene_info) with whatever its handler says, like an impostor. */
async function fakeAddon(handler: Fake['handler'], opts: { identity?: boolean; sceneCmd?: string } = {}): Promise<Fake> {
  const seen: any[] = [];
  const sceneCmd = opts.sceneCmd ?? 'get_scene_info';
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      try {
        const req = JSON.parse(buf); buf = ''; seen.push(req);
        if (opts.identity !== false && req.type === sceneCmd && !fake.rawScene) s.write(JSON.stringify({ status: 'success', result: SCENE }));
        else fake.handler(req, (x) => s.write(x));
      } catch { /* wait */ }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const fake: Fake & { rawScene?: boolean } = { port: (srv.address() as net.AddressInfo).port, seen, sent: () => seen.filter((r) => r.type !== sceneCmd), handler, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }) };
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
    assert.deepEqual(f.seen[0].type, 'get_scene_info', 'the add-on is identified before any code is sent');
    assert.deepEqual(f.sent()[0], { type: 'execute_code', params: { code: 'print("hello")' } });
    assert.equal(r.ok, true);
    assert.equal(r.text, 'hello\n');
    assert.equal(b.isConnected(), false, 'no standing connection: a connection exists only while a call runs');
  } finally { await f.close(); }
});

test('community: command names are config, not code', async () => {
  const f = await fakeAddon((req, w) => w(JSON.stringify({ status: 'success', result: { ok: 1 } })), { sceneCmd: 'scene' });
  try {
    const c = cfg(f.port);
    c.advanced.community.commands.exec = 'run_python';
    c.advanced.community.commands.inspect = 'scene';
    const b = new CommunityBackend(c);
    await b.exec('x = 1');
    await b.inspect({});
    assert.deepEqual(f.seen.map((r) => r.type), ['scene', 'run_python', 'scene']);
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
    const sc = await b.inspect({});
    assert.equal(f.seen[1].type, 'get_scene_info');
    assert.equal(sc.ok, true);
    assert.match(sc.text, /object_count/);
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
    assert.equal(f.sent()[0].params.max_size, 640);
    assert.ok(f.sent()[0].params.filepath.startsWith(dir));
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
  const r = await new CommunityBackend(cfg(port)).exec('1', { timeoutMs: 150 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true, 'a script that never answers is reported as timed out: it may still be running in Blender');
  assert.match(r.text, /STILL BE RUNNING/);
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
// the tool names of blender_mcp v1.0.3 (mcp/blmcp/tools/*.py); the read tools carry readOnlyHint there
const SERVER_TOOLS = ['execute_blender_code', 'execute_blender_code_for_cli', 'get_objects_summary', 'get_object_detail_summary', 'get_screenshot_of_window_as_image', 'search_api_docs'] as const;
const READ_ONLY = new Set<string>(['get_objects_summary', 'get_object_detail_summary', 'get_screenshot_of_window_as_image', 'search_api_docs']);

async function fakeOfficial(over: { tools?: string[]; calls?: any[]; failOnce?: boolean; readOnly?: (n: string) => boolean; schemas?: Record<string, z.ZodRawShape> } = {}) {
  const calls = over.calls ?? [];
  const names = new Set<string>(over.tools ?? SERVER_TOOLS);
  const launches: any[] = [];
  let connects = 0;
  const schemaOf = (n: string): z.ZodRawShape => over.schemas?.[n] ?? (n === 'get_objects_summary' ? {} : n === 'get_object_detail_summary' ? { name: z.string() } : n === 'get_screenshot_of_window_as_image' ? { size_limit_in_bytes: z.number().optional() } : n === 'search_api_docs' ? { query: z.string() } : n === 'execute_blender_code_for_cli' ? { blend_file: z.string(), code: z.string() } : { code: z.string() });
  const readOnly = over.readOnly ?? ((n: string) => READ_ONLY.has(n));
  const connectClient = async (launch: any): Promise<McpLike> => {
    connects++;
    const nth = connects;
    launches.push(launch);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const srv = new McpServer({ name: 'fake-blender', version: '1' });
    for (const n of names) {
      srv.registerTool(n, { inputSchema: schemaOf(n), annotations: readOnly(n) ? { readOnlyHint: true } : { destructiveHint: true } }, async (args: any) => {
        calls.push({ name: n, args });
        if (n === 'execute_blender_code') return { content: [{ type: 'text' as const, text: args.code.includes('boom') ? 'Traceback: boom' : 'ran: ' + args.code }], isError: args.code.includes('boom') };
        if (n === 'get_objects_summary') return { content: [{ type: 'text' as const, text: 'scene summary' }] };
        if (n === 'get_object_detail_summary') return { content: [{ type: 'text' as const, text: 'object ' + args.name }] };
        if (n === 'get_screenshot_of_window_as_image') return { content: [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }, { type: 'text' as const, text: 'shot' }] };
        if (n === 'search_api_docs') return { content: [{ type: 'text' as const, text: 'docs for ' + args.query }] };
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

test('official: the default tool names are the ones the v1.0.3 server has, and the card-free tools are called by those exact names', async () => {
  const f = await fakeOfficial();
  const b = new OfficialBackend(defaultBlenderConfig(), { connectClient: f.connectClient });
  const r = await b.exec('x = 2');
  assert.equal(r.text, 'ran: x = 2');
  assert.equal(f.calls[0].name, 'execute_blender_code');
  assert.match((await b.inspect({ object: 'Cube' })).text, /object Cube/);
  assert.equal(f.calls.at(-1).name, 'get_object_detail_summary');
  assert.match((await b.inspect({})).text, /scene summary/);
  assert.match((await b.docs('bpy.ops.mesh')).text, /docs for bpy.ops.mesh/);
  const s = await b.screenshot({ maxSize: 512 });
  assert.equal(s.images[0]!.data, 'AAAA');
  const shot = f.calls.find((x) => x.name === 'get_screenshot_of_window_as_image');
  assert.deepEqual(shot.args, {}, 'a pixel size is not sent as size_limit_in_bytes');
});

test('official: when the configured names are wrong, only read-only tools are picked by pattern (S4)', async () => {
  const f = await fakeOfficial();
  const c = defaultBlenderConfig();
  c.advanced.official.tools = { exec: 'nope_exec', execArg: 'code', inspect: 'nope_a', objectInfo: 'nope_b', screenshot: 'nope_c', docs: 'nope_d' };
  const b = new OfficialBackend(c, { connectClient: f.connectClient });
  assert.equal((await b.exec('x = 3')).text, 'ran: x = 3', 'the exec tool may still be found by its name pattern: it is only ever called after a card');
  assert.match((await b.docs('mesh')).text, /docs for mesh/);
  assert.equal((await b.screenshot({})).images.length, 1);
  // the same server without readOnlyHint on its read tools: nothing card-free is picked by guessing
  const g = await fakeOfficial({ readOnly: () => false });
  const b2 = new OfficialBackend(c, { connectClient: g.connectClient });
  assert.equal((await b2.exec('1')).ok, true);
  for (const r of [await b2.docs('x'), await b2.inspect({}), await b2.screenshot({})]) { assert.equal(r.ok, false); assert.match(r.text, /no tool for/); }
  assert.ok(g.calls.every((x) => x.name === 'execute_blender_code'), 'no card-free call reached any tool but the one exec call');
});

test('official: a card-free role never resolves to the exec tool, nor to a tool that takes code (S4)', async () => {
  // configured inspect name IS the exec tool
  const f = await fakeOfficial();
  const c = defaultBlenderConfig();
  c.advanced.official.tools.inspect = 'execute_blender_code';
  const b = new OfficialBackend(c, { connectClient: f.connectClient });
  const r = await b.inspect({});
  assert.equal(r.ok, false);
  assert.match(r.text, /no tool for "inspect"/);
  assert.ok(!f.calls.some((x) => x.name === 'execute_blender_code'), 'the code tool was not called as an inspect tool');
  // a read-only tool with a code argument is refused too, whatever it is called
  const g = await fakeOfficial({ schemas: { search_api_docs: { code: z.string() } } });
  const b2 = new OfficialBackend(defaultBlenderConfig(), { connectClient: g.connectClient });
  const d = await b2.docs('x');
  assert.equal(d.ok, false);
  assert.match(d.text, /no tool for "docs"/);
});

test('official: isError results are failures; images and text are split', async () => {
  const f = await fakeOfficial();
  const b = new OfficialBackend(defaultBlenderConfig(), { connectClient: f.connectClient });
  const r = await b.exec('boom');
  assert.equal(r.ok, false);
  assert.match(r.text, /Traceback/);
});

test('official: no execute tool means the backend refuses to connect', async () => {
  const f = await fakeOfficial({ tools: ['get_objects_summary', 'search_api_docs'] });
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
  assert.deepEqual(f.launches[0], { command: 'uv', args: ['run', '--project', '/srv/bl', 'x', '--port', '9911', '--host', '127.0.0.1'], env: { BLENDER_MCP_HOST: '127.0.0.1', BLENDER_MCP_PORT: '9911', A: 'b' } });
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
  const ro = (name: string, props?: Record<string, { type: string }>): McpToolInfo => ({ name, inputSchema: { properties: props }, annotations: { readOnlyHint: true } });
  assert.equal(resolveTool('screenshot', [ro('viewport_screenshot_cli'), ro('area_screenshot')], 'x'), 'area_screenshot');
  assert.equal(resolveTool('screenshot', [t('viewport_screenshot_cli'), t('area_screenshot')], 'x'), undefined, 'a pattern match needs readOnlyHint');
  assert.equal(resolveTool('screenshot', [t('shot')], 'shot'), 'shot', 'the exact configured name needs no hint');
  assert.equal(resolveTool('inspect', [ro('scene_info')], 'scene_info', 'scene_info'), undefined, 'never the exec tool');
  assert.equal(resolveTool('docs', [ro('search_docs', { script: { type: 'string' } })], 'search_docs'), undefined, 'never a tool with a code argument');
  assert.equal(resolveArg(t('x', { code: { type: 'string' } }), 'code'), 'code');
  assert.equal(resolveArg(t('x', { script: { type: 'string' }, n: { type: 'number' } }), 'code'), 'script');
  assert.equal(resolveArg(t('x'), 'code'), 'code');
  // a card-free role never prefers a code-like argument, even when it is the only string
  assert.equal(resolveArg(t('x', { code: { type: 'string' }, query: { type: 'string' } }), 'zzz', 'docs'), 'query');
  assert.equal(resolveArg(t('x', { code: { type: 'string' } }), 'query', 'docs'), 'query');
  assert.equal(resolveArg(t('x', { script: { type: 'string' } }), 'name', 'objectInfo'), 'name');
});

test('community: a listener that does not identify itself as the add-on gets no code (B3)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-bl-shot-'));
  const f = await fakeAddon((req, w) => w(JSON.stringify({ status: 'success', result: { executed: true, result: 'pwned' } })), { identity: false });
  try {
    const b = new CommunityBackend(cfg(f.port), { tempDir: dir });
    await assert.rejects(b.exec('print(1)'), /did not identify itself as the Blender add-on/);
    await assert.rejects(b.screenshot({}), /did not identify itself/);
    const i = await b.inspect({});
    assert.equal(i.ok, false);
    assert.match(i.text, /not the Blender add-on/);
    assert.ok(f.seen.every((r) => r.type === 'get_scene_info'), 'only identity probes were sent; no code, no screenshot path: ' + JSON.stringify(f.seen.map((r) => r.type)));
    assert.equal(b.isConnected(), false);
  } finally { await f.close(); }
});

test('looksLikeAddon: the shape of the upstream scene reply', () => {
  assert.equal(looksLikeAddon(SCENE), true);
  assert.equal(looksLikeAddon({ name: 'x' }), false);
  assert.equal(looksLikeAddon({ object_count: '1', objects: [] }), false);
  assert.equal(looksLikeAddon('hello'), false);
  assert.equal(looksLikeAddon(null), false);
});
