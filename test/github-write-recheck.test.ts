/**
 * GitHub writes: the gate is checked again after the owner says yes (the card can stay open for minutes). If the repo was turned off, the
 * master switch went off, the agent lost its write grant or the write app signed out while the card was open, nothing is sent. A dismissed
 * card, a timeout and a core shutdown while the card is open also send nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { CONNECTORS_SERVER_NAME } from '../src/core/connectors/gateway.js';
import { setMaster, setTicked } from '../src/core/connectors/github/allowlist.js';
import type { GhResponse } from '../src/core/connectors/github/client.js';
import { createConnectorsModule } from '../src/core/connectors/index.js';
import type { ModuleDeps, ModuleJob } from '../src/core/modules.js';
import { GITHUB_AGENTS_OFF_TEXT, GITHUB_NOT_SIGNED_FOR_WRITE_TEXT, GITHUB_UNTICKED_TEXT, GITHUB_WRITE_NOT_GRANTED_TEXT } from '../src/shared/connectors-view.js';
import type { ApprovalRequest, LegionEvent } from '../src/shared/types.js';
import { mkAgent } from './armory-rig.js';
import { tempDir } from './tmp-cleanup.js';

function mk(o: { timeoutMs?: number } = {}) {
  const dir = tempDir('legion-ghrecheck-');
  setTicked(dir, 'o/r', true);
  const sent: string[] = [];
  const cards: ApprovalRequest[] = [];
  const bus = new EventBus();
  const broker = new ApprovalBroker(bus, { timeoutMs: o.timeoutMs ?? 60_000 });
  bus.on((ev: LegionEvent) => { if (ev.type === 'approval.requested') cards.push(ev.approval); });
  const api = {
    request: async (path: string): Promise<GhResponse> => { sent.push(path); return { status: 201, json: { id: 1, html_url: 'u' }, rate: { limit: 5000, remaining: 4999, resetAt: '' } }; },
    connection: async () => ({}),
  };
  const agent = mkAgent('alpha', { name: 'Mira', connectors: ['github'], githubWrite: ['o/r'], approval: 'ask', mcpServers: ['*'] });
  const live = { signedIn: true };
  const deps = { dataDir: dir, approvals: broker, store: { getAgent: () => agent, getTask: () => undefined } } as unknown as ModuleDeps;
  const mod = createConnectorsModule(deps, { keys: new ConnectorKeyring(), client: () => api as never, writeApp: () => (live.signedIn ? { api: api as never, can: () => 'yes' } : undefined) });
  const job = { taskId: 't1', runtime: 'claude', taint: () => false, markTainted: () => undefined } as unknown as ModuleJob;
  const built = mod.mcpServers!(agent, job)[CONNECTORS_SERVER_NAME] as any;
  const comment = async () => {
    const out = await built.instance._registeredTools.github_comment.handler({ repo: 'o/r', fields: { number: 7, body: 'hello' } }, {});
    return { text: out.content.map((c: any) => c.text).join('\n') as string, isError: out.isError === true };
  };
  const open = async (): Promise<{ p: Promise<{ text: string; isError: boolean }> }> => {
    const p = comment();
    for (let i = 0; i < 50 && cards.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(cards.length, 1, 'the card is open');
    return { p };
  };
  return { dir, sent, cards, broker, agent, live, open };
}

test('repo turned off while the card is open: Allow sends nothing', async () => {
  const r = mk();
  const { p } = await r.open();
  setTicked(r.dir, 'o/r', false);
  r.broker.resolve(r.cards[0]!.id, true);
  const out = await p;
  assert.deepEqual(r.sent, []);
  assert.equal(out.isError, true);
  assert.match(out.text, new RegExp(GITHUB_UNTICKED_TEXT.slice(0, 20)));
});

test('master switch off while the card is open: Allow sends nothing', async () => {
  const r = mk();
  const { p } = await r.open();
  setMaster(r.dir, false);
  r.broker.resolve(r.cards[0]!.id, true);
  const out = await p;
  assert.deepEqual(r.sent, []);
  assert.equal(out.isError, true);
  assert.ok(out.text.includes(GITHUB_AGENTS_OFF_TEXT));
});

test('agent write level lowered while the card is open: Allow sends nothing', async () => {
  const r = mk();
  const { p } = await r.open();
  (r.agent as any).githubWrite = [];
  r.broker.resolve(r.cards[0]!.id, true);
  const out = await p;
  assert.deepEqual(r.sent, []);
  assert.equal(out.isError, true);
  assert.ok(out.text.includes(GITHUB_WRITE_NOT_GRANTED_TEXT));
});

test('write app signed out while the card is open: Allow sends nothing', async () => {
  const r = mk();
  const { p } = await r.open();
  r.live.signedIn = false;
  r.broker.resolve(r.cards[0]!.id, true);
  const out = await p;
  assert.deepEqual(r.sent, []);
  assert.equal(out.isError, true);
  assert.ok(out.text.includes(GITHUB_NOT_SIGNED_FOR_WRITE_TEXT));
});

test('control: nothing changed while the card is open, Allow sends the one request', async () => {
  const r = mk();
  const { p } = await r.open();
  r.broker.resolve(r.cards[0]!.id, true);
  const out = await p;
  assert.equal(out.isError, false);
  assert.deepEqual(r.sent, ['/repos/o/r/issues/7/comments']);
});

test('card dismissed: nothing is sent', async () => {
  const r = mk();
  const { p } = await r.open();
  r.broker.resolve(r.cards[0]!.id, false);
  const out = await p;
  assert.deepEqual(r.sent, []);
  assert.match(out.text, /did not approve/i);
});

test('card times out: nothing is sent', async () => {
  const r = mk({ timeoutMs: 60 });
  const out = await (await r.open()).p;
  assert.deepEqual(r.sent, []);
  assert.equal(out.isError, true);
});

test('core shuts down (the run is cancelled) while the card is open: nothing is sent', async () => {
  const r = mk();
  const { p } = await r.open();
  r.broker.cancelForTask('t1');
  const out = await p;
  assert.deepEqual(r.sent, []);
  assert.equal(out.isError, true);
});
