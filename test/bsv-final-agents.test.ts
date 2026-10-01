/**
 * Final-gate review fix G7: the BSV preamble follows the gate (`requires: 'bsv'`), not the id string, and an id collision
 * never reveals the hidden agent (no "-2": a short random suffix for ANY collision). Local only.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ASSAYER_ID, BSV_PREAMBLE, createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { makeFakes, mkAgent, start, TOKEN } from './helpers-c.js';

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); });

async function setup(on: boolean) {
  const f = makeFakes();
  f.agents.set(ASSAYER_ID, { ...mkAgent(ASSAYER_ID, 'Assayer'), requires: 'bsv' });
  const dataDir = mkdtempSync(join(tmpdir(), 'legion-bsvfin-'));
  if (on) (f.ctx.config as any).bsv = { enabled: true, network: 'testnet' };
  const state = createBsvState({ dataDir, config: f.ctx.config });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled: () => state.enabled };
  const bsv = createBsvModule(deps, { state });
  f.ctx.modules = [bsv];
  f.ctx.bsvEnabled = () => state.enabled;
  const srv = await start(f.ctx);
  closers.push(() => srv.close());
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(srv.base + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  return { ...f, bsv, state, srv, call };
}

test('G7: the preamble is keyed on requires === bsv: another gated agent gets it, a plain agent named Assayer does not', async () => {
  const s = await setup(true);
  const gated = { ...mkAgent('gold-bot', 'Gold'), requires: 'bsv' as const };
  const plain = mkAgent('assayer', 'Assayer'); // same id and name as the seeded one, but no gate
  assert.equal(s.bsv.preamble!(gated), BSV_PREAMBLE);
  assert.equal(s.bsv.preamble!(plain), '', 'the id string alone no longer grants the BSV preamble');
  assert.equal(s.bsv.preamble!({ ...gated, requires: undefined }), '');
  s.state.set(false);
  assert.equal(s.bsv.preamble!(gated), '', 'off: no preamble');
});

test('G7: a user bot named Assayer, with the hidden agent present and BSV off, gets a non-revealing id and no -2', async () => {
  const s = await setup(false);
  const r = await s.call('POST', '/api/agents', { name: 'Assayer' });
  assert.equal(r.status, 201);
  assert.notEqual(r.body.id, 'assayer');
  assert.doesNotMatch(r.body.id, /-\d+$/, 'a numeric suffix would show that the id was taken');
  assert.match(r.body.id, /^assayer-[a-z0-9]{4,8}$/);
  assert.equal(r.body.name, 'Assayer');
  assert.equal(r.body.requires, undefined);
  // it behaves like any other bot: no BSV preamble, even with BSV mode on
  s.state.set(true);
  assert.equal(s.bsv.preamble!(s.agents.get(r.body.id)!), '');
  // and the visible list never shows the hidden one while off
  s.state.set(false);
  const list = await s.call('GET', '/api/agents');
  assert.ok(!list.body.some((a: any) => a.id === 'assayer'));
});

test('G7: ANY id collision gets a short random suffix, never -2 / -3 (HTTP)', async () => {
  const s = await setup(false);
  const a = await s.call('POST', '/api/agents', { name: 'Research Bot' });
  assert.equal(a.body.id, 'research-bot');
  const ids = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const b = await s.call('POST', '/api/agents', { name: 'Research Bot' });
    assert.match(b.body.id, /^research-bot-[a-z0-9]{4,8}$/);
    assert.doesNotMatch(b.body.id, /-\d{1,3}$/);
    ids.add(b.body.id);
  }
  assert.equal(ids.size, 5, 'every id is unique');
});

test('G7: the same rule holds for legion_create_agent over MCP, and long names stay within the slug limit', async () => {
  const s = await setup(false);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.srv.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  closers.push(() => client.close());
  const create = async (name: string) => {
    const r: any = await client.callTool({ name: 'legion_create_agent', arguments: { name } });
    const text = r.content.map((c: any) => c.text).join('');
    return JSON.parse(text.slice(text.indexOf('{'))) as { id: string };
  };
  const a = await create('Assayer');
  assert.match(a.id, /^assayer-[a-z0-9]{4,8}$/);
  const long = 'x'.repeat(60);
  const l1 = await create(long); const l2 = await create(long);
  assert.notEqual(l1.id, l2.id);
  assert.ok(l2.id.length <= 40);
});
