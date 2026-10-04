/**
 * Library v1, stage B: the deterministic close-out episode (acceptance D) and the nightly lint-lite pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EPISODE_DAYS, Graph, staleDaysFor } from '../src/core/kg/graph.js';
import { msUntilNightly } from '../src/core/kg/index.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import { init, kg, ok, setup, toolUse, waitDone } from './library-fakes.js';
import { tmpDir } from './kg-helpers.js';

const SECRET = 'sk-ant-api03-abcdefghijklmnop1234';
const episodes = (s: ReturnType<typeof setup>) => s.graph.allNodes(HUMAN).filter((n) => n.type === 'episode');

// ---------------------------------------------------------------- episode

test('D: a 10-turn task with no capture yields exactly one episode, with no extra model call', async () => {
  const s = setup((c) => c.agent !== 'alpha' ? undefined : (async function* () {
    yield init('a1');
    yield ok(`Result with a key ${SECRET} and ${'long result text. '.repeat(100)}`, 'a1', { num_turns: 10, total_cost_usd: 0.02 });
  })());
  const prompt = `Please do the thing ${'p'.repeat(400)} ${SECRET}`;
  const t = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt, source: 'ui' }));
  assert.equal(s.calls.length, 1, 'no extra turn, no extra SDK call');
  const eps = episodes(s);
  assert.equal(eps.length, 1);
  const e = eps[0]!;
  assert.equal(e.id, `ep:${t.id}`);
  assert.equal(e.scope, 'agent:alpha');
  assert.equal(e.createdBy, 'system');
  assert.equal(e.trust, 'untrusted');
  assert.deepEqual(e.sources, [{ ref: `task:${t.id}`, untrusted: true }]);
  assert.equal(e.origin?.taskId, t.id);
  assert.equal(e.origin?.tainted, false);
  assert.equal(e.props?.turns, 10);
  assert.match(e.body, /ended done after 10 turns/);
  const promptPart = /Prompt: ([\s\S]*?)\n\nResult: ([\s\S]*)$/.exec(e.body)!;
  assert.ok(promptPart[1]!.length <= 300 + 20, `prompt part ${promptPart[1]!.length}`);
  assert.ok(promptPart[2]!.length <= 800 + 20, `result part ${promptPart[2]!.length}`);
  assert.doesNotMatch(JSON.stringify(e), /sk-ant/, 'scrubbed at the Graph boundary');
  assert.match(e.body, /\[redacted/);
  // private to its bot and shown to it only as an untrusted lead
  assert.equal(s.graph.getNode(agentActor('beta'), e.id), undefined);
  assert.match(s.graph.recall(agentActor('alpha'), 'please do the thing').outline, new RegExp(`\\[untrusted lead\\] \\(id ${e.id}`));
  assert.doesNotMatch(s.graph.recall(agentActor('alpha'), 'please do the thing').outline, /Please do the thing/);
  // the same task finishing again updates the same node
  assert.equal(episodes(s).length, 1);
});

test('D: no episode when the bot captured or set working memory, or the task was short and cheap; cost alone is enough', async () => {
  // the tools are really called: only a call that stored something counts as "the bot saved what it learned"
  const CALLS: Record<string, [string, Record<string, unknown>]> = {
    mcp__legion_kg__kg_capture: ['kg_capture', { kind: 'idea', title: 'An idea worth keeping', fields: { pitch: 'p', status: 's', score: 1 }, force: true }],
    mcp__legion_kg__kg_wm_set: ['kg_wm_set', { active: 'state for next time' }],
    mcp__legion_kg__kg_recall: ['kg_recall', { query: 'anything at all' }],
  };
  const mk = (n: number, tool: string | undefined, cost: number) => (c: any) => c.agent !== 'alpha' ? undefined : (async function* () {
    yield init(`s${n}`);
    if (tool) { yield toolUse(tool); await kg(c.options, ...CALLS[tool]!); }
    yield ok('done', `s${n}`, { num_turns: n, total_cost_usd: cost });
  })();
  for (const [turns, tool, cost, want] of [
    [12, 'mcp__legion_kg__kg_capture', 0, 0], [12, 'mcp__legion_kg__kg_wm_set', 0, 0], [12, 'mcp__legion_kg__kg_recall', 0, 1],
    [7, undefined, 0.05, 0], [8, undefined, 0.01, 1], [2, undefined, 0.10, 1], [2, undefined, 0.099, 0],
  ] as const) {
    const s = setup(mk(turns, tool, cost));
    await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'do it', source: 'ui' }));
    assert.equal(episodes(s).length, want, `turns ${turns} tool ${tool} cost ${cost}`);
  }
});

test('D: a refused kg_wm_set or kg_capture does not count as saving: the episode is still written; a capture that was stored (even pending) does count', async () => {
  const run = async (what: 'wm' | 'capture') => {
    const s = setup((c) => c.agent !== 'alpha' ? undefined : (async function* () {
      yield init('a1');
      yield toolUse('Bash'); // the run is tainted from here on
      if (what === 'wm') yield toolUse('mcp__legion_kg__kg_wm_set');
      const r = what === 'wm'
        ? await kg(c.options, 'kg_wm_set', { active: 'refused: this run touched outside content' })
        : await kg(c.options, 'kg_capture', { kind: 'idea', title: 'A tainted idea', fields: { pitch: 'p', status: 's', score: 1 } });
      assert.equal(r.isError, what === 'wm', r.text);
      yield ok('done', 'a1', { num_turns: 12 });
    })());
    await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'do it', source: 'ui' }));
    return episodes(s).length;
  };
  assert.equal(await run('wm'), 1, 'wm_set was refused in a tainted run: an episode is owed');
  assert.equal(await run('capture'), 0, 'the capture was stored (pending for the human): nothing more is owed');
});

test('D: the episode of a tainted run says so; it does not count against the bot\'s task quota and survives an exhausted quota', async () => {
  let refused = '';
  const s = setup((c) => c.agent !== 'alpha' ? undefined : (async function* () {
    yield init('a1');
    yield toolUse('WebFetch');
    for (let i = 0; i < 40; i++) await kg(c.options, 'kg_upsert_node', { title: `Quota filler ${i}`, scope: 'private' });
    refused = (await kg(c.options, 'kg_upsert_node', { title: 'Quota filler 41', scope: 'private' })).text;
    yield ok('done', 'a1', { num_turns: 15 });
  })());
  await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'research the web', source: 'ui' }));
  assert.match(refused, /Quota reached/);
  const eps = episodes(s);
  assert.equal(eps.length, 1, 'the system actor has no quota');
  assert.equal(eps[0]!.origin?.tainted, true);
});

test('episode text with a seed phrase is not stored, but the fact that the task ran is', () => {
  const dir = tmpDir();
  const g = new Graph({ dir });
  const n = g.recordEpisode({
    taskId: 't1', agentId: 'alpha', title: 'Wallet task', status: 'done', turns: 9, costUsd: 0.5,
    prompt: 'restore with seed phrase: abandon ability able about above absent absorb abstract absurd abuse access accident', result: 'ok', tainted: false,
  })!;
  assert.doesNotMatch(JSON.stringify(n), /abandon/);
  assert.match(n.body, /left out/);
  assert.match(n.body, /9 turns/);
  // idempotent per task
  g.recordEpisode({ taskId: 't1', agentId: 'alpha', title: 'Wallet task', status: 'done', turns: 12, costUsd: 0.6, prompt: 'p', result: 'r2', tainted: false });
  assert.equal(g.allNodes(HUMAN).filter((x) => x.type === 'episode').length, 1);
  assert.match(g.getNode(HUMAN, 'ep:t1')!.body, /12 turns/);
  // an agent id that cannot form a scope writes nothing
  assert.equal(g.recordEpisode({ taskId: 't2', agentId: 'bad id!', title: 't', status: 'done', turns: 9, costUsd: 0, prompt: '', result: '', tainted: false }), undefined);
});

// ---------------------------------------------------------------- lint-lite

test('msUntilNightly: the next 03:30 local time', () => {
  const d = (h: number, m: number) => new Date(2026, 9, 1, h, m, 0, 0);
  assert.equal(msUntilNightly(d(2, 30)), 60 * 60_000);
  assert.equal(msUntilNightly(d(3, 30)), 24 * 3_600_000, 'exactly 03:30 waits a full day');
  assert.equal(msUntilNightly(d(10, 0)), (17 * 60 + 30) * 60_000);
});

const DAY = 86_400_000;
function agedGraph() {
  const dir = tmpDir();
  const now = Date.now();
  const at = (d: number) => new Date(now - d * DAY).toISOString();
  const node = (id: string, type: string, ageDays: number, extra: Record<string, unknown> = {}) => JSON.stringify({ op: 'node', node: {
    id, type, title: `${type} ${id}`, body: '', tags: [], scope: 'shared', createdBy: 'alpha', createdAt: at(ageDays), updatedAt: at(ageDays), trust: 'agent', ...extra,
  } });
  writeFileSync(join(dir, 'graph.jsonl'), [
    node('ep-old', 'episode', EPISODE_DAYS + 1, { scope: 'agent:alpha' }), node('ep-new', 'episode', 10, { scope: 'agent:alpha' }),
    node('idea-old', 'idea', 61), node('idea-ok', 'idea', 59), node('proj-old', 'project', 46), node('proj-ok', 'project', 44),
    node('dec', 'decision', 2000), node('pat', 'pattern', 2000), node('mis', 'mistake', 2000),
    node('note-old', 'note', 91), node('note-ok', 'note', 89),
    node('tomb-old', 'note', 31, { status: 'archived' }), node('tomb-new', 'note', 5, { status: 'archived' }),
    node('pend', 'idea', 200, { status: 'pending' }),
  ].join('\n') + '\n');
  return { dir, g: new Graph({ dir, now: () => new Date(now) }) };
}

test('lint-lite: expires old episodes, purges tombstones, flags per-type stale (decision/pattern/mistake never), counts pending', () => {
  const { dir, g } = agedGraph();
  assert.equal(g.getNode(HUMAN, 'tomb-old'), undefined, 'the constructor already purged the old tombstone');
  assert.ok(g.getNode(HUMAN, 'tomb-new'));
  const r = g.lintLite();
  assert.equal(r.expiredEpisodes, 1);
  assert.equal(g.getNode(HUMAN, 'ep-old')!.status, 'archived', 'retired, not deleted: a tombstone for 30 more days');
  assert.equal(g.getNode(HUMAN, 'ep-new')!.status, undefined);
  assert.deepEqual([...r.staleIds].sort(), ['idea-old', 'note-old', 'proj-old']);
  assert.equal(r.stale, 3);
  assert.equal(r.pending, 1);
  assert.equal(g.getNode(HUMAN, 'idea-old')!.status, undefined, 'flagging never changes a note');
  assert.equal(staleDaysFor('decision'), Infinity);
  assert.equal(staleDaysFor('episode'), 30);
  assert.equal(staleDaysFor('idea'), 60);
  assert.equal(staleDaysFor('project'), 45);
  assert.equal(staleDaysFor('note'), 90);
  // exposed through the lint report for the human, and remembered across a restart
  assert.deepEqual(g.lint(HUMAN).lite, r);
  assert.equal(g.lint(agentActor('alpha')).lite, undefined, 'bots do not get it');
  const g2 = new Graph({ dir });
  assert.deepEqual(g2.lastLintLite(), r);
  // the lint report itself uses the per-type TTLs and ignores retired notes
  const stale = g.lint(HUMAN).stale.map((x) => x.id).sort();
  assert.deepEqual(stale, ['idea-old', 'note-old', 'pend', 'proj-old'], 'the lint report also lists the old pending idea; lint-lite leaves pending notes to the inbox');
  // a second pass finds nothing left to expire
  assert.equal(g.lintLite().expiredEpisodes, 0);
});

test('lint-lite: purges tombstones past 30 days at the pass, with an injectable clock', () => {
  const dir = tmpDir();
  let t = Date.now();
  const g = new Graph({ dir, now: () => new Date(t) });
  const n = g.upsertNode(agentActor('alpha', { taskId: 'x' }), { title: 'Scratch', scope: 'agent:alpha' }).node;
  g.deleteNode(agentActor('alpha', { taskId: 'x' }), n.id);
  assert.equal(g.lintLite().purgedTombstones, 0);
  t += 31 * DAY;
  assert.equal(g.lintLite().purgedTombstones, 1);
  assert.equal(g.getNode(HUMAN, n.id), undefined);
});

test('the module runs lint-lite on a timer: scheduled at the next 03:30 with its injected clock, re-armed after each run, cleared on dispose', () => {
  const handles: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const now = new Date(2026, 9, 1, 10, 0, 0, 0);
  const s = setup(() => undefined, { kg: {
    now: () => now,
    timers: { set: (fn, ms) => { const h = { fn, ms, cleared: false }; handles.push(h); return h; }, clear: (h) => { (h as { cleared: boolean }).cleared = true; } },
  } });
  assert.equal(handles.length, 1, 'armed when the module starts');
  assert.equal(handles[0]!.ms, msUntilNightly(now));
  // an old episode, then the timer fires
  s.graph.recordEpisode({ taskId: 'old', agentId: 'alpha', title: 't', status: 'done', turns: 9, costUsd: 0, prompt: '', result: '', tainted: false });
  (s.graph as any).now = () => new Date(Date.now() + 40 * DAY);
  handles[0]!.fn();
  assert.equal(s.graph.getNode(HUMAN, 'ep:old')!.status, 'archived');
  assert.equal(handles.length, 2, 're-armed');
  s.kg.dispose!();
  assert.equal(handles[1]!.cleared, true);
  handles[1]!.fn(); // a late firing after dispose does nothing and arms nothing
  assert.equal(handles.length, 2);
});

test('the default nightly timer is unref\'d, so it never keeps the process alive', () => {
  // Inject the clock the way the test above does. This used to read the wall clock, so it only held when the suite
  // ran more than an hour before 03:30 — which is why a release gate run at 03:05 failed on a test that had nothing
  // to do with the change being gated.
  const now = new Date('2026-01-01T00:00:00Z');
  let ref: { hasRef?: () => boolean } | undefined;
  const real = global.setTimeout;
  (global as any).setTimeout = ((fn: () => void, ms: number) => { const t = real(fn, ms); if (ms > 3_600_000) ref = t; return t; }) as typeof setTimeout;
  try {
    const s = setup(() => undefined, { kg: { now: () => now } });
    s.kg.dispose!();
  } finally { (global as any).setTimeout = real; }
  assert.ok(ref, 'a long timer was armed');
  assert.equal(ref!.hasRef!(), false);
});
