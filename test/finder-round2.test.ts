// Accuracy round 2 of the skill finder sweep: the middle hint, the per-turn shortlist note, the frozen sets and the rule. No network, no model.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';

const REPO = new URL('../../', import.meta.url);

const sweep: any = await import(new URL('scripts/skill-finder-sweep.mjs', REPO).href);
const shared: any = await import(new URL('scripts/lib/finder-shared.mjs', REPO).href);

const SEARCH_HINT = 'If no listed skill clearly fits, call armory_find with what you want to do before answering.';
const MIDDLE = 'Before answering, check the skill list. Load a skill with the Skill tool when it clearly fits the task. If you skip a skill that looks relevant, say why in one line. If you are unsure whether one fits, call armory_find with what you want to do.';
const H2 = 'Before answering, check the skill list. If a skill fits even partly, load it with the Skill tool, even if you could do the task yourself. If you skip an obvious skill, say why in one line. If none fit, call armory_find with what you want to do.';
const HEAD = 'Skills that may fit this request:';
const FOOT = 'For each one, decide whether it clearly fits. If one does, load it with the Skill tool. If none does, answer without a skill.';

describe('round2: modes, arms and strings', () => {
  const by = () => Object.fromEntries(sweep.ARMS_ROUND2.map((a: any) => [a.name, a]));
  it('adds round2 and smoke-round2 and keeps every older mode', () => {
    assert.deepEqual(sweep.MODES, ['smoke', 'full-11e', 'accuracy-11f', 'followup-11g', 'round1', 'smoke-round1', 'round2', 'smoke-round2', 'round3', 'smoke-round3']);
    assert.equal(sweep.parseSweepMode('smoke-round2\n'), 'smoke-round2');
    assert.equal(sweep.parseSweepMode('round2 # go'), 'round2');
    assert.equal(sweep.parseSweepMode('round1'), 'round1');
  });
  it('pins the middle hint and the note text word for word', () => {
    assert.equal(sweep.MIDDLE_HINT, MIDDLE);
    assert.equal(sweep.SHORTLIST_HEAD, HEAD);
    assert.equal(sweep.SHORTLIST_FOOT, FOOT);
    assert.equal(sweep.SHORTLIST_SIZE, 5);
    assert.equal(sweep.SEARCH_HINT, SEARCH_HINT);
    assert.equal(sweep.STRONG_HINT, H2);
  });
  it('has the arms C, M, SL, MSL and H2, all with the full list and search, hits id-only, and no probe line', () => {
    assert.deepEqual(sweep.ARMS_ROUND2.map((a: any) => a.name), ['C', 'M', 'SL', 'MSL', 'H2']);
    const a = by();
    assert.equal(a.C.append, SEARCH_HINT);
    assert.equal(a.M.append, MIDDLE);
    assert.equal(a.SL.append, SEARCH_HINT);
    assert.equal(a.MSL.append, MIDDLE);
    assert.equal(a.H2.append, H2);
    for (const x of sweep.ARMS_ROUND2) {
      assert.deepEqual(x.settings, {}, `${x.name} keeps the full listing`);
      assert.equal(x.search, true);
      assert.equal(x.thirdParty, true, `${x.name} shows hits as id only`);
      assert.ok(!x.describeHits);
      assert.ok(!String(x.append).includes('Use a skill only if one clearly fits'), `${x.name} has no probe line`);
    }
    assert.deepEqual(sweep.ARMS_ROUND2.filter((x: any) => x.shortlist).map((x: any) => x.name), ['SL', 'MSL']);
  });
  it('uses SL and M for the smoke run', () => {
    assert.deepEqual(sweep.ARMS_SMOKE_ROUND2.map((a: any) => a.name).sort(), ['M', 'SL']);
  });
  it('writes the find phrase once in the source, so the hints cannot drift apart', () => {
    const src = readFileSync(new URL('scripts/skill-finder-sweep.mjs', REPO), 'utf8');
    assert.equal(src.split('call armory_find with what you want to do').length - 1, 1);
  });
});

describe('round2: the shortlist note', () => {
  it('lists the ids with a dash, nothing else, between the two verbatim sentences', () => {
    assert.equal(sweep.buildShortlistNote(['a-one', 'b-two']), `${HEAD}\n- a-one\n- b-two\n${FOOT}`);
  });
  it('keeps the top five only', () => {
    const note = sweep.buildShortlistNote(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    assert.equal(note.split('\n').filter((l: string) => l.startsWith('- ')).length, 5);
    assert.ok(note.includes('- s5') && !note.includes('s6'));
  });
  it('gives no note for no candidates, so the model is not shown an empty list', () => {
    assert.equal(sweep.buildShortlistNote([]), null);
  });
});

describe('round2: the hook that carries the note (runSkillCall)', () => {
  const run = async (opts: any, drive: (o: any) => AsyncGenerator<any>) => {
    let seen: any = null;
    const query = ({ options }: any) => { seen = options; return drive(options); };
    const rec = await shared.runSkillCall(query, { model: 'haiku', prompt: 'please handle q1z now', cwd: process.cwd(), append: 'x', ...opts });
    return { rec, options: seen };
  };
  it('calls noteFor with the prompt and returns the text as additionalContext', async () => {
    const asked: string[] = [];
    let out: any = null;
    const { rec, options } = await run({ noteFor: async (p: string) => { asked.push(p); return 'NOTE TEXT'; } }, async function* (o) {
      out = await o.hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: 'UserPromptSubmit', prompt: 'please handle q1z now' });
      yield { type: 'system', subtype: 'hook_response', hook_event: 'UserPromptSubmit', outcome: 'success', output: '' };
      yield { type: 'user', message: { content: [{ type: 'text', text: 'NOTE TEXT' }] } };
      yield { type: 'result', total_cost_usd: 0.001, usage: {} };
    });
    assert.deepEqual(asked, ['please handle q1z now']);
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'NOTE TEXT' } });
    assert.equal(rec.fired, 1);
    assert.equal(rec.noted, 1);
    assert.equal(rec.hookEvents, 1, 'the stream shows the hook ran');
    assert.equal(rec.noteSeen, 1, 'the stream shows the note text');
    assert.equal(options.includeHookEvents, true);
  });
  it('adds nothing when noteFor gives null, and says so', async () => {
    let out: any = null;
    const { rec } = await run({ noteFor: async () => null }, async function* (o) {
      out = await o.hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: 'UserPromptSubmit', prompt: 'p' });
      yield { type: 'result', total_cost_usd: 0.001, usage: {} };
    });
    assert.deepEqual(out, { continue: true });
    assert.equal(rec.fired, 1);
    assert.equal(rec.noted, 0);
  });
  it('does not count a note the assistant only quoted', async () => {
    const { rec } = await run({ noteFor: async () => 'NOTE TEXT' }, async function* (o) {
      await o.hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: 'UserPromptSubmit', prompt: 'p' });
      yield { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'NOTE TEXT' }] } };
      yield { type: 'result', total_cost_usd: 0.001, usage: {}, result: 'NOTE TEXT' };
    });
    assert.equal(rec.noteSeen, 0);
  });
  it('installs no prompt hook without a note, and keeps the static note working', async () => {
    const a = await run({}, async function* () { yield { type: 'result', total_cost_usd: 0, usage: {} }; });
    assert.equal(a.options.hooks.UserPromptSubmit, undefined);
    assert.ok(!a.options.includeHookEvents);
    let out: any = null;
    await run({ note: 'STATIC' }, async function* (o) {
      out = await o.hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: 'UserPromptSubmit', prompt: 'p' });
      yield { type: 'result', total_cost_usd: 0, usage: {} };
    });
    assert.equal(out.hookSpecificOutput.additionalContext, 'STATIC');
  });
});

describe('round2: the frozen sets', () => {
  const real = () => readFileSync(new URL('eval/round1-frozen.json', REPO), 'utf8');
  it('loads the committed round 1 file with its counts', () => {
    const f = sweep.loadFrozen(real());
    assert.deepEqual(f.sizes, [25, 100]);
    assert.equal(f.positives['25'].length, 47);
    assert.equal(f.positives['100'].length, 100);
    assert.deepEqual([f.negatives.easy.length, f.negatives.hard.length, f.negatives.ambiguous.length], [60, 39, 20]);
    assert.equal(f.seed, sweep.SEED);
  });
  it('refuses a file of the wrong version, seed or shape, with a code and no text', () => {
    const f = JSON.parse(real());
    const bad = (mut: (x: any) => void) => { const c = JSON.parse(real()); mut(c); return JSON.stringify(c); };
    for (const text of ['not json', '[]', bad((x) => { x.version = 2; }), bad((x) => { x.seed = 1; }), bad((x) => { delete x.negatives.hard; }), bad((x) => { x.positives['25'] = [{ prompt: 'a' }]; }), bad((x) => { x.catalog['25'] = 'no'; })]) {
      assert.throws(() => sweep.loadFrozen(text), (e: any) => e.code === 'BAD_FROZEN' && !String(e.message).includes('prompt'));
    }
    assert.ok(f);
  });
  it('picks the catalog skills by the frozen names, in the frozen order, and fails early on a missing one', () => {
    const skills = ['b', 'a', 'c', 'd'].map((name) => ({ name, description: `d ${name}` }));
    const fz = { catalog: { 2: ['c', 'a'], 4: ['c', 'a', 'b', 'd'] } };
    const subs = sweep.selectFrozenSubsets(skills, fz, [2, 4]);
    assert.deepEqual(subs.map((s: any) => [s.size, s.items.map((x: any) => x.name)]), [[2, ['c', 'a']], [4, ['c', 'a', 'b', 'd']]]);
    assert.throws(() => sweep.selectFrozenSubsets(skills.slice(0, 2), fz, [2, 4]), (e: any) => e.code === 'FROZEN_MISSING' && /2 /.test(e.message));
  });
  it('plans the frozen items as they are: same positives in order, one pool in the frozen order, no regeneration', () => {
    const subsets = [{ size: 2, items: [{ name: 'sk-0', description: 'd' }, { name: 'sk-1', description: 'd' }] }];
    const frozen = {
      positives: { 2: [{ prompt: 'p1', gold: 'sk-1' }, { prompt: 'p0', gold: 'sk-0' }, { prompt: 'p2', gold: 'sk-1' }] },
      negatives: { easy: ['e1', 'e2'], hard: ['h1'], ambiguous: ['a1'] },
    };
    const { items } = sweep.planItems(subsets, { positives: [], negatives: [] }, 100, 60, tempDir('sweep-plan2-'), { frozen, proportional: true });
    const pos = items.filter((x: any) => x.kind === 'pos');
    assert.deepEqual(pos.map((x: any) => [x.prompt, x.gold]), [['p1', 'sk-1'], ['p0', 'sk-0'], ['p2', 'sk-1']]);
    const neg = items.filter((x: any) => x.kind === 'neg');
    assert.deepEqual(neg.map((x: any) => x.prompt).sort(), ['a1', 'e1', 'e2', 'h1']);
    assert.deepEqual(neg.filter((x: any) => x.bucket === 'easy').map((x: any) => x.prompt), ['e1', 'e2'], 'frozen order kept inside a bucket');
    assert.equal(new Set(neg.map((x: any) => x.i)).size, 4);
  });
});

const rec = (size: number, arm: string, kind: string, i: number, over: Record<string, unknown> = {}) => ({
  size, i, kind, arm, hit: false, accepted: false, called: false, calledName: null, tokens: 100, searches: 0, goldInTop5: false, bucket: null, ...over,
});

describe('round2: precision lines and the rule', () => {
  it('counts right loads over all loads on positives, and loads over negatives, apart from the ambiguous ones', () => {
    const r = [
      rec(100, 'M', 'pos', 0, { called: true, hit: true, accepted: true }),
      rec(100, 'M', 'pos', 1, { called: true, hit: false, accepted: true }),
      rec(100, 'M', 'pos', 2, { called: true }),
      rec(100, 'M', 'pos', 3, {}),
      rec(100, 'M', 'neg', 10, { bucket: 'easy', called: true }),
      rec(100, 'M', 'neg', 11, { bucket: 'easy' }),
      rec(100, 'M', 'neg', 12, { bucket: 'hard', called: true }),
      rec(100, 'M', 'neg', 13, { bucket: 'hard' }),
      rec(100, 'M', 'neg', 14, { bucket: 'ambiguous', called: true }),
      rec(25, 'M', 'pos', 0, { called: true, hit: true, accepted: true }),
    ];
    const p = sweep.precisionLine(r, 100, 'M');
    assert.deepEqual([p.rightLoads, p.allLoads, p.strictRight, p.positives], [2, 3, 1, 4]);
    assert.deepEqual([p.negLoads, p.negN, p.ambLoads, p.ambN], [2, 4, 1, 1]);
  });
  it('prints the rule before any result, naming M, SL and MSL, H2 as report only, and the three tests', () => {
    const t = sweep.ruleTextRound2();
    assert.match(t, /^Pre-registered rule/);
    for (const s of ['M, SL and MSL', 'H2', 'report only', 'at least 5 points', 'McNemar p < 0.05', '100 skills', '25 skills', 'one item', 'C + 2', 'both sizes', 'right loads', 'precision']) assert.ok(t.includes(s), s);
    assert.deepEqual(sweep.ROUND2_RULE, sweep.ROUND1_RULE);
  });
  it('decides on M, SL and MSL only, with the same three tests as round 1', () => {
    const mk = (n: number) => { // n positives at 100: C gets none right, the arm gets all right
      const out: any[] = [];
      for (let i = 0; i < n; i++) { out.push(rec(100, 'C', 'pos', i)); out.push(rec(100, 'SL', 'pos', i, { hit: true, accepted: true, called: true })); out.push(rec(100, 'M', 'pos', i)); }
      for (let i = 0; i < 25; i++) { out.push(rec(25, 'C', 'pos', i, { hit: true, accepted: true, called: true })); out.push(rec(25, 'SL', 'pos', i, { hit: true, accepted: true, called: true })); out.push(rec(25, 'M', 'pos', i, { hit: true, accepted: true, called: true })); }
      for (const size of [25, 100]) for (let k = 0; k < 10; k++) for (const a of ['C', 'SL', 'M']) out.push(rec(size, a, 'neg', 1000 + k, { bucket: 'easy', called: a === 'SL' && k < 3 }));
      return out;
    };
    const recs = mk(30);
    const rows = Object.fromEntries(['SL', 'M'].map((a) => [a, [25, 100].map((s) => sweep.compareRound1(recs, s, 'C', a))]));
    const d = sweep.decideRound1(rows);
    assert.deepEqual(d.passing, ['M'].filter(() => false), 'SL has 3 extra false loads, M has no gain');
    const sl = d.arms.find((x: any) => x.arm === 'SL');
    assert.ok(sl.reasons.some((x: string) => /more false loads/.test(x)));
    const m = d.arms.find((x: any) => x.arm === 'M');
    assert.ok(m.reasons.some((x: string) => /McNemar|above C/.test(x)));
  });
  it('shortlistCheck fails when the hook never fired, when no note was built, and is silent without shortlist arms', () => {
    const row = (arm: string, o: any) => ({ arm, notesBuilt: 0, hookFired: 0, noteSeen: 0, hookEvents: 0, ...o });
    assert.equal(sweep.shortlistCheck([row('C', {})]), '');
    assert.match(sweep.shortlistCheck([row('SL', { notesBuilt: 3, hookFired: 0 })]), /Check failed.*hook/);
    assert.match(sweep.shortlistCheck([row('SL', { notesBuilt: 0, hookFired: 4 })]), /Check failed.*no note/);
    assert.match(sweep.shortlistCheck([row('SL', { notesBuilt: 3, hookFired: 4, noteSeen: 0, hookEvents: 0 })]), /not shown in the message stream/);
    assert.match(sweep.shortlistCheck([row('SL', { notesBuilt: 3, hookFired: 4, noteSeen: 3, hookEvents: 4 })]), /reached the model/);
  });
});

// ---- the whole job on fakes ----

const NAMES = Array.from({ length: 120 }, (_, i) => `skill-q${i}zz`);
const tokenOf = (name: string) => name.split('-')[1];
const fakeFetch = async (url: string) => {
  const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });
  if (url === 'https://skills.sh/') return ok(`<html>${NAMES.map((n) => `<a href="/o/r/${n}">${n}</a>`).join('')}</html>`);
  if (url.startsWith('https://skills.sh/')) return ok('<html></html>');
  if (url.includes('/git/trees/')) return ok(JSON.stringify({ tree: NAMES.map((n) => ({ type: 'blob', path: `skills/${n}/SKILL.md` })) }));
  const raw = /skills\/([^/]+)\/SKILL\.md/.exec(url);
  return raw ? ok(`---\nname: ${raw[1]}\ndescription: Handles ${tokenOf(raw[1])} jobs for SECRETDESC people.\n---\nbody`) : { ok: false, status: 404, text: async () => '' };
};
const FROZEN = () => ({
  version: 1, seed: sweep.SEED, sizes: [25, 100],
  catalog: { 25: NAMES.slice(0, 25), 100: NAMES.slice(0, 100) },
  positives: {
    25: Array.from({ length: 8 }, (_, i) => ({ prompt: `please handle ${tokenOf(NAMES[i * 3])} now`, gold: NAMES[i * 3] })),
    100: Array.from({ length: 12 }, (_, i) => ({ prompt: `please handle ${tokenOf(NAMES[i * 7])} now`, gold: NAMES[i * 7] })),
  },
  negatives: {
    easy: Array.from({ length: 5 }, (_, i) => `fix the loop in my script number ${i}`),
    hard: Array.from({ length: 4 }, (_, i) => `what does recursion mean here ${i}`),
    ambiguous: ['could you tidy my notes'],
  },
});

function fakeQueryR2(log: { echo?: boolean; probes: number; notes: string[]; arms: Map<string, number>; judges: number; systems: Set<string> }) {
  return ({ prompt, options }: any) => (async function* () {
    if (options.tools?.length === 0) {
      const sys = String(options.systemPrompt);
      log.systems.add(sys.slice(0, 20));
      if (sys.includes('Both skills are candidates')) log.judges++;
      const n = [...String(prompt).matchAll(/Item (\d+)/g)].length;
      yield { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, a: 1, b: 1 }))) }] } };
      yield { type: 'result', total_cost_usd: 0.002, usage: {} };
      return;
    }
    log.probes++;
    const hook = options.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
    const arm = sweep.ARMS_ROUND2.find((x: any) => x.append === String(options.systemPrompt?.append ?? '') && Boolean(x.shortlist) === Boolean(hook))?.name ?? '?';
    log.arms.set(arm, (log.arms.get(arm) ?? 0) + 1);
    let ctx: string | null = null;
    if (hook) {
      const out = await hook({ hook_event_name: 'UserPromptSubmit', prompt: String(prompt) });
      ctx = out?.hookSpecificOutput?.additionalContext ?? null;
      yield { type: 'system', subtype: 'hook_response', hook_event: 'UserPromptSubmit', outcome: 'success', output: '' };
      if (ctx) { log.notes.push(ctx); yield { type: 'user', message: { content: [{ type: 'text', text: ctx }] } }; }
      const mk = ctx ? /ORCHID-\d+/.exec(ctx)?.[0] : null;
      if (mk && log.echo !== false) yield { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: `all done ${mk}` }] } };
    }
    const dir = join(String(options.env.HOME), '.claude', 'skills');
    const names = existsSync(dir) ? readdirSync(dir) : [];
    const word = /handle (\w+) now/.exec(String(prompt))?.[1];
    const gold = names.find((n) => tokenOf(n) === word);
    const num = Number(/q(\d+)zz/.exec(word ?? '')?.[1] ?? 0);
    let pick: string | undefined;
    if (!word) pick = arm === 'H2' ? names[0] : undefined; // a negative: only H2 loads a skill
    else if (ctx) pick = /^- (\S+)$/m.exec(ctx)?.[1]; // the note shows the first candidate; the model takes it
    else if (arm === 'H2' && num % 3 === 0) pick = names.find((n) => n !== gold);
    else pick = gold;
    if (pick) yield { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 5, cache_read_input_tokens: 60 }, content: [{ type: 'tool_use', name: 'Skill', input: { skill: pick } }] } };
    yield { type: 'system', subtype: 'init', skills: names };
    yield { type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } };
  })();
}

const fakeArmory = async () => {
  const real = await sweep.loadArmory();
  const buildFindServer = (_job: unknown, find: any) => ({
    type: 'sdk', name: 'legion_armory',
    instance: { _registeredTools: { armory_find: { handler: async ({ query }: any) => {
      const hits = await find(String(query), 5);
      return { content: [{ type: 'text', text: `${hits.length} skill(s) may fit:\n${hits.map((h: any) => `- ${h.id} (third-party)`).join('\n')}` }] };
    } } } },
  });
  return { ...real, buildFindServer };
};
const newLog = (): { echo?: boolean; probes: number; notes: string[]; arms: Map<string, number>; judges: number; systems: Set<string> } => ({ probes: 0, notes: [] as string[], arms: new Map<string, number>(), judges: 0, systems: new Set<string>() });

describe('round2: the whole job on fakes', () => {
  it('runs the five arms on the frozen items, builds the note per prompt from the real ranking, and prints the trade-off table', async () => {
    const log = newLog();
    const root = tempDir('sweep-r2-');
    const out = await sweep.runSweep({ query: fakeQueryR2(log), fetch: fakeFetch, mode: 'round2', frozen: FROZEN(), cap: 60, root, armory: await fakeArmory(), log: () => {}, sleep: async () => {} });
    const { summary, result } = out;
    assert.equal(out.frozen, undefined, 'the frozen sets are read, never rewritten');
    assert.equal(result.mode, 'round2');
    assert.deepEqual(result.sizes, [25, 100]);
    assert.deepEqual(result.arms.map((a: any) => a.arm), ['C', 'M', 'SL', 'MSL', 'H2']);
    assert.deepEqual(Object.keys(result.rows), ['M', 'SL', 'MSL', 'H2']);
    assert.deepEqual(result.decision.arms.map((a: any) => a.arm), ['M', 'SL', 'MSL'], 'H2 is report only');
    // 8 + 12 positives and 10 negatives at each of two sizes, five arms.
    assert.equal(log.probes, (8 + 12 + 10 + 10) * 5);
    for (const arm of ['C', 'M', 'SL', 'MSL', 'H2']) assert.equal(log.arms.get(arm), 40, arm);
    assert.ok(!log.systems.has('You write realistic'), 'no prompt is regenerated');
    // The note: the real ranking over the size's skills, top 5, ids only, verbatim text.
    assert.ok(log.notes.length > 0);
    for (const n of log.notes) {
      const lines = n.split('\n');
      assert.equal(lines[0], HEAD);
      assert.equal(lines[lines.length - 1], FOOT);
      const ids = lines.slice(1, -1);
      assert.ok(ids.length >= 1 && ids.length <= 5);
      assert.ok(ids.every((l) => /^- skill-q\d+zz$/.test(l)), 'id only');
      assert.ok(!n.includes('third-party') && !n.includes('Handles') && !n.includes('SECRETDESC'));
    }
    assert.ok(log.notes.some((n) => n.split('\n')[1] === '- skill-q0zz'), 'the gold skill of a unique-word prompt ranks first');
    const by = (a: string) => result.arms.find((x: any) => x.arm === a);
    for (const a of ['SL', 'MSL']) {
      assert.ok(by(a).hookFired > 0 && by(a).notesBuilt > 0 && by(a).noteSeen > 0 && by(a).hookEvents > 0, a);
      assert.ok(by(a).hookFired >= by(a).notesBuilt);
    }
    for (const a of ['C', 'M', 'H2']) assert.equal(by(a).hookFired, 0, a);
    // Equivalence judge ran (H2 picks another skill on some positives).
    assert.ok(log.judges >= 2 && log.judges % 2 === 0);
    // Summary: the rule first, then the trade-off table with precision.
    assert.ok(summary.indexOf('Pre-registered rule') < summary.indexOf('## Results'));
    for (const h of ['## Results against C', '## Trade-off', 'right loads / all loads on positives', 'loads on negatives / negatives', '## Decision', 'reached the model']) assert.ok(summary.includes(h), h);
    const trade = summary.slice(summary.indexOf('## Trade-off'), summary.indexOf('## Misses'));
    for (const a of ['C', 'M', 'SL', 'MSL', 'H2']) assert.ok(new RegExp(`\\| ${a} \\| 100 \\|`).test(trade), `trade-off row for ${a}`);
    // Privacy.
    const pub = JSON.stringify(result) + summary;
    for (const bad of ['SECRETDESC', 'please handle', 'fix the loop', 'what does recursion', 'tidy my notes', 'Skills that may fit']) assert.ok(!pub.includes(bad), bad);
    assert.equal(readdirSync(root).length, 0);
  });
  it('fails before any model call when a frozen skill is not in the catalog', async () => {
    const log = newLog();
    const f = FROZEN();
    f.catalog[25][3] = 'skill-gone';
    await assert.rejects(sweep.runSweep({ query: fakeQueryR2(log), fetch: fakeFetch, mode: 'round2', frozen: f, cap: 5, root: tempDir('sweep-r2-miss-'), armory: await fakeArmory(), log: () => {}, sleep: async () => {} }), (e: any) => e.code === 'FROZEN_MISSING');
    assert.equal(log.probes, 0);
  });
  it('needs the frozen sets', async () => {
    await assert.rejects(sweep.runSweep({ query: fakeQueryR2(newLog()), fetch: fakeFetch, mode: 'round2', cap: 5, root: tempDir('sweep-r2-nf-'), armory: await fakeArmory(), log: () => {}, sleep: async () => {} }), (e: any) => e.code === 'NO_FROZEN');
  });
});

describe('round2: the smoke run on fakes', () => {
  it('runs SL and M on one positive and one negative and proves the note reached the model', async () => {
    const log = newLog();
    const root = tempDir('sweep-r2-smoke-');
    const { summary, result } = await sweep.runSweep({ query: fakeQueryR2(log), fetch: fakeFetch, mode: 'smoke-round2', frozen: FROZEN(), cap: 1, root, armory: await fakeArmory(), log: () => {}, sleep: async () => {} });
    assert.equal(result.smoke, true);
    assert.deepEqual(result.sizes, [25]);
    assert.deepEqual(result.arms.map((a: any) => a.arm).sort(), ['M', 'SL']);
    assert.equal(log.probes, 4, 'one positive and one negative, two arms');
    const sl = result.arms.find((a: any) => a.arm === 'SL');
    assert.equal(sl.hookFired, 2);
    assert.equal(sl.notesBuilt >= 1, true);
    assert.ok(sl.noteSeen >= 1 && sl.hookEvents >= 1);
    assert.equal(result.arms.find((a: any) => a.arm === 'M').hookFired, 0);
    assert.ok(summary.includes('Smoke run') && summary.includes('reached the model'));
    assert.ok(!summary.includes('## Results against'), 'a smoke run prints no results');
    assert.equal(readdirSync(root).length, 0);
  });
});

describe('round2: the workflow and the mode file', () => {
  it('lists round2 and smoke-round2 in the workflow comment, and still keeps the token in the sweep step', () => {
    const yml = readFileSync(new URL('.github/workflows/skill-finder-sweep.yml', REPO), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(yml.includes('round2') && yml.includes('smoke-round2'));
    assert.equal(yml.split('CLAUDE_CODE_OAUTH_TOKEN: ${{').length - 1, 1);
  });
  it('reads the frozen file from the repo by default, and --frozen-in names another', () => {
    const src = readFileSync(new URL('scripts/skill-finder-sweep.mjs', REPO), 'utf8');
    assert.ok(src.includes('--frozen-in'));
    assert.ok(src.includes("eval/round1-frozen.json"));
  });
});

describe('round2: a green smoke must mean the real run can start', () => {
  it('fails the smoke when a size-100 frozen skill is gone, although the 25 set is fine, before any model call', async () => {
    const log = newLog();
    const f = FROZEN();
    f.catalog[100][60] = 'skill-gone';
    await assert.rejects(
      sweep.runSweep({ query: fakeQueryR2(log), fetch: fakeFetch, mode: 'smoke-round2', frozen: f, cap: 1, root: tempDir('sweep-r2-smoke-miss-'), armory: await fakeArmory(), log: () => {}, sleep: async () => {} }),
      (e: any) => e.code === 'FROZEN_MISSING' && /^1 /.test(e.message),
    );
    assert.equal(log.probes, 0);
  });
  it('reports how many frozen skills (all sizes) it found, as a count', async () => {
    const { summary, result } = await sweep.runSweep({ query: fakeQueryR2(newLog()), fetch: fakeFetch, mode: 'smoke-round2', frozen: FROZEN(), cap: 1, root: tempDir('sweep-r2-smoke-n-'), armory: await fakeArmory(), log: () => {}, sleep: async () => {} });
    assert.equal(result.frozenSkillsChecked, 100);
    assert.ok(summary.includes('frozen skills found in the catalog: 100 of 100'));
  });
  it('turns the smoke red unless the note reached the model', () => {
    const row = (arm: string, o: any) => ({ arm, notesBuilt: 0, hookFired: 0, noteSeen: 0, hookEvents: 0, ...o });
    assert.equal(sweep.smokeProvesNote([row('SL', { notesBuilt: 2, hookFired: 2, noteSeen: 2, hookEvents: 2, markerSent: 2, markerEchoed: 1 }), row('M', {})]), true, 'one echoed marker is enough');
    assert.equal(sweep.smokeProvesNote([row('SL', { notesBuilt: 2, hookFired: 2, noteSeen: 2, hookEvents: 2, markerSent: 2, markerEchoed: 0 })]), false, 'the stream alone no longer proves delivery');
    assert.equal(sweep.smokeProvesNote([row('SL', { notesBuilt: 2, hookFired: 2, noteSeen: 0, hookEvents: 2, markerSent: 2, markerEchoed: 2 })]), true, 'a marker echo proves it even if the stream shows nothing');
    assert.equal(sweep.smokeProvesNote([row('SL', { notesBuilt: 2, hookFired: 2 })]), false);
    assert.equal(sweep.smokeProvesNote([row('SL', { notesBuilt: 0, hookFired: 2 })]), false);
    assert.equal(sweep.smokeProvesNote([row('SL', {})]), false, 'the hook never fired');
    assert.equal(sweep.smokeProvesNote([row('M', {})]), false, 'no shortlist arm, nothing proven');
    const src = readFileSync(new URL('scripts/skill-finder-sweep.mjs', REPO), 'utf8');
    assert.match(src, /mode === 'smoke-round2' && !smokeProvesNote/);
  });
  it('reads a .sweep-mode with a comment', () => {
    assert.equal(sweep.parseSweepMode('smoke-round2 # round 2 smoke first\n'), 'smoke-round2');
  });
});

describe('round2: the smoke proves delivery by a marker the model must echo', () => {
  it('appends one marker line to the note, only when a marker is given', () => {
    const plain = sweep.buildShortlistNote(['a-one']);
    assert.equal(sweep.buildShortlistNote(['a-one'], 5, null), plain);
    assert.equal(sweep.buildShortlistNote(['a-one'], 5, 'ORCHID-42'), `${plain}\nSmoke check: end your answer with the word ORCHID-42.`);
    assert.equal(sweep.buildShortlistNote([], 5, 'ORCHID-42'), null, 'no candidates, no note, no marker');
    assert.equal(sweep.smokeMarkerLine('ORCHID-7'), 'Smoke check: end your answer with the word ORCHID-7.');
  });
  it('runSkillCall sees the marker only in what the assistant said', async () => {
    const run = async (msgs: any[]) => shared.runSkillCall(() => (async function* () { for (const m of msgs) yield m; })(), { model: 'haiku', prompt: 'p', cwd: process.cwd(), append: 'x', marker: 'ORCHID-7' });
    const said = (text: string) => ({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text }] } });
    const end = { type: 'result', total_cost_usd: 0, usage: {} };
    assert.equal((await run([said('done ORCHID-7'), end])).markerEchoed, true);
    assert.equal((await run([said('done ORCHID-8'), end])).markerEchoed, false);
    assert.equal((await run([{ type: 'user', message: { content: [{ type: 'text', text: 'ORCHID-7' }] } }, end])).markerEchoed, false, 'the note itself does not count');
    assert.equal((await run([end])).markerEchoed, false);
  });
  it('smoke-round2 sends a fresh marker per shortlist call, counts the echoes, and keeps the stream count beside them', async () => {
    const log = newLog();
    const { summary, result } = await sweep.runSweep({ query: fakeQueryR2(log), fetch: fakeFetch, mode: 'smoke-round2', frozen: FROZEN(), cap: 1, root: tempDir('sweep-r2-marker-'), armory: await fakeArmory(), log: () => {}, sleep: async () => {} });
    const sl = result.arms.find((a: any) => a.arm === 'SL');
    assert.ok(sl.markerSent >= 1 && sl.markerEchoed === sl.markerSent);
    assert.equal(result.arms.find((a: any) => a.arm === 'M').markerSent, 0, 'M has no note, so no marker');
    for (const n of log.notes) assert.match(n.split('\n').pop()!, /^Smoke check: end your answer with the word ORCHID-\d+\.$/);
    assert.ok(summary.includes('note delivered (marker echoed)'));
    assert.ok(summary.includes('The note reached the model'), 'the stream count is still reported');
    assert.ok(!JSON.stringify(result).includes('ORCHID'), 'the marker value is not logged');
    assert.equal(sweep.smokeProvesNote(result.arms), true);
  });
  it('is red when the model never echoes the marker, and says so', async () => {
    const log = newLog();
    log.echo = false;
    const { summary, result } = await sweep.runSweep({ query: fakeQueryR2(log), fetch: fakeFetch, mode: 'smoke-round2', frozen: FROZEN(), cap: 1, root: tempDir('sweep-r2-noecho-'), armory: await fakeArmory(), log: () => {}, sleep: async () => {} });
    assert.equal(sweep.smokeProvesNote(result.arms), false);
    assert.match(summary, /Check failed\.\*\* .*marker/);
  });
  it('keeps the full round2 note exactly as the brief says: no marker, no marker line', async () => {
    const log = newLog();
    const { summary, result } = await sweep.runSweep({ query: fakeQueryR2(log), fetch: fakeFetch, mode: 'round2', frozen: FROZEN(), cap: 60, root: tempDir('sweep-r2-nomark-'), armory: await fakeArmory(), log: () => {}, sleep: async () => {} });
    assert.ok(log.notes.length > 0);
    for (const n of log.notes) assert.ok(n.endsWith(FOOT) && !n.includes('ORCHID') && !n.includes('Smoke check'));
    assert.ok(result.arms.every((a: any) => a.markerSent === 0 && a.markerEchoed === 0));
    assert.ok(!summary.includes('marker echoed'));
  });
});
