/**
 * Gates PR 2, task 7: the GitHub write card follows the registry. Ask cards one per write as before. Bypass (or an owner override) turns the card
 * off. Every other check stays: the repo tick, the agent's write grant, the signed write app, the argument size, the recheck before the send.
 * No merge, push, delete or branch tool exists in any preset. Only the registry, the gateway wiring and the gates module may name the gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { CONNECTORS_SERVER_NAME } from '../src/core/connectors/gateway.js';
import { setTicked } from '../src/core/connectors/github/allowlist.js';
import type { GhResponse } from '../src/core/connectors/github/client.js';
import { createConnectorsModule } from '../src/core/connectors/index.js';
import { SHIPPED_CLASSES } from '../src/core/connectors/classes.js';
import { gateOff } from '../src/core/permission-mode.js';
import type { ModuleDeps, ModuleJob } from '../src/core/modules.js';
import { GITHUB_NOT_SIGNED_FOR_WRITE_TEXT, GITHUB_UNTICKED_TEXT, GITHUB_WRITE_NOT_GRANTED_TEXT } from '../src/shared/connectors-view.js';
import { PRESETS } from '../src/shared/gates-registry.js';
import type { Preset } from '../src/shared/gates-registry.js';
import type { ApprovalRequest, LegionEvent, RunMode } from '../src/shared/types.js';
import { mkAgent } from './armory-rig.js';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { tempDir } from './tmp-cleanup.js';

interface Opt { /** the agent follows its project (default) or keeps its own mode, Ask */ follow?: boolean; preset?: Preset; overrides?: Record<string, boolean>; ceiling?: RunMode; signedIn?: boolean; grant?: string[]; /** Wraps the real engine (it gets the data folder), to act at the moment the gate is read. */ wrap?: (engine: any, dir: string) => any; noEngine?: boolean }

async function mk(o: Opt = {}) {
  const g: GatesRig = await gatesRig({ ...(o.preset ? { preset: o.preset } : {}), follow: o.follow ?? true, ...(o.overrides ? { overrides: o.overrides } : {}) });
  const dir = tempDir('legion-ghcard-');
  setTicked(dir, 'o/r', true);
  const sent: string[] = [];
  const cards: ApprovalRequest[] = [];
  const bus = new EventBus();
  const broker = new ApprovalBroker(bus, { timeoutMs: 60_000 });
  bus.on((ev: LegionEvent) => { if (ev.type === 'approval.requested') { cards.push(ev.approval); setImmediate(() => broker.resolve(ev.approval.id, true)); } });
  const api = {
    request: async (path: string): Promise<GhResponse> => { sent.push(path); return { status: 201, json: { id: 1, html_url: 'u' }, rate: { limit: 5000, remaining: 4999, resetAt: '' } }; },
    connection: async () => ({}),
  };
  const agent = mkAgent('a1', { name: 'Mira', connectors: ['github'], githubWrite: o.grant ?? ['o/r'], approval: 'ask', mcpServers: ['*'] });
  const engine = o.wrap ? o.wrap(g.engine, dir) : g.engine;
  const deps = { dataDir: dir, approvals: broker, ...(o.noEngine ? {} : { engine }), store: { getAgent: () => agent, getTask: () => undefined } } as unknown as ModuleDeps;
  const mod = createConnectorsModule(deps, { keys: new ConnectorKeyring(), client: () => api as never, writeApp: () => (o.signedIn === false ? undefined : { api: api as never, can: () => 'yes' }) });
  const job = { taskId: g.task.id, runtime: 'claude', taint: () => false, markTainted: () => undefined, ...(o.ceiling ? { ceiling: o.ceiling } : {}) } as unknown as ModuleJob;
  const built = mod.mcpServers!(agent, job)[CONNECTORS_SERVER_NAME] as any;
  const call = async (name: string, args: Record<string, unknown>) => {
    const out = await built.instance._registeredTools[name].handler({ repo: 'o/r', fields: args }, {});
    return { text: out.content.map((c: any) => c.text).join('\n') as string, isError: out.isError === true };
  };
  const lines = () => g.activityRead().filter((l) => l.kind === 'would-have-asked').map((l) => l.text);
  return { g, dir, sent, cards, agent, built, call, lines, deps };
}

const comment = { number: 7, body: 'hello' };

test('card on (Ask, Accept edits, Smart): one card per write, as before', async () => {
  for (const p of ['ask', 'accept-edits', 'smart'] as const) {
    const r = await mk({ preset: p });
    try {
      const out = await r.call('github_comment', comment);
      assert.equal(out.isError, false, out.text);
      assert.equal(r.cards.length, 1, `${p}: one card`);
      assert.deepEqual(r.sent, ['/repos/o/r/issues/7/comments']);
      assert.deepEqual(r.lines(), [], `${p}: no would-have-asked line while the card is on`);
    } finally { r.g.stop(); }
  }
});

test('github-write-card off (Bypass): the write goes without a card, and the log says what would have been asked', async () => {
  const r = await mk({ preset: 'bypass' });
  try {
    const out = await r.call('github_comment', comment);
    assert.equal(out.isError, false, out.text);
    assert.equal(r.cards.length, 0, 'no card');
    assert.deepEqual(r.sent, ['/repos/o/r/issues/7/comments'], 'the one request went');
    assert.deepEqual(r.lines(), ['Would have asked: github_comment o/r, because Ask before every GitHub write is off']);
  } finally { r.g.stop(); }
});

test('an owner override turns the card off in an Ask project; a ceiling keeps it', async () => {
  const r = await mk({ preset: 'ask', overrides: { 'github-write-card': false } });
  try { await r.call('github_comment', comment); assert.equal(r.cards.length, 0); assert.equal(r.sent.length, 1); } finally { r.g.stop(); }
  const c = await mk({ preset: 'ask', overrides: { 'github-write-card': false }, ceiling: 'ask' });
  try { await c.call('github_comment', comment); assert.equal(c.cards.length, 1, 'a run another bot woke keeps its card'); } finally { c.g.stop(); }
});

test('no engine or a failed gate lookup: the card stays', async () => {
  const r = await mk({ noEngine: true });
  try { await r.call('github_comment', comment); assert.equal(r.cards.length, 1); } finally { r.g.stop(); }
  assert.equal(gateOff({ cardOffFor: () => { throw new Error('x'); } }, 'github-write-card', { taskId: 't', agentId: 'a', action: 'x' }), false);
});

test('off still fails on an unticked repo, an ungranted agent, an unsigned app, an oversized argument', async () => {
  const off = { preset: 'bypass' as const };
  const a = await mk(off);
  try { setTicked(a.dir, 'o/r', false); const o = await a.call('github_comment', comment); assert.equal(o.isError, true); assert.match(o.text, new RegExp(GITHUB_UNTICKED_TEXT.slice(0, 20))); assert.deepEqual(a.sent, []); } finally { a.g.stop(); }
  const b = await mk({ ...off, grant: [] });
  try { const o = await b.call('github_comment', comment); assert.equal(o.isError, true); assert.ok(o.text.includes(GITHUB_WRITE_NOT_GRANTED_TEXT)); assert.deepEqual(b.sent, []); } finally { b.g.stop(); }
  const c = await mk({ ...off, signedIn: false });
  try { const o = await c.call('github_comment', comment); assert.equal(o.isError, true); assert.ok(o.text.includes(GITHUB_NOT_SIGNED_FOR_WRITE_TEXT)); assert.deepEqual(c.sent, []); } finally { c.g.stop(); }
  const d = await mk(off);
  try { const o = await d.call('github_comment', { number: 7, body: 'x'.repeat(70_000) }); assert.equal(o.isError, true); assert.match(o.text, /too long/i); assert.deepEqual(d.sent, []); } finally { d.g.stop(); }
});

test('off still runs recheck() before sending: a switch turned off meanwhile stops the write', async () => {
  // with no card there is no waiting, so the switch is turned off right when the gate is read: the last moment before the send
  const r = await mk({ preset: 'bypass', wrap: (e, dir) => ({ cardOffFor: (t: string, id: string, a: string) => { setTicked(dir, 'o/r', false); return e.cardOffFor(t, id, a); }, noteGateOff: (a: unknown) => e.noteGateOff(a) }) });
  try {
    const out = await r.call('github_comment', comment);
    assert.equal(out.isError, true, out.text);
    assert.match(out.text, new RegExp(GITHUB_UNTICKED_TEXT.slice(0, 20)));
    assert.deepEqual(r.sent, [], 'nothing went to GitHub');
    assert.equal(r.cards.length, 0);
  } finally { r.g.stop(); }
});

test('no destructive verb is ever offered: merge, push, delete, branch are not tools, in any preset', async () => {
  const names = Object.keys(SHIPPED_CLASSES.github!);
  for (const n of names) assert.doesNotMatch(n, /merge|push|delete|branch|force|close|reopen/i, n);
  for (const p of PRESETS) {
    const r = await mk({ preset: p });
    try {
      const tools = Object.keys(r.built.instance._registeredTools);
      for (const n of tools) assert.doesNotMatch(n, /merge|push|delete|branch|force/i, `${p}: ${n}`);
    } finally { r.g.stop(); }
  }
});

test('only the registry and the gateway wiring name github-write-card in src', () => {
  const hits = execFileSync('rg', ['-l', 'github-write-card', 'src'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean).map((p) => p.replace(/\\/g, '/')).sort();
  assert.deepEqual(hits, ['src/core/connectors/gateway.ts', 'src/shared/gates-registry.ts']);
});

test('I1: an agent the owner set to Ask still gets the card in a Bypass project; an agent that follows Bypass does not; an explicit override covers both', async () => {
  const own = await mk({ preset: 'bypass', follow: false });
  try { await own.call('github_comment', comment); assert.equal(own.cards.length, 1, 'own-Ask agent keeps the card in Bypass'); assert.deepEqual(own.lines(), []); } finally { own.g.stop(); }
  const follow = await mk({ preset: 'bypass', follow: true });
  try { await follow.call('github_comment', comment); assert.equal(follow.cards.length, 0, 'a follower of Bypass: no card'); } finally { follow.g.stop(); }
  const sw = await mk({ preset: 'ask', follow: false, overrides: { 'github-write-card': false } });
  try { await sw.call('github_comment', comment); assert.equal(sw.cards.length, 0, 'an explicit switch-off covers an own-Ask agent'); assert.equal(sw.lines().length, 1); } finally { sw.g.stop(); }
});

test('I3: a ceiling keeps the GitHub card in a Bypass project too', async () => {
  const c = await mk({ preset: 'bypass', ceiling: 'ask' });
  try { await c.call('github_comment', comment); assert.equal(c.cards.length, 1); } finally { c.g.stop(); }
});
