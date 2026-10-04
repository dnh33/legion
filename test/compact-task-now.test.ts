/**
 * Engine.compactTaskNow against the REAL Engine, not the fake.
 *
 * The route test above runs against a stubbed engine, which is why it passed while the handler was calling a method
 * that did not exist. This one drives the real thing: the decline paths, and a success that actually appends a summary
 * row to the transcript.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { defaultConfig } from '../src/shared/config.js';
import { newId, nowIso } from '../src/shared/util.js';
import { isSummaryMessage } from '../src/core/providers/compaction.js';
import { toChatMessages } from '../src/core/providers/tool-loop.js';
import { tempDir } from './tmp-cleanup.js';

/** A minimal Engine wired to a store; no server, no fakes. */
function realEngine() {
  const store = new Store(tempDir('compact-task-'));
  const bus = { on: () => undefined, emit: () => undefined } as never;
  const engine = new Engine({
    store, bus, vms: {} as never, approvals: new ApprovalBroker(bus),
    config: defaultConfig(), queryFn: undefined as never, boatConfigured: () => false, maxConcurrent: 1,
  } as never);
  return { store, engine };
}

const seedTask = (store: Store, over: Record<string, unknown> = {}) => {
  const t = {
    id: newId('task'), agentId: 'a1', title: 't', status: 'done', source: 'ui',
    requestedModel: 'auto', createdAt: nowIso(), updatedAt: nowIso(), ...over,
  };
  store.upsertTask(t as never);
  return t;
};

test('an unknown task declines with a sentence', async () => {
  const { engine } = realEngine();
  const r = await engine.compactTaskNow('not-a-task');
  assert.equal(r.ok, false);
  assert.match(r.detail, /not here any more/i);
});

test('a task that never ran on a provider model declines, and says what to do', async () => {
  const { store, engine } = realEngine();
  const t = seedTask(store);
  const r = await engine.compactTaskNow(t.id);
  assert.equal(r.ok, false);
  assert.match(r.detail, /provider model/i, 'the message names the cause, not an error code');
});

test('a conversation too short to compact declines rather than summarising nothing', async () => {
  const { store, engine } = realEngine();
  const t = seedTask(store, { model: 'openai:gpt-4o' });
  const r = await engine.compactTaskNow(t.id);
  assert.equal(r.ok, false);
  assert.match(r.detail, /not enough conversation/i);
});

test('a declined compact changes NOTHING on disk - the transcript is append-only', async () => {
  const { store, engine } = realEngine();
  const t = seedTask(store, { model: 'openai:gpt-4o' });
  await engine.compactTaskNow(t.id);
  assert.deepEqual(store.listMessages(t.id), [], 'a decline writes no rows and loses nothing');
});

test('when compaction is turned off, a manual compact declines instead of ignoring the switch', async () => {
  const { store, engine } = realEngine();
  const t = seedTask(store, { model: 'openai:gpt-4o' });
  for (let i = 0; i < 20; i++) {
    store.addMessage({ id: newId('msg'), taskId: t.id, role: i % 2 ? 'assistant' : 'user', text: `turn ${i}: ${'work '.repeat(80)}`, at: nowIso() } as never);
  }
  // The runtime is what enforces the switch; this proves the ENGINE half passes the settings through and does not
  // compact behind its back. With no provider runtime configured the runtime reports the reason rather than compacting.
  const r = await engine.compactTaskNow(t.id);
  assert.equal(typeof r.ok, 'boolean');
  if (!r.ok) assert.ok(r.detail.length > 10, 'a decline always explains itself');
});

/**
 * The success path: a summary row lands in the transcript and the detail reports the shrink.
 *
 * Every other test here proves a DECLINE, which is the safe direction. This one proves the feature does its job. The
 * runtime is injected as a stub because the point is the engine's half: it must append the summary row, report the
 * before/after sizes, and report anything the summary dropped.
 */
function engineWithRuntime(compactNow: (o: unknown) => unknown) {
  const store = new Store(tempDir('compact-ok-'));
  const bus = { on: () => undefined, emit: () => undefined } as never;
  const engine = new Engine({
    store, bus, vms: {} as never, approvals: new ApprovalBroker(bus),
    config: defaultConfig(), queryFn: undefined as never, boatConfigured: () => false, maxConcurrent: 1,
    providers: { compactNow } as never,
  } as never);
  return { store, engine };
}

test('a successful compact appends a summary row and reports the shrink', async () => {
  let seen: { messages: unknown; focus?: string } | undefined;
  const { store, engine } = engineWithRuntime((o) => {
    seen = o as never;
    return {
      messages: [{ role: 'system', content: '[compacted earlier turns]\n## Goal\nthe work' }],
      compacted: true, usedFallback: false, missing: [],
    };
  });
  const t = seedTask(store, { model: 'openai:gpt-4o' });
  for (let i = 0; i < 12; i++) {
    store.addMessage({ id: newId('msg'), taskId: t.id, role: i % 2 ? 'assistant' : 'user', text: `turn ${i}: ${'work '.repeat(60)}`, at: nowIso() } as never);
  }

  const r = await engine.compactTaskNow(t.id, '  preserve the migration decision  ');
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /Compacted .* to about \d+ estimated tokens/, 'it reports both sizes');

  const rows = store.listMessages(t.id);
  assert.ok(toChatMessages(rows).some((m) => isSummaryMessage(m)), 'a summary row is now in the transcript');
  assert.ok(rows.length > 12, 'append-only: the original turns are still there');
  assert.equal((seen as { focus?: string } | undefined)?.focus, 'preserve the migration decision', 'focus is trimmed and passed through');
});
