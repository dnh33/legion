/**
 * Perf round L, core half (docs: /home/claude/council/perf/core-kg.md): search ranks before it builds snippets, the seeder skips the dry run
 * for nodes it will not write and batches its writes under one lock, SSE backpressure, kg.* events are admin-only (B2),
 * Export-all then Import does not duplicate the BSV pack (B1), compact persistence, no task result in the /api/state list.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { Graph } from '../src/core/kg/graph.js';
import { applySeedPack, loadBsvSeed } from '../src/core/kg/seed.js';
import { exportVault, importVault } from '../src/core/kg/vault.js';
import { makeSnippet, oneLine, tokenize } from '../src/core/kg/text.js';
import { SYSTEM } from '../src/core/kg/types.js';
import type { KgNode } from '../src/shared/kg.js';
import { HUMAN, mkGraph, note, tmpDir } from './kg-helpers.js';
import { closeAll, mount } from './token-harness.js';
import { AUTH, asClient } from './helpers-c.js';
import { pushSse, SSE_MAX_BUFFER } from '../src/core/sse.js';

after(closeAll);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const syncFs = (): void => syncBuiltinESMExports();

// ------------------------------------------------------------------ P4: search ranks first, snippets only for the page

function words(i: number): string {
  const vocab = ['wallet', 'lesson', 'script', 'fee', 'chain', 'key', 'node', 'proof', 'merkle', 'spv', 'block', 'header'];
  return Array.from({ length: 30 + (i % 17) }, (_, k) => vocab[(i * 7 + k * 3) % vocab.length]! + (k % 5 === 0 ? ` w${i % 9}` : '')).join(' ');
}

test('P4: search builds the snippet of the returned page only, and the page is exactly what a full ranking would return', () => {
  const { g } = mkGraph();
  for (let i = 0; i < 120; i++) g.upsertNode(HUMAN, { title: `Note ${i} ${i % 3 === 0 ? 'wallet' : 'chain'}`, body: words(i), tags: i % 4 === 0 ? ['bsv'] : [] });
  // count reads of `body` on every stored node: the snippet is the only reader of a hit's body
  const store = (g as unknown as { nodes: Map<string, KgNode> }).nodes;
  let reads = 0;
  for (const n of store.values()) { const b = n.body; Object.defineProperty(n, 'body', { get() { reads++; return b; }, configurable: true }); }
  for (const q of ['wallet', 'wallet chain', 'merkle proof spv', 'zzzz-nothing']) {
    const full = g.search(HUMAN, q, { limit: 50 });
    reads = 0;
    const page = g.search(HUMAN, q, { limit: 5 });
    assert.ok(reads <= page.length, `"${q}": ${reads} body reads for ${page.length} hits (only the page needs a snippet)`);
    assert.deepEqual(page, full.slice(0, 5), `"${q}": the page is the head of the full ranking`);
    // order: score desc, then newest, then id
    for (let i = 1; i < full.length; i++) {
      const a = full[i - 1]!, b = full[i]!;
      assert.ok(a.score > b.score || (a.score === b.score && (a.node.updatedAt > b.node.updatedAt || (a.node.updatedAt === b.node.updatedAt && a.node.id < b.node.id))), `order at ${i}`);
    }
    const toks = [...new Set(tokenize(q))];
    for (const h of full) {
      const n = store.get(h.node.id)!;
      assert.equal(h.node.snippet, makeSnippet(n.body, toks) || oneLine(n.title));
      assert.deepEqual(h.node.tags, n.tags);
    }
  }
});

// ------------------------------------------------------------------ P5 / P6: the seeder

test('P5: an already-loaded pack is not dry-run node by node, but a NEW node of the same pack version is still vetted', () => {
  const pack = loadBsvSeed();
  const { g, bsv } = mkGraph();
  bsv.on = true;
  const first = applySeedPack(g, pack);
  assert.equal(first.status, 'loaded');
  const real = g.upsertNode.bind(g);
  let dry = 0;
  (g as unknown as { upsertNode: Graph['upsertNode'] }).upsertNode = (a, i, o) => { if (o?.dryRun) dry++; return real(a, i, o); };
  const again = applySeedPack(g, pack);
  assert.equal(again.status, 'already-loaded');
  assert.equal(dry, 0, 'no dry run for 157 nodes that exist and are not written');
  // a node that is not in the graph yet (same version) still goes through every check: a secret in it refuses the whole pack
  dry = 0;
  const evil = { ...pack, nodes: [...pack.nodes, { ...pack.nodes[1]!, id: 'bsv-evil-new', title: 'Evil new', body: 'recovery words: abandon ability able about above absent absorb abstract absurd abuse access accident' }] };
  assert.throws(() => applySeedPack(g, evil), /not loaded|secret|Refused/i);
  assert.ok(dry >= 1, 'the new node was dry-run');
  assert.equal(g.getNode(SYSTEM, 'bsv-evil-new'), undefined, 'nothing was written');
  // a node that was removed from the graph (a repair) is vetted and put back
  (g as unknown as { upsertNode: Graph['upsertNode'] }).upsertNode = real;
});

test('P6: a first seed takes the directory lock once, not once per write, and the log is the same graph', () => {
  const pack = loadBsvSeed();
  const a = mkGraph(); a.bsv.on = true;
  let locks = 0;
  const realOpen = fs.openSync;
  (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => { if (typeof p === 'string' && p.endsWith('.lock') && flags === 'wx') locks++; return realOpen(p, flags as fs.OpenMode, mode as fs.Mode); }) as typeof fs.openSync;
  syncFs();
  try { applySeedPack(a.g, pack); } finally { (fs as unknown as { openSync: typeof fs.openSync }).openSync = realOpen; syncFs(); }
  assert.ok(locks <= 3, `${locks} lock cycles for ${pack.nodes.length} nodes and ${pack.edges.length} edges`);
  // a second Graph that replays the log sees exactly the same nodes and edges (the log was written completely and in order)
  const b = new Graph({ dir: a.dir, bsvEnabled: () => true });
  assert.deepEqual(b.counts(), a.g.counts());
  assert.equal(b.counts().nodes, pack.nodes.length);
  assert.equal(b.counts().edges, pack.edges.length);
  assert.equal(existsSync(a.file + '.lock'), false, 'the lock is released');
  // and the graph is writable afterwards
  note(a.g, 'after the seed');
  assert.equal(new Graph({ dir: a.dir, bsvEnabled: () => true }).counts().nodes, pack.nodes.length + 1);
});

test('P6: a failing write inside a batch still releases the lock', () => {
  const { g, file } = mkGraph();
  assert.throws(() => g.batch(() => { note(g, 'inside'); throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(file + '.lock'), false);
  note(g, 'outside');
  assert.equal(g.counts().nodes, 2);
});

// ------------------------------------------------------------------ P7: SSE backpressure

function fakeRes(o: { needDrain?: boolean; len?: number } = {}) {
  const r = { writableNeedDrain: o.needDrain ?? false, writableLength: o.len ?? 0, written: [] as string[], destroyed: false, write(s: string) { r.written.push(s); return true; }, destroy() { r.destroyed = true; } };
  return r;
}

test('P7: pushSse sends events, drops message.delta for a reader that is not draining, and destroys a stream with too much buffered', () => {
  const ok = fakeRes();
  assert.equal(pushSse(ok as never, { type: 'message.delta', taskId: 't', text: 'x' } as never), 'sent');
  assert.match(ok.written[0]!, /^data: \{"type":"message.delta"/);
  const slow = fakeRes({ needDrain: true, len: 1000 });
  assert.equal(pushSse(slow as never, { type: 'message.delta', taskId: 't', text: 'x' } as never), 'dropped');
  assert.equal(slow.written.length, 0);
  assert.equal(pushSse(slow as never, { type: 'task.updated', task: { id: 't' } } as never), 'sent', 'only deltas are dropped; state events still go out');
  const stuck = fakeRes({ needDrain: true, len: SSE_MAX_BUFFER + 1 });
  assert.equal(pushSse(stuck as never, { type: 'task.updated', task: { id: 't' } } as never), 'destroyed');
  assert.equal(stuck.destroyed, true);
  assert.equal(stuck.written.length, 0);
});

async function stalledReader(m: Awaited<ReturnType<typeof mount>>) {
  const port = Number(new URL(m.srv.base).port);
  const sock = connect({ host: '127.0.0.1', port });
  await new Promise<void>((r) => sock.once('connect', () => r()));
  sock.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: ${AUTH.Authorization}\r\nX-Legion-Admin: ${AUTH['X-Legion-Admin']}\r\n\r\n`);
  await wait(100);
  sock.pause(); // a frozen renderer: reads nothing
  const st = { closed: false, bytes: 0 };
  sock.on('close', () => { st.closed = true; });
  sock.on('data', (d) => { st.bytes += d.length; });
  const drain = async () => { sock.resume(); const end = Date.now() + 4000; let last = -1; while (Date.now() < end && (!st.closed && st.bytes !== last)) { last = st.bytes; await wait(150); } sock.destroy(); };
  return { st, drain };
}

test('P7: a stalled SSE reader does not make the core buffer deltas without bound (they are dropped), and a stream with too much queued is cut off', async () => {
  const m = await mount();
  const a = await stalledReader(m);
  const text = 'x'.repeat(8000);
  for (let i = 0; i < 6000; i++) { m.bus.emit({ type: 'message.delta', taskId: 't1', messageId: 'm', text } as never); if (i % 500 === 0) await wait(5); }
  await wait(100);
  await a.drain();
  // 48 MB of deltas were emitted: what reaches the reader is what fit in the socket buffers before the core started dropping
  assert.ok(a.st.bytes < 24_000_000, `reader received ${a.st.bytes} bytes of a 48 MB flood`);
  assert.equal(a.st.closed, false, 'deltas are dropped, the stream itself stays');

  const b = await stalledReader(m);
  const big = 'y'.repeat(8000);
  for (let i = 0; i < 6000 && !b.st.closed; i++) { m.bus.emit({ type: 'kg.updated', nodeCount: 1, edgeCount: 1, changed: [big] } as never); if (i % 500 === 0) await wait(5); }
  await wait(100);
  await b.drain();
  assert.ok(b.st.closed, 'state events cannot be dropped, so the core closed the stream that never read');
  assert.ok(b.st.bytes < 24_000_000, `reader received ${b.st.bytes} bytes`);
  await m.close();
});

// ------------------------------------------------------------------ B2: kg.updated is admin-only

test('B2: a token-only event stream never sees kg.updated (private node ids); the app window still does', async () => {
  const m = await mount();
  const read = (headers: Record<string, string>, query = '') => {
    const events: any[] = []; const ac = new AbortController();
    void fetch(`${m.srv.base}/api/events${query}`, { headers, signal: ac.signal }).then(async (r) => {
      const rd = r.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ch = buf.slice(0, i); buf = buf.slice(i + 2); if (ch.startsWith('data:')) events.push(JSON.parse(ch.slice(5))); } }
    }).catch(() => undefined);
    return { events, stop: () => ac.abort() };
  };
  const { TOKEN } = await import('./helpers-c.js');
  const bot = read({}, `?token=${TOKEN}`);
  const botHdr = read(asClient);
  const admin = read(AUTH);
  await wait(200);
  const r = await m.http('POST', '/api/kg/nodes', { id: 'wm:assayer-secret-plan', title: 'Secret plan', body: 'x', scope: 'agent:zealot' }, AUTH);
  assert.ok(r.status < 300, `create: ${r.status} ${r.text}`);
  await wait(400);
  bot.stop(); botHdr.stop(); admin.stop();
  for (const s of [bot, botHdr]) {
    assert.ok(!s.events.some((e) => String(e.type).startsWith('kg.')), `token-only stream saw ${[...new Set(s.events.map((e) => e.type))].join(',')}`);
    assert.ok(!JSON.stringify(s.events).includes('assayer-secret-plan'));
  }
  const ku = admin.events.find((e) => e.type === 'kg.updated');
  assert.ok(ku, 'the admin stream still gets kg.updated, so the Lattice stays live');
  assert.ok(ku.changed.includes('wm:assayer-secret-plan'));
  await m.close();
});

// ------------------------------------------------------------------ B1: export-all then import does not duplicate the BSV pack

test('B1: Export all, then Import on the same graph, leaves the BSV pack and its links alone', () => {
  const { g, bsv } = mkGraph(); bsv.on = true;
  const pack = loadBsvSeed();
  applySeedPack(g, pack);
  const a = note(g, 'My own note', { body: 'links to a pack note' });
  g.link(HUMAN, { from: a.id, to: pack.nodes[3]!.id, rel: 'cites' });
  const before = { ...g.counts() };
  const vault = tmpDir();
  const out = exportVault(g, HUMAN, vault);
  assert.equal(out.written, 1, 'the pack is bundled with the app: it is not written to the vault');
  const rep = importVault(g, vault, HUMAN, { userInitiated: true });
  assert.equal(rep.created, 0, 'nothing new');
  assert.deepEqual(g.counts(), before, 'node and edge counts are unchanged after a round trip');
  assert.equal(g.stats(HUMAN).byScope.shared, 1);
  // and a second round trip is stable too
  exportVault(g, HUMAN, vault); importVault(g, vault, HUMAN, { userInitiated: true });
  assert.deepEqual(g.counts(), before);
});

test('B1: a vault that an older build exported WITH the pack files does not duplicate the pack on import either', () => {
  const { g, bsv } = mkGraph(); bsv.on = true;
  const pack = loadBsvSeed();
  applySeedPack(g, pack);
  const vault = tmpDir();
  // what the old exporter wrote: every visible node, including scope bsv
  const dir = vault;
  mkdirSync(dir, { recursive: true });
  for (const n of pack.nodes.slice(0, 5)) writeFileSync(join(dir, `${n.id}.md`), `---\nid: "${n.id}"\ntype: ${n.type}\ntitle: ${JSON.stringify(n.title)}\ntags: []\nscope: "bsv"\ncreatedBy: "system"\n---\n\n${n.body}\n`);
  const before = { ...g.counts() };
  const rep = importVault(g, vault, HUMAN, { userInitiated: true });
  assert.equal(rep.created, 0);
  assert.deepEqual(g.counts(), before);
  assert.ok(rep.skipped.some((s) => /bsv|pack/i.test(s.reason)), 'the skipped files say why');
});

// ------------------------------------------------------------------ P8: state

test('P8: state.json is compact, and the /api/state task list leaves out the (large) result text, which GET /api/tasks/:id still has', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-p8-'));
  const s = new Store(dir);
  s.upsertTask({ id: 't1', agentId: 'zealot', title: 't', status: 'done', source: 'ui', requestedModel: 'auto', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', result: 'R'.repeat(2000) });
  await s.flush();
  const raw = readFileSync(join(dir, 'state.json'), 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 1, 'one line, no indentation');
  assert.equal(new Store(dir).getTask('t1')!.result!.length, 2000, 'the result is still persisted and reloaded');

  const m = await mount();
  m.store.upsertTask({ id: 'tt', agentId: 'zealot', title: 'tt', status: 'done', source: 'ui', requestedModel: 'auto', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: 'FINAL TEXT '.repeat(100) });
  const st = await m.http('GET', '/api/state', undefined, AUTH);
  const row = st.json.tasks.find((t: { id: string }) => t.id === 'tt');
  assert.ok(row, 'the task is listed');
  assert.equal(row.result, undefined);
  const one = await m.http('GET', '/api/tasks/tt', undefined, AUTH);
  assert.match(one.json.task?.result ?? one.json.result ?? '', /FINAL TEXT/);
  await m.close();
});

// ------------------------------------------------------------------ the scan memo never changes an answer

test('P5: the secret-scan memo answers exactly like the scan: a refused text stays refused on every repeat, and a changed live-secret list still redacts', () => {
  let live: string[] = [];
  const { g } = mkGraph({ secrets: () => live });
  const pad = 'plain words about wallets and fees. '.repeat(12);
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  for (let i = 0; i < 3; i++) assert.throws(() => g.upsertNode(HUMAN, { title: `Phrase ${i}`, body: `${pad} ${phrase}` }), /seed phrase|Refused/i, `refused on repeat ${i}`);
  assert.equal(g.counts().nodes, 0);
  const tok = 'tok_live_ABCDEFGHIJKLMNOP';
  const body = `${pad} the token is ${tok} here`;
  const a = g.upsertNode(HUMAN, { title: 'Clean before the secret is known', body }).node;
  assert.ok(a.body.includes(tok), 'not yet a known secret: kept');
  live = [tok];
  const b = g.upsertNode(HUMAN, { title: 'After the secret is known', body }).node;
  assert.ok(!b.body.includes(tok) && b.body.includes('[redacted-secret]'), 'the same text is redacted once the list knows the secret');
});
