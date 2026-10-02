import test from 'node:test';
import assert from 'node:assert/strict';
import { replyText, startFake } from './providers-fakes.js';
import { mkAgent, setup, until } from './providers-harness.js';
import type { Fake } from './providers-fakes.js';
import type { ProviderEntry } from '../src/core/providers/types.js';

/** A lead (Claude) and a sub-agent (Claude by default), a fake provider "fake" on this computer, and a stored running task of the lead. */
async function world(o: { leadTainted?: boolean; subModel?: string; entry?: Partial<ProviderEntry>; leadApproval?: 'ask' | 'full'; subApproval?: 'ask' | 'full' } = {}) {
  const f: Fake = await startFake((_r, res) => replyText(res, 'sub answer'));
  const h = setup(f, { agent: { id: 'sub', name: 'Sub', model: o.subModel ?? 'sonnet', approval: o.subApproval ?? 'full' }, ...(o.entry ? { entry: o.entry } : {}) });
  h.store.agents.set('lead', mkAgent({ id: 'lead', name: 'Lead', model: 'sonnet', approval: o.leadApproval ?? 'ask' }));
  h.store.tasks.set('lt', { id: 'lt', agentId: 'lead', title: 't', status: 'running', source: 'ui', requestedModel: 'sonnet', createdAt: '', updatedAt: '', ...(o.leadTainted ? { tainted: true } : {}) } as any);
  const subTasks = () => h.store.listTasks().filter((t) => t.agentId === 'sub');
  const tell = (model: string) => h.engine.bridge.tell('lt', 'sub', 'please do x', { model });
  return { f, h, subTasks, tell };
}
const refusal = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } return ''; };

test('C a lead naming a provider that the owner has not allowed for that sub-agent is refused with a sentence naming the setting; nothing starts', async () => {
  const w = await world();
  try {
    const msg = refusal(() => w.tell('fake:m1'));
    assert.match(msg, /Sub can only run on "fake:m1" if the user allows leads to choose it\. Allow it in Settings, Providers, Lead choices\./);
    assert.equal(w.subTasks().length, 0); assert.equal(w.f.requests.length, 0); assert.equal(w.h.claudeCalls.length, 0);
    // not even a different model of a provider that is allowed for one value
    w.h.config.providers.leadChoices.sub = ['fake:m1'];
    assert.match(refusal(() => w.tell('fake:m2')), /Lead choices/);
    assert.equal(w.subTasks().length, 0);
  } finally { await w.f.close(); }
});

test('C an allowed choice runs the sub-agent on that provider and model for that task only, and the thread says who chose it and that the owner allowed it', async () => {
  const w = await world();
  try {
    w.h.config.providers.leadChoices.sub = ['fake:m1'];
    const { taskId } = w.tell('fake:m1');
    const done = await w.h.engine.waitFor(taskId, 8000);
    assert.equal(done.status, 'done'); assert.equal(done.provider, 'fake');
    assert.equal(w.f.requests[0]!.body.model, 'm1'); assert.equal(w.h.claudeCalls.length, 0, 'it did not run on Claude');
    assert.deepEqual({ ...done.modelOverride }, { model: 'fake:m1', by: 'lead', allowedInSettings: true });
    assert.ok(w.h.store.listMessages(taskId).some((m) => m.role === 'system' && /runs on fake:m1, chosen by Lead\. You allowed that choice in Settings, Providers, Lead choices/.test(m.text)));
    assert.equal(w.h.store.getAgent('sub')!.model, 'sonnet', 'the agent\'s own setting is untouched');
  } finally { await w.f.close(); }
});

test('C a provider marked lead-selectable allows any of its models for any sub-agent; a CLI, a disabled or an unknown provider never', async () => {
  const w = await world({ entry: { leadSelectable: true } });
  try {
    const { taskId } = w.tell('fake:anything');
    assert.equal((await w.h.engine.waitFor(taskId, 8000)).status, 'done');
    w.h.config.providers.entries.fake!.enabled = false;
    assert.match(refusal(() => w.tell('fake:x')), /turned off/);
    w.h.config.providers.entries.fake!.enabled = true;
    assert.match(refusal(() => w.tell('nosuch:x')), /not a provider that is set up/);
    w.h.config.providers.entries.cli = { kind: 'cli', cli: 'codex', label: 'Codex', baseUrl: '', enabled: true, executable: process.execPath, allowedAgents: ['sub'], leadSelectable: true } as any;
    w.h.config.providers.leadChoices.sub = ['cli:default'];
    assert.match(refusal(() => w.tell('cli:default')), /only the user can start it/);
  } finally { await w.f.close(); }
});

test('C a tainted lead cannot send work to a provider whose runs start tainted (an untrusted remote endpoint); a trusted or local one is fine, and taint still flows to the sub-run', async () => {
  const w = await world({ leadTainted: true });
  try {
    w.h.config.providers.leadChoices.sub = ['fake:m1', 'remote:m1'];
    w.h.config.providers.entries.remote = { kind: 'openai-compat', label: 'Remote', baseUrl: 'https://llm.example.com/v1', enabled: true } as any;
    assert.match(refusal(() => w.tell('remote:m1')), /read outside content in this task.*not marked trusted/);
    w.h.config.providers.entries.remote!.trusted = true;
    assert.equal(w.h.engine.leadMayChoose({ leadId: 'lead', leadTaskId: 'lt', target: w.h.store.getAgent('sub')!, value: 'remote:m1' }).ok, true, 'marked trusted by the owner');
    assert.equal(w.h.engine.leadMayChoose({ leadId: 'lead', leadTaskId: 'lt', target: w.h.store.getAgent('sub')!, value: 'fake:m1' }).ok, true, 'local');
    w.h.config.providers.entries.remote!.trusted = false;
    assert.equal(w.h.engine.leadMayChoose({ leadId: 'lead', leadTaskId: 'lt', target: w.h.store.getAgent('sub')!, value: 'remote:m1' }).ok, false);
    // an untainted lead may pick the untrusted remote one (its run then starts tainted)
    const { taskId } = w.tell('fake:m1');
    const done = await w.h.engine.waitFor(taskId, 8000);
    assert.equal(done.status, 'done'); assert.equal(done.tainted, true, 'the sub-run inherits the lead\'s taint');
    assert.equal(done.origin?.tainted, true);
  } finally { await w.f.close(); }
});

test('C the approval ceiling of the lead still caps the sub-run (a full-access sub-agent woken by an ask-mode lead runs under ask)', async () => {
  const w = await world({ leadApproval: 'ask', subApproval: 'full' });
  try {
    w.h.config.providers.leadChoices.sub = ['fake:m1'];
    const { taskId } = w.tell('fake:m1');
    const done = await w.h.engine.waitFor(taskId, 8000);
    assert.equal(done.origin?.approvalCeiling, 'ask'); assert.equal(done.origin?.fromAgentId, 'lead');
  } finally { await w.f.close(); }
});

test('C a token client (MCP/curl) still cannot pick a provider, even with an allowed list, and cannot name who chose it', async () => {
  const w = await world();
  try {
    w.h.config.providers.leadChoices.sub = ['fake:m1'];
    assert.throws(() => w.h.engine.startTask({ agentId: 'sub', prompt: 'x', source: 'mcp', model: 'fake:m1' } as any), /only be chosen in the Legion app/);
    assert.throws(() => w.h.engine.startTask({ agentId: 'sub', prompt: 'x', source: 'mcp', model: 'fake:m1', modelOverrideBy: 'lead' } as any), /only be chosen in the Legion app/);
    assert.equal(w.subTasks().length, 0);
  } finally { await w.f.close(); }
});

test('C the list is checked again when the run starts: a choice withdrawn after it was queued falls back to the agent\'s own model', async () => {
  const w = await world();
  try {
    w.h.config.providers.leadChoices.sub = ['fake:m1'];
    const e = w.h.engine as any;
    const t = e.startTask({ agentId: 'sub', prompt: 'x', source: 'bot', model: 'fake:m1', modelOverrideBy: 'lead', bridge: { fromAgentId: 'lead', parentTaskId: 'lt', hop: 1 } });
    // the owner removes the choice before the queue is worked
    delete w.h.config.providers.leadChoices.sub;
    const done = await w.h.engine.waitFor(t.id, 8000);
    assert.equal(w.f.requests.length, 0, 'nothing was sent to the provider');
    assert.equal(w.h.claudeCalls.length, 1, 'it ran on the agent\'s own Claude model');
    assert.equal(done.status, 'done');
  } finally { await w.f.close(); }
});

void until;
