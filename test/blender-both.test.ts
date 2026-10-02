/**
 * "Use both backends at once" (plan section 15): ports, identity checks, routing, the merged tool list, asset downloads, and "flag off = one backend".
 * Fakes only: two fake add-ons on distinct loopback ports (real sockets on 127.0.0.1, ephemeral ports), a fake MCP client for the official server,
 * a fake Poly Haven. Never touches the real BSV wallet port or any network.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BLENDER_ASSET_TOOL, DEFAULT_COMMUNITY_PORT, defaultBlenderConfig, normalizeBlender } from '../src/shared/blender.js';
import type { BlenderConfig } from '../src/shared/blender.js';
import { AssetError, assetDir, fetchPlan, importScript, planFromFiles, polyhavenUrlOk, PolyHavenAssets, safeRel } from '../src/core/blender/assets.js';
import type { AssetNet, AssetPlan, AssetPort, FetchResult } from '../src/core/blender/assets.js';
import { BothBackend, bothPorts, ensureFreePorts, ROUTING, verifyBoth } from '../src/core/blender/both.js';
import { CommunityBackend, COMMUNITY_EXTRAS } from '../src/core/blender/backends/community.js';
import { OfficialBackend } from '../src/core/blender/backends/official.js';
import type { McpLike, McpToolInfo } from '../src/core/blender/backends/official.js';
import { checkScript } from '../src/core/blender/static-check.js';
import { jsonRequest, tcpProbe } from '../src/core/blender/tcp.js';
import { agent, connectTools, GOOD_SCRIPT, rig } from './blender-helpers.js';
import type { Rig } from './blender-helpers.js';

// ---------------------------------------------------------------- fakes
interface Fake { port: number; seen: any[]; close(): Promise<void> }
const INFO = { name: 'MCP for Blender', addon_version: [1, 8], protocol_version: 13, capabilities: ['get_scene_info', 'execute_code'], blender_version: '5.2.2', premium_generators: [] };
const SCENE = { name: 'Scene', object_count: 1, objects: [{ name: 'Cube', type: 'MESH', location: [0, 0, 0] }], materials_count: 0 };
/** A listener on an ephemeral loopback port. kind 'community' answers like the add-on; 'impostor' answers with something else; 'silent' accepts and says nothing. */
async function listener(kind: 'community' | 'impostor' | 'silent', onReq: (r: any) => void = () => undefined): Promise<Fake> {
  const seen: any[] = [];
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => undefined);
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let req: any; try { req = JSON.parse(buf); } catch { return; }
      buf = ''; seen.push(req); onReq(req);
      if (kind === 'silent') return;
      if (kind === 'impostor') { s.write(JSON.stringify({ status: 'success', result: { hello: 'not blender' } })); return; }
      const t = req.type;
      const result = t === 'get_addon_info' ? INFO : t === 'get_scene_info' ? SCENE : t === 'execute_code' ? { executed: true, result: 'community ran' } : t === 'describe_node_type' ? { bl_idname: req.params.bl_idname, inputs: [] } : { ok: t };
      s.write(JSON.stringify({ status: 'success', result }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as net.AddressInfo).port, seen, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }) };
}
const freePort = async (): Promise<number> => { const f = await listener('silent'); const p = f.port; await f.close(); return p; };

const tool = (name: string, over: Partial<McpToolInfo> = {}): McpToolInfo => ({ name, description: `${name} tool`, annotations: { readOnlyHint: true }, inputSchema: { properties: {} }, ...over });
const OFFICIAL_TOOLS: McpToolInfo[] = [
  tool('execute_blender_code', { annotations: {}, inputSchema: { properties: { code: { type: 'string' } } } }),
  tool('get_objects_summary'), tool('get_object_detail_summary', { inputSchema: { properties: { name: { type: 'string' } } } }),
  tool('get_screenshot_of_window_as_image'), tool('search_api_docs', { inputSchema: { properties: { query: { type: 'string' } } } }),
  tool('list_render_engines'),
  tool('read_text_file', { inputSchema: { properties: { filepath: { type: 'string' } } } }),
  tool('fetch_remote_thing', { inputSchema: { properties: { url: { type: 'string' } } } }),
  tool('run_snippet', { inputSchema: { properties: { code: { type: 'string' } } } }),
  tool('delete_everything', { annotations: { destructiveHint: true } }),
];
function fakeOfficial(tools: McpToolInfo[] = OFFICIAL_TOOLS, calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []): OfficialBackend {
  const client: McpLike = {
    listTools: async () => ({ tools }),
    callTool: async (p) => { calls.push(p); return { content: [{ type: 'text', text: `official:${p.name}` }] }; },
    close: async () => undefined,
  };
  return new OfficialBackend({ host: '127.0.0.1', port: 1, entry: undefined, advanced: defaultBlenderConfig().advanced }, { connectClient: async () => client });
}
const deps = { probe: tcpProbe, request: jsonRequest };
const txt = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((c) => c.text ?? '').join('\n');

// ---------------------------------------------------------------- 1. ports
test('B17-1 ports: the community port defaults to 9877, must differ from the official port, and a clash fails closed with a plain message', () => {
  const c = defaultBlenderConfig();
  assert.equal(c.advanced.both.communityPort, DEFAULT_COMMUNITY_PORT);
  assert.deepEqual(bothPorts(c), { ok: true, ports: { official: 9876, community: 9877 } });
  const same = bothPorts({ ...c, advanced: { ...c.advanced, both: { communityPort: 9876 } } });
  assert.equal(same.ok, false);
  assert.match((same as { error: string }).error, /Both add-ons are set to port 9876\. Each needs its own port/);
  assert.equal(normalizeBlender({ advanced: { both: { communityPort: 80 } } }).advanced.both.communityPort, DEFAULT_COMMUNITY_PORT, 'a privileged or junk port falls back');
  assert.equal(normalizeBlender({ advanced: { both: { communityPort: 9900 } } }).advanced.both.communityPort, 9900);
});

test('B17-2 ensureFreePorts: a taken port (either one) stops the launch and names it; two free ports pass', async () => {
  const a = await listener('silent');
  const free = await freePort();
  const r1 = await ensureFreePorts('127.0.0.1', { official: a.port, community: free }, tcpProbe);
  assert.equal(r1.ok, false);
  assert.match((r1 as { error: string }).error, new RegExp(`Port ${a.port} \\(the official add-on\\) is already in use`));
  const r2 = await ensureFreePorts('127.0.0.1', { official: free, community: a.port }, tcpProbe);
  assert.match((r2 as { error: string }).error, /the community add-on/);
  assert.equal((await ensureFreePorts('127.0.0.1', { official: free, community: await freePort() }, tcpProbe)).ok, true);
  await a.close();
});

// ---------------------------------------------------------------- 2. identity
test('B17-3 verifyBoth: each port is identified; the community add-on on the official port, or an impostor on the community port, is "wrong"', async () => {
  const comm = await listener('community');
  const off = await listener('silent'); // stands in for the official add-on: accepts, does not speak the community protocol
  const good = await verifyBoth('127.0.0.1', { official: off.port, community: comm.port }, deps);
  assert.equal(good.community.state, 'ok');
  assert.equal(good.official.state, 'ok');

  const swapped = await verifyBoth('127.0.0.1', { official: comm.port, community: off.port }, deps);
  assert.equal(swapped.official.state, 'wrong', 'the community add-on answers on the official port');
  assert.match(swapped.official.note, /community add-on is answering on port/);
  assert.equal(swapped.community.state, 'wrong', 'a silent listener does not identify as the community add-on');

  const imp = await listener('impostor');
  const v = await verifyBoth('127.0.0.1', { official: off.port, community: imp.port }, deps);
  assert.equal(v.community.state, 'wrong');
  assert.match(v.community.note, /does not answer like the community add-on/);

  const down = await verifyBoth('127.0.0.1', { official: await freePort(), community: await freePort() }, deps);
  assert.equal(down.official.state, 'down');
  assert.equal(down.community.state, 'down');
  await Promise.all([comm.close(), off.close(), imp.close()]);
});

// ---------------------------------------------------------------- 3. the merged backend
async function bothRig(o: { community?: 'community' | 'impostor' | 'silent' | 'none'; tools?: McpToolInfo[]; calls?: Array<{ name: string; arguments?: Record<string, unknown> }> } = {}) {
  const comm = o.community === 'none' ? null : await listener(o.community ?? 'community');
  const officialAddon = await listener('silent');
  const cp = comm?.port ?? await freePort();
  const cfg: BlenderConfig = { ...defaultBlenderConfig(), enabled: true, both: true, port: officialAddon.port, advanced: { ...defaultBlenderConfig().advanced, both: { communityPort: cp } } };
  const second = new CommunityBackend({ host: '127.0.0.1', port: cp, advanced: cfg.advanced });
  const both = new BothBackend({ main: fakeOfficial(o.tools, o.calls), second, host: '127.0.0.1', ports: { official: officialAddon.port, community: cp }, ...deps });
  return { both, comm, officialAddon, cfg, close: async () => { await both.close(); await comm?.close(); await officialAddon.close(); } };
}

test('B17-4 routing: exec, inspect, screenshot and docs go to the MAIN (official) backend only; the second backend never receives code', async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const r = await bothRig({ calls });
  await r.both.connect();
  const ex = await r.both.exec('print(1)');
  assert.equal(ex.text, 'official:execute_blender_code');
  assert.deepEqual(calls[0], { name: 'execute_blender_code', arguments: { code: 'print(1)' } });
  assert.equal((await r.both.inspect({})).ok, true);
  assert.equal((await r.both.screenshot({})).ok, true);
  assert.equal((await r.both.docs('bpy.ops')).ok, true);
  assert.equal(r.comm!.seen.filter((q) => q.type === 'execute_code').length, 0, 'no execute_code ever reached the community add-on');
  assert.equal(r.both.kind, 'official');
  await r.close();
});

test('B17-5 connect fails closed (plain message) on a wrong backend, on either side; a community add-on that is just not running is not fatal', async () => {
  const imp = await bothRig({ community: 'impostor' });
  await assert.rejects(imp.both.connect(), /does not answer like the community add-on/);
  await imp.close();
  const none = await bothRig({ community: 'none' });
  await none.both.connect(); // official side still works
  const res = await none.both.callExtra('community:scene_snapshot', {});
  assert.equal(res.ok, false);
  assert.match(res.text, /Nothing is listening on port/);
  await none.close();
  // community add-on sitting on the official port
  const comm = await listener('community');
  const cfgPorts = { official: comm.port, community: await freePort() };
  const b = new BothBackend({ main: fakeOfficial(), second: new CommunityBackend({ host: '127.0.0.1', port: cfgPorts.community, advanced: defaultBlenderConfig().advanced }), host: '127.0.0.1', ports: cfgPorts, ...deps });
  await assert.rejects(b.connect(), /community add-on is answering on port .* OFFICIAL add-on's port/);
  await comm.close();
});

test('B17-6 merged list: official read-only extras plus community extras the main lacks; collisions hide the second backend\'s copy; unsafe official tools are not listed', async () => {
  const r = await bothRig();
  await r.both.connect();
  const names = r.both.catalog().map((t) => t.name);
  assert.ok(names.includes('official:list_render_engines'), 'a read-only official extra is listed');
  for (const hidden of ['execute_blender_code', 'run_snippet', 'read_text_file', 'fetch_remote_thing', 'delete_everything', 'get_objects_summary', 'search_api_docs']) {
    assert.ok(!names.includes(`official:${hidden}`), `${hidden} must not be offered as an extra`);
  }
  assert.ok(names.includes('community:node_type'));
  assert.ok(names.includes('community:scene_snapshot'));
  assert.ok(!names.includes('community:api_lookup'), 'the official server has search_api_docs, so the second copy is hidden');
  assert.ok(names.every((n) => /^(official|community):/.test(n)), 'every entry names its source');
  assert.ok(!names.some((n) => /execute|exec|code|export|download|polyhaven|sketchfab|hyper3d|telemetry|tripo/i.test(n)), 'no execution, export, download or premium tool is ever listed');
  await r.close();

  const r2 = await bothRig({ tools: [...OFFICIAL_TOOLS, tool('describe_node_type_schema')] });
  await r2.both.connect();
  assert.ok(!r2.both.catalog().some((t) => t.name === 'community:node_type'), 'a same-named capability on the main hides the second\'s tool');
  await r2.close();
});

test('B17-7 callExtra: only catalog names, arguments checked before anything is sent; the second backend is identified first', async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const r = await bothRig({ calls });
  await r.both.connect();
  assert.equal((await r.both.callExtra('community:node_type', { bl_idname: 'ShaderNodeBsdfPrincipled' })).ok, true);
  const types = r.comm!.seen.map((q) => q.type);
  assert.deepEqual(types.slice(-2), ['get_scene_info', 'describe_node_type'], 'identified, then the one fixed command');
  const before = r.comm!.seen.length;
  for (const bad of [{ bl_idname: 'x; import os' }, { bl_idname: '' }, {}, { bl_idname: 'A'.repeat(200) }]) {
    assert.equal((await r.both.callExtra('community:node_type', bad)).ok, false);
  }
  assert.equal(r.comm!.seen.length, before, 'bad arguments never reached the add-on');
  for (const n of ['community:execute_code', 'community:export_scene', 'community:download_polyhaven_asset', 'official:execute_blender_code', 'community:set_telemetry_consent', 'bogus']) {
    const res = await r.both.callExtra(n, {});
    assert.equal(res.ok, false, n);
    assert.match(res.text, /not in the tool list/);
  }
  assert.equal(r.comm!.seen.length, before);
  assert.equal((await r.both.callExtra('official:list_render_engines', {})).text, 'official:list_render_engines');
  assert.equal((await r.both.callExtra('official:list_render_engines', { bogus: 1 })).ok, false, 'unknown argument names are refused');
  assert.ok(!calls.some((c) => c.name === 'read_text_file' || c.name === 'run_snippet'));
  assert.deepEqual(COMMUNITY_EXTRAS.map((e) => e.command).sort(), ['bpy_api_lookup', 'describe_node_type', 'get_world_state_snapshot', 'list_scene_items']);
  await r.close();
});

// ---------------------------------------------------------------- 4. assets
const MD5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');
const MODEL_BIN = Buffer.from('BIN-DATA');
const MODEL_TEX = Buffer.from('JPEG-DATA');
const MODEL_GLTF = Buffer.from('{"asset":{"version":"2.0"}}');
const hdriFiles = (data: Buffer, url = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/sky_1k.hdr') => ({ hdri: { '1k': { hdr: { url, md5: MD5(data), size: data.length } } } });
const modelFiles = (over: Partial<Record<string, unknown>> = {}) => ({
  gltf: { '1k': { gltf: { url: 'https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/crate/crate_1k.gltf', md5: MD5(MODEL_GLTF), size: MODEL_GLTF.length,
    include: { 'crate.bin': { url: 'https://dl.polyhaven.org/x/crate.bin', md5: MD5(MODEL_BIN), size: MODEL_BIN.length }, 'textures/crate_diff_1k.jpg': { url: 'https://dl.polyhaven.org/x/diff.jpg', md5: MD5(MODEL_TEX), size: MODEL_TEX.length }, ...over } } } },
});

test('B17-8 asset plan: only allowed hosts, plain names, extension allowlist (no .blend, no scripts), per-file and total caps, md5 present', () => {
  const ok = planFromFiles('polyhaven', 'crate', 'models', '1k', modelFiles());
  assert.equal(ok.files.length, 3);
  assert.equal(ok.main, 'crate.gltf');
  assert.equal(ok.totalBytes, MODEL_GLTF.length + MODEL_BIN.length + MODEL_TEX.length);
  const bad: Array<[string, unknown, RegExp]> = [
    ['a .blend include', modelFiles({ 'x.blend': { url: 'https://dl.polyhaven.org/x.blend', md5: 'a'.repeat(32), size: 1 } }), /not allowed/],
    ['a .py include', modelFiles({ 'x.py': { url: 'https://dl.polyhaven.org/x.py', md5: 'a'.repeat(32), size: 1 } }), /not allowed/],
    ['traversal', modelFiles({ '../evil.bin': { url: 'https://dl.polyhaven.org/e.bin', md5: 'a'.repeat(32), size: 1 } }), /not allowed/],
    ['backslash', modelFiles({ 'a\\b.bin': { url: 'https://dl.polyhaven.org/e.bin', md5: 'a'.repeat(32), size: 1 } }), /not allowed/],
    ['absolute', modelFiles({ '/etc/x.bin': { url: 'https://dl.polyhaven.org/e.bin', md5: 'a'.repeat(32), size: 1 } }), /not allowed/],
    ['too deep', modelFiles({ 'a/b/c/d.bin': { url: 'https://dl.polyhaven.org/e.bin', md5: 'a'.repeat(32), size: 1 } }), /not allowed/],
    ['another host', modelFiles({ 'y.bin': { url: 'https://evil.example/y.bin', md5: 'a'.repeat(32), size: 1 } }), /address Legion does not accept/],
    ['a look-alike host', modelFiles({ 'y.bin': { url: 'https://polyhaven.org.evil.example/y.bin', md5: 'a'.repeat(32), size: 1 } }), /address Legion does not accept/],
    ['http', modelFiles({ 'y.bin': { url: 'http://dl.polyhaven.org/y.bin', md5: 'a'.repeat(32), size: 1 } }), /address Legion does not accept/],
    ['a huge file', modelFiles({ 'y.bin': { url: 'https://dl.polyhaven.org/y.bin', md5: 'a'.repeat(32), size: 99 * 1024 * 1024 } }), /limit per file/],
    ['no md5', modelFiles({ 'y.bin': { url: 'https://dl.polyhaven.org/y.bin', size: 1 } }), /missing its address, size or md5/],
    ['a bad md5', modelFiles({ 'y.bin': { url: 'https://dl.polyhaven.org/y.bin', md5: 'zz', size: 1 } }), /md5 .* not valid/],
  ];
  for (const [name, files, re] of bad) assert.throws(() => planFromFiles('polyhaven', 'crate', 'models', '1k', files), (e: Error) => e instanceof AssetError && re.test(e.message), name);
  // total cap: five 25 MB files
  const big = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`p${i}.bin`, { url: `https://dl.polyhaven.org/p${i}.bin`, md5: 'a'.repeat(32), size: 24 * 1024 * 1024 }]));
  assert.throws(() => planFromFiles('polyhaven', 'crate', 'models', '1k', modelFiles(big)), /total/);
  assert.equal(polyhavenUrlOk('https://api.polyhaven.com/files/x'), true);
  assert.equal(polyhavenUrlOk('https://user:pw@api.polyhaven.com/x'), false);
  assert.equal(polyhavenUrlOk('https://api.polyhaven.com:8443/x'), false);
  assert.equal(safeRel('textures/a.JPG'), true);
  assert.equal(safeRel('a.blend'), false);
});

function fakeNet(files: Record<string, Buffer>, log: string[] = []): AssetNet {
  return {
    getJson: async (url) => { log.push(`json ${url}`); return url.endsWith('/files/crate') ? modelFiles() : url.endsWith('/files/sky') ? hdriFiles(Buffer.from('HDR')) : { crate: { name: 'Crate', tags: ['wood'] } }; },
    download: async (url, dest, o) => {
      log.push(`download ${url}`);
      const data = files[url.split('/').pop()!]!;
      if (data.length > o.maxBytes) throw new Error('over the size limit');
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, data);
      return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
    },
  };
}
const FILES = { 'crate_1k.gltf': MODEL_GLTF, 'crate.bin': MODEL_BIN, 'diff.jpg': MODEL_TEX, 'sky_1k.hdr': Buffer.from('HDR') };

test('B17-9 fetchPlan: files land only in the per-task asset folder with sha256 recorded; an md5 mismatch removes everything', async () => {
  const dir = join(rig().dataDir, 'asset');
  const plan = planFromFiles('polyhaven', 'crate', 'models', '1k', modelFiles());
  const r = await fetchPlan(fakeNet(FILES), plan, dir, () => new Date('2026-10-02T00:00:00Z'));
  assert.equal(r.ok, true, r.problems.join(';'));
  assert.ok(existsSync(join(dir, 'crate.gltf')));
  assert.ok(existsSync(join(dir, 'textures', 'crate_diff_1k.jpg')));
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(m.files.length, 3);
  assert.match(m.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(m.files[0].bytes, MODEL_GLTF.length);
  assert.equal(existsSync(`${dir}.partial`), false);

  const dir2 = join(rig().dataDir, 'asset2');
  const tampered = fakeNet({ ...FILES, 'crate.bin': Buffer.from('EVIL-DATA') }); // same length, other bytes
  const r2 = await fetchPlan(tampered, plan, dir2);
  assert.equal(r2.ok, false);
  assert.match(r2.problems.join(' '), /does not match the md5/);
  assert.equal(existsSync(dir2), false, 'nothing is kept');
  assert.equal(existsSync(`${dir2}.partial`), false);
  // a download larger than announced is refused by the size cap
  const r3 = await fetchPlan(fakeNet({ ...FILES, 'crate.bin': Buffer.alloc(MODEL_BIN.length + 5000, 1) }), plan, join(rig().dataDir, 'asset3'));
  assert.equal(r3.ok, false);
});

test('B17-10 the fixed import scripts pass Legion\'s own static check with the asset folder as the only allowed folder, and carry only that path', () => {
  const dir = join(rig().dataDir, 'a');
  for (const [kind, id, main] of [['models', 'crate', 'crate.gltf'], ['hdris', 'sky', 'sky_1k.hdr']] as const) {
    const plan: AssetPlan = { source: 'polyhaven', id, kind, resolution: '1k', files: [], totalBytes: 0, main };
    const s = importScript(plan, dir);
    const c = checkScript(s, { allowedDirs: [dir], live: true });
    assert.equal(c.ok, true, `${kind}: ${JSON.stringify(c.ok ? [] : c.findings)}`);
    assert.ok(s.includes(JSON.stringify(join(dir, main))));
  }
});

class FakeAssets implements AssetPort {
  readonly sources = ['polyhaven'] as const;
  calls: string[] = [];
  fail: string | null = null;
  constructor(private readonly net: AssetNet = fakeNet(FILES)) {}
  private readonly real = () => new PolyHavenAssets(this.net, () => new Date('2026-10-02T00:00:00Z'));
  search(s: 'polyhaven', q: any) { this.calls.push('search'); return this.real().search(s, q); }
  plan(s: 'polyhaven', q: any) { this.calls.push('plan'); return this.real().plan(s, q); }
  async retrieve(plan: AssetPlan, dir: string): Promise<FetchResult> {
    this.calls.push('fetch');
    return this.fail ? { ok: false, problems: [this.fail] } : this.real().retrieve(plan, dir);
  }
}
class BothFake {
  execs: string[] = [];
  extras: string[] = [];
  kind = 'official' as const;
  async connect() { return undefined; }
  isConnected() { return true; }
  async exec(s: string) { this.execs.push(s); return { ok: true, text: 'imported ok', images: [] }; }
  async inspect() { return { ok: true, text: 'scene', images: [] }; }
  async screenshot() { return { ok: true, text: 'shot', images: [] }; }
  async docs() { return { ok: true, text: 'docs', images: [] }; }
  catalog() { return [{ name: 'community:node_type', source: 'community' as const, description: 'd', args: { bl_idname: 'x' } }]; }
  async callExtra(n: string) { this.extras.push(n); return { ok: true, text: `extra ${n}`, images: [] }; }
  async close() { return undefined; }
}
function assetRig(o: { both?: boolean; polyhaven?: boolean; assets?: FakeAssets } = {}): { r: Rig; fb: BothFake; assets: FakeAssets } {
  const assets = o.assets ?? new FakeAssets();
  const fb = new BothFake();
  const r = rig({ cfg: { both: o.both ?? true, ...(o.polyhaven === false ? {} : { assets: { polyhaven: true } }) }, extra: { assets, getBackend: async () => fb as any } });
  return { r, fb, assets };
}

test('B17-11 flag OFF: exactly the five original tools, no merged-list or asset tools, and the gates say why; flag ON adds the list tools; assets only with a source on', async () => {
  const off = assetRig({ both: false });
  const t0 = await connectTools(off.r);
  assert.deepEqual((await t0.tools()).sort(), ['blender_docs', 'blender_exec', 'blender_inspect', 'blender_screenshot', 'blender_status']);
  assert.match(txt(await off.r.guard.extraCall(agent(), off.r.job, { name: 'community:node_type' })), /Use both backends at once.*off/);
  assert.match(txt(await off.r.guard.assetGet(agent(), off.r.job, { source: 'polyhaven', id: 'crate', kind: 'models' })), /off/);
  assert.deepEqual(off.assets.calls, [], 'nothing was planned or fetched with the flag off');
  await t0.close();

  const on = assetRig({ both: true, polyhaven: false });
  const t1 = await connectTools(on.r);
  assert.deepEqual((await t1.tools()).sort(), ['blender_docs', 'blender_exec', 'blender_inspect', 'blender_screenshot', 'blender_status', 'blender_tool', 'blender_tools']);
  await t1.close();
  const withAssets = assetRig({ both: true, polyhaven: true });
  const t2 = await connectTools(withAssets.r);
  const names = await t2.tools();
  assert.ok(names.includes('blender_asset_search') && names.includes('blender_asset_get'));
  assert.ok(!names.some((n) => /execute|raw/.test(n)), 'no raw execute tool');
  await t2.close();
});

test('B17-12 merged list tools: blender_tools lists source:name entries, blender_tool calls only those, output is wrapped and taints the run', async () => {
  const x = assetRig();
  const t = await connectTools(x.r);
  const list = await t.call('blender_tools');
  assert.match(list.text, /community:node_type/);
  assert.match(list.text, /<blender-output source="live" untrusted="true">/);
  assert.ok(x.r.tainted.n > 0);
  x.r.tainted.n = 0;
  const call = await t.call('blender_tool', { name: 'community:node_type', args: { bl_idname: 'ShaderNodeMix' } });
  assert.match(call.text, /extra community:node_type/);
  assert.ok(x.r.tainted.n > 0);
  assert.deepEqual(x.fb.extras, ['community:node_type']);
  assert.equal((await t.call('blender_tool', { name: 'bogus', args: {} })).isError, true, 'schema refuses a name without a source');
  await t.close();
});

test('B17-13 asset get: card first (what, where from, how big), a denial fetches nothing; Allow writes the approved line BEFORE the download, taints, fetches once, imports with the fixed script, records files', async () => {
  const x = assetRig();
  x.r.decision.value = false;
  const t = await connectTools(x.r);
  const denied = await t.call('blender_asset_get', { source: 'polyhaven', id: 'crate', kind: 'models' });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /denied/);
  assert.deepEqual(x.assets.calls, ['plan'], 'only the read-only listing; no fetch');
  assert.equal(x.fb.execs.length, 0);
  assert.equal(x.r.cards.length, 1);
  assert.equal(x.r.cards[0]!.toolName, BLENDER_ASSET_TOOL);
  assert.match(x.r.cards[0]!.summary, /Poly Haven.*3 files.*dl\.polyhaven\.org.*never in your workspace.*md5.*No downloaded script is run/);
  assert.equal(x.r.cards[0]!.input.hosts && (x.r.cards[0]!.input.hosts as string[])[0], 'dl.polyhaven.org');

  x.r.decision.value = true;
  x.r.order.length = 0;
  const ok = await t.call('blender_asset_get', { source: 'polyhaven', id: 'crate', kind: 'models' });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(x.assets.calls, ['plan', 'plan', 'fetch']);
  assert.ok(x.r.tainted.n > 0, 'the run is tainted');
  assert.equal(x.fb.execs.length, 1);
  assert.match(x.fb.execs[0]!, /import_scene\.gltf/);
  assert.ok(x.fb.execs[0]!.includes(assetDir(x.r.dataDir, 'task_1', 'crate').split('\\').join('\\\\')) || x.fb.execs[0]!.includes(JSON.stringify(join(assetDir(x.r.dataDir, 'task_1', 'crate'), 'crate.gltf'))));
  assert.ok(existsSync(join(assetDir(x.r.dataDir, 'task_1', 'crate'), 'manifest.json')));
  assert.match(ok.text, /sha256 [0-9a-f]{12}\.\.\./);
  const audit = readFileSync(join(x.r.dataDir, 'blender', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const decisions = audit.filter((e) => e.tool === 'asset_get').map((e) => e.decision);
  assert.deepEqual(decisions, ['denied', 'approved', 'completed']);
  assert.ok(x.r.backups.length === 1, 'the open scene is backed up before the first import');
  await t.close();
});

test('B17-14 asset get: a failed download or md5 mismatch imports nothing but the run is STILL tainted; a switched-off or unsupported source is refused before any listing', async () => {
  const x = assetRig();
  x.assets.fail = 'md5 mismatch';
  const t = await connectTools(x.r);
  const res = await t.call('blender_asset_get', { source: 'polyhaven', id: 'crate', kind: 'models' });
  assert.equal(res.isError, true);
  assert.match(res.text, /not kept/);
  assert.equal(x.fb.execs.length, 0);
  assert.ok(x.r.tainted.n > 0);
  await t.close();

  const off = assetRig({ polyhaven: false });
  const g = off.r.guard;
  const refuse = await g.assetGet(agent(), off.r.job, { source: 'polyhaven', id: 'crate', kind: 'models' });
  assert.match(txt(refuse), /switched off in Settings/);
  const unsupported = await g.assetGet(agent(), off.r.job, { source: 'sketchfab', id: 'x', kind: 'models' });
  assert.match(txt(unsupported), /not a source Legion fetches/);
  assert.deepEqual(off.assets.calls, []);
  assert.equal(off.r.cards.length, 0);
});

test('B17-15 asset search: read-only, wrapped as outside content, taints, and needs the source switched on', async () => {
  const x = assetRig();
  const t = await connectTools(x.r);
  const res = await t.call('blender_asset_search', { kind: 'models', query: 'crate' });
  assert.match(res.text, /crate: Crate \[wood\]/);
  assert.match(res.text, /untrusted="true"/);
  assert.ok(x.r.tainted.n > 0);
  assert.equal(x.r.cards.length, 0, 'a listing needs no card');
  await t.close();
});

test('B17-16 settings and config: assets default OFF, only supported sources are accepted, flag defaults OFF', () => {
  const c = defaultBlenderConfig();
  assert.equal(c.both, undefined);
  assert.equal(c.assets, undefined);
  const n = normalizeBlender({ both: true, assets: { polyhaven: true, sketchfab: true, nonsense: true } });
  assert.equal(n.both, true);
  assert.deepEqual(n.assets, { polyhaven: true }, 'unsupported sources are dropped');
  assert.equal(normalizeBlender({ both: 'yes', assets: { polyhaven: 'yes' } }).both, undefined);
  assert.equal(normalizeBlender({ assets: { polyhaven: 'yes' } }).assets, undefined);
});

test('B17-17 the routing table: every row is in the plan and the docs, and the code-execution tools of the second backend are not in it', () => {
  const plan = readFileSync(join(process.cwd(), 'claude', 'plan-blender-local-first.md'), 'utf8');
  const docs = readFileSync(join(process.cwd(), 'docs', 'BLENDER.md'), 'utf8');
  for (const r of ROUTING) {
    assert.ok(plan.includes(`\`${r.tool}\``), `plan lists ${r.tool}`);
    assert.ok(docs.includes(`\`${r.tool}\``), `docs list ${r.tool}`);
  }
  assert.equal(ROUTING.filter((r) => r.backend === 'community' && /exec/i.test(r.tool)).length, 0);
  assert.equal(ROUTING.find((r) => r.tool === 'blender_exec')!.backend, 'official');
});
