/** The skill finder on the provider path: the note goes in front of the turn's prompt, armory_find, taint, and the shared turn limit. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARMORY_SERVER_NAME } from '../src/core/armory/index.js';
import type { ModuleJob } from '../src/core/modules.js';
import { replyText, replyTools, startFake } from './providers-fakes.js';
import type { FakeReq } from './providers-fakes.js';
import { run, setup } from './providers-harness.js';
import { armoryRig, md, own } from './armory-rig.js';
import type { CcFixture } from './armory-rig.js';

const CC: CcFixture = { plugins: [{ key: 'sp@m', name: 'sp', skills: { 'invoice-audit': md('invoice-audit', 'SECRETDESC audit invoices export pdf accounting') } }] };
const PROMPT = 'please export the invoices to pdf for accounting';
const NOTE_HEAD = 'Skills that may fit this request:';

async function rig() {
  const r = armoryRig({ cc: CC });
  await own(r, { name: 'invoice-pdf-export', description: 'Export invoices to PDF documents for accounting', body: 'b' });
  for (const n of ['garden-notes', 'travel-plan']) await own(r, { name: n, description: `Helps with ${n} things`, body: 'b' });
  await r.call('POST', '/api/armory/state', { id: 'sp:invoice-audit', state: 'on' });
  const man = await r.call('POST', '/api/armory/skill', { name: 'manual-invoice-export', description: 'Export invoices to PDF for accounting', body: 'b' });
  await r.call('POST', '/api/armory/state', { id: man.id, state: 'manual' });
  await r.call('POST', '/api/armory/skill', { name: 'off-invoice-export', description: 'Export invoices to PDF for accounting', body: 'b' });
  await r.call('POST', '/api/armory/finder', { suggest: true, threshold: 'eager' });
  return r;
}

const userMsg = (req: FakeReq): string => [...(req.body.messages as any[])].reverse().find((m) => m.role === 'user')?.content ?? '';
const systemMsg = (req: FakeReq): string => (req.body.messages as any[]).find((m) => m.role === 'system')?.content ?? '';

/** One provider run. The model calls the given tools on its first turn (if any), then answers. */
async function providerRun(r: Awaited<ReturnType<typeof rig>>, prompt: string, o: { calls?: Array<{ name: string; args: unknown }>; modules?: unknown[] } = {}) {
  let n = 0;
  const f = await startFake((_q, res) => {
    n++;
    if (n === 1 && o.calls) replyTools(res, o.calls.map((c, i) => ({ id: `t${i}`, ...c })));
    else replyText(res, 'done');
  });
  try {
    const h = setup(f, { agent: { id: 'alpha', approval: 'ask' } });
    h.engine.setModules((o.modules ?? [r.mod]) as any);
    const t = await run(h, prompt);
    return { t, store: h.store, reqs: f.requests };
  } finally { await f.close(); }
}

function tools(r: Awaited<ReturnType<typeof rig>>, agentId: string) {
  const state = { tainted: false };
  const job = { taskId: 't', runtime: 'provider', taint: () => state.tainted, markTainted: () => { state.tainted = true; } } as ModuleJob;
  const srv = r.mod.mcpServers!(r.agents.get(agentId)!, job)[ARMORY_SERVER_NAME] as any;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const out = await srv.instance._registeredTools[name].handler(args, {});
    return { text: out.content.map((c: any) => c.text).join('\n') as string, isError: out.isError === true };
  };
  return { state, call, names: Object.keys(srv.instance._registeredTools).sort() };
}

describe('the note on a provider run', () => {
  it('the last user message starts with the note; the stored message keeps the raw prompt', async () => {
    const r = await rig();
    const { t, store, reqs } = await providerRun(r, PROMPT);
    assert.equal(t.status, 'done');
    const last = userMsg(reqs[0]!);
    assert.ok(last.startsWith(NOTE_HEAD), last.slice(0, 80));
    assert.match(last, /legion-armory:invoice-pdf-export/);
    assert.match(last, /Load one with armory_skill if it applies\./);
    assert.ok(last.endsWith(PROMPT), 'the raw prompt follows the note');
    assert.doesNotMatch(last, /manual-invoice|off-invoice/);
    assert.deepEqual(store.listMessages(t.id).filter((m) => m.role === 'user').map((m) => m.text), [PROMPT]);
  });

  it('the system message is byte-identical with the finder on and off, and the off run gets no note', async () => {
    const r = await rig();
    const on = await providerRun(r, PROMPT);
    await r.call('POST', '/api/armory/finder', { suggest: false });
    const off = await providerRun(r, PROMPT);
    assert.ok(systemMsg(on.reqs[0]!).length > 0);
    assert.equal(systemMsg(on.reqs[0]!), systemMsg(off.reqs[0]!));
    assert.doesNotMatch(systemMsg(on.reqs[0]!), /Skills that may fit/);
    assert.equal(userMsg(off.reqs[0]!), PROMPT);
  });

  it('a run whose only match is third-party gets the id with no description, and stays untainted', async () => {
    const r = await rig();
    const { t, reqs } = await providerRun(r, 'please run an audit of the quarterly ledger');
    const last = userMsg(reqs[0]!);
    assert.match(last, /sp:invoice-audit \(third-party\)/);
    assert.doesNotMatch(last, /SECRETDESC/);
    assert.notEqual(t.tainted, true);
  });

  it('the shared turn limit: once it has passed, no later module is asked for a note', async () => {
    const r = await rig();
    let asked = 0;
    const slow = { id: 'slow', turnNote: () => new Promise<undefined>(() => undefined) };
    const spy = { id: 'spy', turnNote: async () => { asked += 1; return undefined; } };
    const { reqs } = await providerRun(r, PROMPT, { modules: [slow, spy, r.mod] });
    assert.equal(asked, 0, 'the module after the slow one is never called');
    assert.equal(userMsg(reqs[0]!), PROMPT, 'the turn goes on without a note');
  });
});

describe('armory_find on a provider run', () => {
  it('returns only on skills, and third-party matches carry no text', async () => {
    const r = await rig();
    const t = tools(r, 'alpha');
    assert.deepEqual(t.names, ['armory_find', 'armory_skill', 'armory_skills']);
    const own1 = await t.call('armory_find', { query: 'export invoices pdf accounting', limit: 10 });
    assert.match(own1.text, /legion-armory:invoice-pdf-export \(\d/);
    assert.doesNotMatch(own1.text, /manual-invoice|off-invoice|SECRETDESC/);
    const third = await t.call('armory_find', { query: 'audit the quarterly ledger' });
    assert.match(third.text, /sp:invoice-audit \(third-party\)/);
    assert.doesNotMatch(third.text, /SECRETDESC/);
    assert.equal(t.state.tainted, false, 'a search that returns no third-party text does not taint');
  });

  it('a provider run that calls armory_find is not tainted by a third-party-only result', async () => {
    const r = await rig();
    const { t } = await providerRun(r, 'please look for a skill on the ledger', {
      calls: [{ name: `mcp__${ARMORY_SERVER_NAME}__armory_find`, args: { query: 'audit the quarterly ledger' } }],
    });
    assert.equal(t.status, 'done');
    assert.notEqual(t.tainted, true);
  });
});
