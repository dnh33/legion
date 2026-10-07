/** Web egress after connector data (maintainer decision 2026-10-07): WebFetch and WebSearch in a run that used connectors AND is tainted need a card, even in full mode. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTORS_SERVER_NAME } from '../src/core/connectors/gateway.js';
import type { FakeGitHub } from './connectors-fake-github.js';
import { lateModule, signedInGitHub } from './connectors-rig.js';
import { init, mkAgent, ok, setup } from './library-fakes.js';

const fakes: FakeGitHub[] = [];
after(async () => { for (const f of fakes) await f.stop(); });
const URL_ = 'https://example.com/leak?x=1';
const hookInput = (tool: string, input: Record<string, unknown>) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'tu' });

async function rig(approval: 'full' | 'ask', readFirst: boolean, then: (c: { s: ReturnType<typeof setup>; options: any }) => Promise<void>) {
  const gh = await signedInGitHub();
  fakes.push(gh.fake);
  let s: ReturnType<typeof setup>;
  const mod = lateModule(() => s.store, gh);
  let finished!: () => void;
  const done = new Promise<void>((r) => { finished = r; });
  let failure: unknown;
  s = setup((c) => (async function* () {
    yield init('s1');
    try {
      if (readFirst) await c.options.mcpServers[CONNECTORS_SERVER_NAME].instance._registeredTools.github_repo_get.handler({ repo: 'o/r' }, {});
      await then({ s, options: c.options });
    } catch (e) { failure = e; }
    yield ok('done', 's1');
    finished();
  })(), { modules: [mod], agents: [{ ...mkAgent('alpha', 'Alpha', approval), connectors: ['github'] }] });
  s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' });
  await done;
  if (failure) throw failure;
}
const cardNow = async (s: ReturnType<typeof setup>) => { for (let i = 0; i < 200 && s.approvals.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 5)); return s.approvals.pending(); };
const webHooks = (options: any) => (options.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<(i: unknown, id: string, o: unknown) => Promise<any>> }>).filter((h) => h.matcher === 'WebFetch|WebSearch');

test('Claude path, full and uncapped: after a connector read the web request raises a card; deny blocks it, allow lets it run; one card per call', async () => {
  await rig('full', true, async ({ s, options }) => {
    assert.equal(options.permissionMode, 'bypassPermissions', 'full mode has no canUseTool');
    assert.equal(options.canUseTool, undefined);
    const hook = webHooks(options)[0]!.hooks[0]!;
    const denied = hook(hookInput('WebFetch', { url: URL_ }), 'tu', {});
    const p1 = await cardNow(s);
    assert.equal(p1.length, 1);
    assert.match(p1[0]!.summary, /WebFetch: https:\/\/example\.com\/leak\?x=1/);
    assert.match(p1[0]!.summary, /connector \(GitHub\) data/);
    s.approvals.resolve(p1[0]!.id, false);
    assert.equal((await denied).hookSpecificOutput.permissionDecision, 'deny');
    const allowed = hook(hookInput('WebSearch', { query: 'octocat' }), 'tu', {});
    const p2 = await cardNow(s);
    assert.equal(p2.length, 1);
    s.approvals.resolve(p2[0]!.id, true);
    assert.deepEqual(await allowed, { continue: true });
    assert.equal(s.approvals.pending().length, 0);
  });
});

test('negative: a tainted run that never used a connector gets no card for web access, in full mode', async () => {
  await rig('full', false, async ({ s, options }) => {
    s.engine.markTainted(s.store.listTasks(5)[0]!.id); // tainted but no connector data: still no card
    const hook = webHooks(options)[0]!.hooks[0]!;
    assert.deepEqual(await hook(hookInput('WebFetch', { url: URL_ }), 'tu', {}), { continue: true });
    assert.equal(s.approvals.pending().length, 0);
    // other tools are never touched by this guard
    assert.deepEqual(await hook(hookInput('Read', { file_path: 'x' }), 'tu', {}), { continue: true });
  });
});

test('Claude path, ask mode: exactly one card (through canUseTool; no second one from a hook)', async () => {
  await rig('ask', true, async ({ s, options }) => {
    assert.equal(webHooks(options).length, 0, 'the hook exists only where canUseTool does not');
    const r = options.canUseTool('WebFetch', { url: URL_ });
    const p = await cardNow(s);
    assert.equal(p.length, 1);
    s.approvals.resolve(p[0]!.id, true);
    assert.equal((await r).behavior, 'allow');
    assert.equal(s.approvals.pending().length, 0);
  });
});

test('provider path: the decider every provider call goes through raises the same card (full mode), and nothing for a clean run', async () => {
  await rig('full', true, async ({ s }) => {
    const agent = s.store.getAgent('alpha')!;
    const task = s.store.listTasks(5)[0]!;
    const decide = (s.engine as any).toolDecider({ taskId: task.id }, agent) as (n: string, i: Record<string, unknown>) => Promise<{ allow: boolean }>;
    const r = decide('WebFetch', { url: URL_ });
    const p = await cardNow(s);
    assert.equal(p.length, 1);
    s.approvals.resolve(p[0]!.id, false);
    assert.equal((await r).allow, false);
    assert.equal((await decide('Read', {})).allow, true);
  });
  await rig('full', false, async ({ s }) => {
    const agent = s.store.getAgent('alpha')!;
    const decide = (s.engine as any).toolDecider({ taskId: s.store.listTasks(5)[0]!.id }, agent);
    assert.equal((await decide('WebFetch', { url: URL_ })).allow, true);
    assert.equal(s.approvals.pending().length, 0);
  });
});
