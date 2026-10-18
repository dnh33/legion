// Accuracy round 3 of the skill finder sweep: the confirmatory MSL against C test on fresh prompts. No network, no model.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';

const REPO = new URL('../../', import.meta.url);

const sweep: any = await import(new URL('scripts/skill-finder-sweep.mjs', REPO).href);

describe('round3: modes, arms and constants', () => {
  it('adds round3 and smoke-round3 and keeps every older mode', () => {
    assert.deepEqual(sweep.MODES, ['smoke', 'full-11e', 'accuracy-11f', 'followup-11g', 'round1', 'smoke-round1', 'round2', 'smoke-round2', 'round3', 'smoke-round3']);
    assert.equal(sweep.parseSweepMode('smoke-round3 # go\n'), 'smoke-round3');
    assert.equal(sweep.parseSweepMode('round3'), 'round3');
    assert.equal(sweep.parseSweepMode('round2'), 'round2');
  });
  it('runs exactly two arms, C and MSL, as the same objects round 2 uses (so the hints are verbatim)', () => {
    assert.deepEqual(sweep.ARMS_ROUND3.map((a: any) => a.name), ['C', 'MSL']);
    assert.equal(sweep.ARMS_ROUND3[0], sweep.ARMS_ROUND2.find((a: any) => a.name === 'C'));
    assert.equal(sweep.ARMS_ROUND3[1], sweep.ARMS_ROUND2.find((a: any) => a.name === 'MSL'));
    const [c, msl] = sweep.ARMS_ROUND3;
    assert.equal(c.append, sweep.SEARCH_HINT);
    assert.equal(msl.append, sweep.MIDDLE_HINT);
    assert.ok(!c.shortlist && msl.shortlist === true);
    for (const a of sweep.ARMS_ROUND3) {
      assert.deepEqual(a.settings, {});
      assert.equal(a.search, true);
      assert.equal(a.thirdParty, true, 'hits show the id only');
      assert.ok(!a.describeHits);
      assert.ok(!String(a.append).includes('Use a skill only if one clearly fits'), 'no probe line');
    }
    assert.deepEqual(sweep.ARMS_SMOKE_ROUND3.map((a: any) => a.name), ['C', 'MSL']);
  });
  it('pins the rule numbers, the size, the per-skill count and the seed apart from round 1', () => {
    assert.deepEqual(sweep.ROUND3_RULE, { size: 100, minGoldDiff: 0.03, mcnemarAlpha: 0.05, maxExtraFalseLoads: 2, maxPrecisionDrop: 0.03 });
    assert.equal(sweep.ROUND3_PER_SKILL, 3);
    assert.equal(sweep.ROUND3_HARD_TARGET, 60);
    assert.notEqual(sweep.ROUND3_SEED, sweep.SEED);
    assert.equal(sweep.NEAR_DUP_JACCARD, 0.8);
    assert.equal(sweep.CAP_USD, 15);
    assert.equal(sweep.ACCURACY_CONCURRENCY, 6);
  });
});

describe('round3: the repeat check against frozen prompts', () => {
  it('normalises case and punctuation', () => {
    assert.equal(sweep.normalizePrompt('  Fix THE bug, please!! '), 'fix the bug please');
  });
  it('measures the overlap of word sets, short words included', () => {
    assert.equal(sweep.promptJaccard('a b c d', 'a b c d'), 1);
    assert.equal(sweep.promptJaccard('a b c d', 'a b c e'), 3 / 5);
    assert.equal(sweep.promptJaccard('a b', 'c d'), 0);
  });
  it('drops an exact repeat even when the case and punctuation differ', () => {
    const d = sweep.dedupePrompts(['Please, handle q1!', 'something quite new here'], ['please handle q1']);
    assert.deepEqual(d.kept, ['something quite new here']);
    assert.deepEqual([d.exact, d.near], [1, 0]);
  });
  it('drops a near repeat at 0.8 overlap and keeps one just under it', () => {
    const prior = ['one two three four'];
    const at = sweep.dedupePrompts(['one two three four five'], prior); // 4 of 5 = 0.8
    assert.deepEqual([at.kept.length, at.near], [0, 1]);
    const under = sweep.dedupePrompts(['one two three four five six'], prior); // 4 of 6
    assert.deepEqual([under.kept.length, under.near], [1, 0]);
    const reordered = sweep.dedupePrompts(['four three two one'], prior);
    assert.equal(reordered.exact + reordered.near, 1, 'same words in another order is a repeat');
  });
  it('counts items kept earlier in the same list as older ones, and reads text through key', () => {
    const items = [{ prompt: 'alpha beta gamma delta' }, { prompt: 'alpha beta gamma delta epsilon' }, { prompt: 'wholly different words here now' }];
    const d = sweep.dedupePrompts(items, [], { key: (x: any) => x.prompt });
    assert.deepEqual(d.kept.map((x: any) => x.prompt), ['alpha beta gamma delta', 'wholly different words here now']);
    assert.equal(d.near, 1);
  });
  it('changes nothing about round 1 prompt making when no exclude list is given', () => {
    const src = readFileSync(new URL('scripts/skill-finder-sweep.mjs', REPO), 'utf8');
    assert.match(src, /if \(exclude\) \{/);
    assert.match(src, /exclude = null, shuffleSeed = null, hardPasses = 1/);
  });
});

describe('round3: the pre-registered rule text', () => {
  it('states both arms, the fresh sets, the three tests with their numbers, strict gold and the interval method', () => {
    const t = sweep.ruleTextRound3();
    assert.match(t, /^Pre-registered rule \(written before any result\)/);
    for (const s of ['C (the full listing', 'MSL (the middle hint', '100 skills', 'fresh', '3 requests per skill', '0.8', 'at least 3 points', 'McNemar p < 0.05', "MSL's side", 'frozen easy + frozen hard + fresh hard', 'at most C + 2', 'right loads / all loads', "C's minus 3 points", 'undefined and this test fails', 'Strict gold is printed', '95% confidence interval', 'Newcombe (1998) method 10', 'swapped order', 'ambiguous']) assert.ok(t.includes(s), s);
    assert.ok(!t.includes(String.fromCharCode(8212)), 'no em dash');
  });
});

describe('round3: the paired interval (Newcombe 1998, method 10)', () => {
  // Hand-checked against an independent calculation (python, same formulas): n = 100, both 70, C only 5, MSL only 15, neither 10.
  // p_arm 0.85, p_base 0.75, difference 0.10, phi 0.37189; interval 0.01153 to 0.18921.
  it('matches the independent calculation for a worked case', () => {
    const c = sweep.newcombePaired({ both: 70, aOnly: 5, sOnly: 15, neither: 10 });
    assert.ok(Math.abs(c.diff - 0.1) < 1e-12);
    assert.ok(Math.abs(c.phi - 0.371888) < 1e-5);
    assert.ok(Math.abs(c.lo - 0.0115345) < 1e-5, String(c.lo));
    assert.ok(Math.abs(c.hi - 0.1892131) < 1e-5, String(c.hi));
  });
  it('gives a symmetric interval around zero for no discordant pairs, and for equal ones', () => {
    const z = sweep.newcombePaired({ both: 40, aOnly: 0, sOnly: 0, neither: 0 });
    assert.ok(z.lo < 0 && z.hi > 0 && Math.abs(z.lo + z.hi) < 1e-12);
    assert.ok(Math.abs(z.hi - 0.0876216) < 1e-5);
    const e = sweep.newcombePaired({ both: 100, aOnly: 10, sOnly: 10, neither: 100 });
    assert.ok(Math.abs(e.hi - 0.040474) < 1e-5 && Math.abs(e.lo + 0.040474) < 1e-5);
  });
  it('keeps the difference inside the interval and the interval inside -1 to 1', () => {
    for (const [a, b, c, d] of [[0, 0, 0, 5], [1, 0, 0, 0], [0, 7, 0, 0], [0, 0, 7, 0], [30, 2, 40, 1], [5, 50, 3, 20]]) {
      const r = sweep.newcombePaired({ both: a, aOnly: b, sOnly: c, neither: d });
      assert.ok(r.lo <= r.diff + 1e-12 && r.diff <= r.hi + 1e-12, `${[a, b, c, d]}`);
      assert.ok(r.lo >= -1 && r.hi <= 1);
    }
  });
  it('negates and mirrors when the two arms swap', () => {
    const x = sweep.newcombePaired({ both: 60, aOnly: 4, sOnly: 19, neither: 17 });
    const y = sweep.newcombePaired({ both: 60, aOnly: 19, sOnly: 4, neither: 17 });
    assert.ok(Math.abs(x.lo + y.hi) < 1e-12 && Math.abs(x.hi + y.lo) < 1e-12);
  });
  it('narrows with more pairs and has no interval with none', () => {
    const small = sweep.newcombePaired({ both: 7, aOnly: 1, sOnly: 2, neither: 0 });
    const big = sweep.newcombePaired({ both: 700, aOnly: 10, sOnly: 20, neither: 0 });
    assert.ok(big.hi - big.lo < small.hi - small.lo);
    assert.equal(sweep.newcombePaired({ both: 0, aOnly: 0, sOnly: 0, neither: 0 }), null);
  });
  it('covers the true difference about 95% of the time on simulated pairs', () => {
    let s = 12345;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (const [pBoth, pBase, pArm] of [[0.5, 0.1, 0.2], [0.7, 0.05, 0.1], [0.3, 0.2, 0.2]]) {
      const trueDiff = pArm - pBase;
      let covered = 0;
      const reps = 1500;
      for (let r = 0; r < reps; r++) {
        const t = { both: 0, aOnly: 0, sOnly: 0, neither: 0 };
        for (let i = 0; i < 200; i++) {
          const u = rnd();
          if (u < pBoth) t.both++; else if (u < pBoth + pBase) t.aOnly++; else if (u < pBoth + pBase + pArm) t.sOnly++; else t.neither++;
        }
        const ci = sweep.newcombePaired(t);
        if (ci.lo <= trueDiff && trueDiff <= ci.hi) covered++;
      }
      const rate = covered / reps;
      assert.ok(rate > 0.93 && rate < 0.985, `coverage ${rate} for ${[pBoth, pBase, pArm]}`);
    }
  });
});

describe('round3: the decision', () => {
  const row = (n: number, aOnly: number, sOnly: number, loadsBase = 0, loadsArm = 0) => ({
    size: 100, accepted: { pairs: n, table: { both: n - aOnly - sOnly, aOnly, sOnly, neither: 0 } },
    neg: { pooled: { n: 69, loadsBase, loadsArm, searchesBase: 0, searchesArm: 0 } },
  });
  const prec = (c: number | null, m: number | null) => ({ C: { precision: c }, MSL: { precision: m } });
  it('passes when all three tests hold', () => {
    const d = sweep.decideRound3(row(300, 10, 60), prec(0.8, 0.8));
    assert.equal(d.pass, true);
    assert.equal(d.checks.length, 3);
  });
  it('needs 3 points on raw counts: 9 of 300 passes, 8 of 300 does not', () => {
    assert.equal(sweep.decideRound3(row(300, 0, 9), prec(0.8, 0.8)).pass, true);
    const d = sweep.decideRound3(row(300, 0, 8), prec(0.8, 0.8));
    assert.equal(d.pass, false);
    assert.match(d.reasons[0], /test 1/);
  });
  it('needs the gain on the MSL side and p < 0.05', () => {
    assert.equal(sweep.decideRound3(row(300, 40, 0), prec(0.8, 0.8)).pass, false, 'MSL lower');
    assert.equal(sweep.decideRound3(row(30, 0, 5), prec(0.8, 0.8)).pass, false, 'a 16.7 point gain, but p = 0.0625');
    assert.equal(sweep.decideRound3(row(30, 0, 6), prec(0.8, 0.8)).pass, true, 'p = 0.03125');
  });
  it('allows two more false loads than C and no more', () => {
    assert.equal(sweep.decideRound3(row(300, 0, 20, 3, 5), prec(0.8, 0.8)).pass, true);
    const d = sweep.decideRound3(row(300, 0, 20, 3, 6), prec(0.8, 0.8));
    assert.equal(d.pass, false);
    assert.match(d.reasons.join(' '), /test 2/);
  });
  it('allows a precision drop of 3 points and no more, and fails closed on undefined precision', () => {
    assert.equal(sweep.decideRound3(row(300, 0, 20), prec(0.8, 0.77)).pass, true);
    assert.equal(sweep.decideRound3(row(300, 0, 20), prec(0.8, 0.769)).pass, false);
    assert.equal(sweep.decideRound3(row(300, 0, 20), prec(null, 0.9)).pass, false);
    assert.equal(sweep.decideRound3(row(300, 0, 20), prec(0.9, null)).pass, false);
  });
  it('fails with no positives or no negatives', () => {
    assert.equal(sweep.decideRound3(row(0, 0, 0), prec(0.8, 0.8)).pass, false);
    const r = row(300, 0, 20); r.neg.pooled.n = 0;
    assert.equal(sweep.decideRound3(r, prec(0.8, 0.8)).pass, false);
  });
});

describe('round3: planning the items', () => {
  it('keeps every fresh positive and every negative of the frozen and fresh pools, tagged by origin', () => {
    const subsets = [{ size: 100, items: Array.from({ length: 3 }, (_, i) => ({ name: `sk-${i}`, description: 'd' })) }];
    const positives = Array.from({ length: 250 }, (_, i) => ({ prompt: `fresh p${i}`, gold: `sk-${i % 3}` }));
    const hard = [...Array.from({ length: 39 }, (_, i) => `frozen hard ${i}`), ...Array.from({ length: 60 }, (_, i) => `fresh hard ${i}`)];
    const amb = [...Array.from({ length: 20 }, (_, i) => `frozen amb ${i}`), ...Array.from({ length: 12 }, (_, i) => `fresh amb ${i}`)];
    const frozen = { positives: { 100: positives }, negatives: { easy: ['e1', 'e2'], hard, ambiguous: amb } };
    const fresh = new Set([...hard.filter((h) => h.startsWith('fresh')), ...amb.filter((h) => h.startsWith('fresh'))]);
    const { items } = sweep.planItems(subsets, { positives: [], negatives: [] }, Infinity, Infinity, tempDir('sweep-plan3-'), { frozen, proportional: true, fresh, hardCap: Infinity, ambCap: Infinity });
    assert.equal(items.filter((x: any) => x.kind === 'pos').length, 250, 'the positive cap of 100 is not applied');
    const neg = items.filter((x: any) => x.kind === 'neg');
    assert.equal(neg.filter((x: any) => x.bucket === 'hard').length, 99, 'not cut to 60');
    assert.equal(neg.filter((x: any) => x.bucket === 'ambiguous').length, 32, 'not cut to 20');
    assert.equal(neg.filter((x: any) => x.bucket === 'hard' && x.origin === 'fresh').length, 60);
    assert.equal(neg.filter((x: any) => x.bucket === 'hard' && x.origin === 'frozen').length, 39);
    assert.ok(neg.filter((x: any) => x.bucket === 'easy').every((x: any) => x.origin === 'frozen'));
    assert.equal(new Set(neg.map((x: any) => x.i)).size, neg.length);
  });
  it('counts negatives by group and origin for the report', () => {
    const r = (bucket: string, origin: string, called: boolean) => ({ size: 100, arm: 'C', kind: 'neg', bucket, origin, called, searches: called ? 1 : 0 });
    const g = sweep.negativeOrigins([r('easy', 'frozen', true), r('hard', 'frozen', false), r('hard', 'fresh', true), r('hard', 'fresh', true), r('ambiguous', 'fresh', false)], 100, 'C');
    assert.deepEqual(g.map((x: any) => [x.label, x.n, x.loads]), [['easy', 1, 1], ['hard (frozen)', 1, 0], ['hard (fresh)', 2, 2], ['ambiguous (frozen)', 0, 0], ['ambiguous (fresh)', 1, 0]]);
  });
});

describe('round3: the artifact', () => {
  it('holds fresh prompts and gold ids only', () => {
    const a = sweep.round3Artifact({ positives: [{ prompt: 'p', gold: 'g', extra: 'leak' }], hard: ['h'], ambiguous: ['a'] });
    assert.deepEqual(Object.keys(a).sort(), ['negatives', 'positives', 'round', 'seed', 'size', 'version']);
    assert.deepEqual(Object.keys(a.negatives).sort(), ['ambiguous', 'hard']);
    assert.deepEqual(a.positives, [{ prompt: 'p', gold: 'g' }]);
    assert.equal(a.round, 3);
    assert.equal(a.seed, sweep.ROUND3_SEED);
  });
  it('is written under its own name, and the workflow uploads it without touching the round 1 name', () => {
    const src = readFileSync(new URL('scripts/skill-finder-sweep.mjs', REPO), 'utf8');
    assert.equal(sweep.ROUND3_FILE, 'round3-frozen.json');
    assert.match(src, /--round3-out/);
    assert.match(src, /if \(round3\) writeFresh\(resolve\(opts\.round3Out \?\? ROUND3_FILE\)/);
    const yml = readFileSync(new URL('.github/workflows/skill-finder-sweep.yml', REPO), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(yml.includes('--round3-out round3-frozen.json') && yml.includes('--frozen round1-frozen.json'));
    assert.ok(yml.includes('name: round3-frozen') && yml.includes('path: round3-frozen.json'));
    assert.ok(yml.includes('smoke-round3') && yml.includes('round3'));
    assert.equal(yml.split('CLAUDE_CODE_OAUTH_TOKEN: ${{').length - 1, 1);
  });
  it('turns the smoke red unless the note was proven, on its own line next to the round 2 one', () => {
    const src = readFileSync(new URL('scripts/skill-finder-sweep.mjs', REPO), 'utf8');
    assert.match(src, /mode === 'smoke-round2' && !smokeProvesNote/);
    assert.match(src, /mode === 'smoke-round3' && !smokeProvesNote/);
  });
  it('has a .sweep-mode that names a real mode', () => {
    const text = readFileSync(new URL('.sweep-mode', REPO), 'utf8');
    assert.ok(sweep.MODES.includes(sweep.parseSweepMode(text)));
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
const FROZEN_POS = (i: number) => `please handle ${tokenOf(NAMES[i])} for me right now thanks`;
const FROZEN_HARD0 = 'what does recursion mean here 0';
const FROZEN = () => ({
  version: 1, seed: sweep.SEED, sizes: [25, 100],
  catalog: { 25: NAMES.slice(0, 25), 100: NAMES.slice(0, 100) },
  positives: {
    25: Array.from({ length: 4 }, (_, i) => ({ prompt: FROZEN_POS(i), gold: NAMES[i] })),
    100: Array.from({ length: 12 }, (_, i) => ({ prompt: FROZEN_POS(i), gold: NAMES[i] })),
  },
  negatives: {
    easy: Array.from({ length: 5 }, (_, i) => `fix the loop in my script number ${i}`),
    hard: Array.from({ length: 4 }, (_, i) => `what does recursion mean here ${i}`),
    ambiguous: ['could you tidy my notes'],
  },
});
const FRESH_POS = (token: string, k: number) => `a${k} b${k} c${k} the ${token} job d${token}`;

interface Log { probes: number; notes: string[]; arms: Map<string, number>; judges: number; systems: Map<string, number>; hardGenCalls: number; hardCount: Map<string, number>; mslNegLoads: boolean; echo: boolean; firstCallRuleLogged: boolean | null; logged: string[] }
const newLog = (): Log => ({ probes: 0, notes: [], arms: new Map(), judges: 0, systems: new Map(), hardGenCalls: 0, hardCount: new Map(), mslNegLoads: false, echo: true, firstCallRuleLogged: null, logged: [] });

function fakeQueryR3(log: Log) {
  return ({ prompt, options }: any) => (async function* () {
    if (log.firstCallRuleLogged === null) log.firstCallRuleLogged = log.logged.length > 0 && log.logged[0].startsWith('Pre-registered rule');
    if (options.tools?.length === 0) {
      const sys = String(options.systemPrompt);
      const tag = sys.slice(0, 24);
      log.systems.set(tag, (log.systems.get(tag) ?? 0) + 1);
      const items = [...String(prompt).matchAll(/Item (\d+)/g)].map((m) => Number(m[1]));
      const skills = [...String(prompt).matchAll(/^Skill (\d+): (\S+?):/gm)].map((m) => ({ n: Number(m[1]), name: m[2] }));
      let answer: unknown[];
      if (sys.includes('Both skills are candidates')) { log.judges++; answer = items.map((n) => ({ n, a: 1, b: 1 })); }
      else if (sys.includes('"none" when none applies')) answer = items.map((n) => ({ n, verdict: n % 2 === 1 ? 'none' : n % 4 === 0 ? 'ambiguous' : 'applies' }));
      else if (sys.includes('target skill')) answer = items.map((n) => ({ n, ok: 1 }));
      else if (sys.startsWith('You write plain, everyday')) { // hard negatives: one request per skill
        log.hardGenCalls++;
        answer = skills.map((s, idx) => {
          const c = log.hardCount.get(s.name) ?? 0;
          log.hardCount.set(s.name, c + 1);
          const t = tokenOf(s.name);
          return { n: s.n, request: log.hardGenCalls === 1 && idx === 0 ? FROZEN_HARD0 : `explain what ${t} means in ${t}land, take ${c}` };
        });
      } else { // positives: fresh first, then an exact and a near repeat of a frozen prompt for the first twelve skills
        answer = skills.map((s) => {
          const i = NAMES.indexOf(s.name);
          const t = tokenOf(s.name);
          const reqs = [FRESH_POS(t, 0)];
          if (i < 12) reqs.push(FROZEN_POS(i), `${FROZEN_POS(i)} again`);
          reqs.push(FRESH_POS(t, 1), FRESH_POS(t, 2));
          return { n: s.n, requests: reqs };
        });
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(answer) }] } };
      yield { type: 'result', total_cost_usd: 0.002, usage: {} };
      return;
    }
    log.probes++;
    const hook = options.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
    const arm = sweep.ARMS_ROUND3.find((x: any) => x.append === String(options.systemPrompt?.append ?? '') && Boolean(x.shortlist) === Boolean(hook))?.name ?? '?';
    log.arms.set(arm, (log.arms.get(arm) ?? 0) + 1);
    let ctx: string | null = null;
    if (hook) {
      const out = await hook({ hook_event_name: 'UserPromptSubmit', prompt: String(prompt) });
      ctx = out?.hookSpecificOutput?.additionalContext ?? null;
      yield { type: 'system', subtype: 'hook_response', hook_event: 'UserPromptSubmit', outcome: 'success', output: '' };
      if (ctx) { log.notes.push(ctx); yield { type: 'user', message: { content: [{ type: 'text', text: ctx }] } }; }
      const mk = ctx ? /ORCHID-\d+/.exec(ctx)?.[0] : null;
      if (mk && log.echo) yield { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: `all done ${mk}` }] } };
    }
    const dir = join(String(options.env.HOME), '.claude', 'skills');
    const names = existsSync(dir) ? readdirSync(dir) : [];
    const word = /the (q\d+zz) job/.exec(String(prompt))?.[1];
    const gold = names.find((n) => tokenOf(n) === word);
    const num = Number(/q(\d+)zz/.exec(word ?? '')?.[1] ?? 0);
    let pick: string | undefined;
    if (!word) pick = arm === 'MSL' && log.mslNegLoads && String(prompt).includes('fix the loop') ? names[0] : undefined; // a negative
    else if (ctx) pick = /^- (\S+)$/m.exec(ctx)?.[1]; // MSL takes the first candidate of the note
    else pick = num % 4 === 0 ? undefined : gold; // C misses a quarter
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
const go = async (mode: string, log: Log, over: Record<string, unknown> = {}) => sweep.runSweep({
  query: fakeQueryR3(log), fetch: fakeFetch, mode, frozen: FROZEN(), cap: 60, root: tempDir(`sweep-r3-${mode}-`), armory: await fakeArmory(), log: (m: string) => log.logged.push(String(m)), sleep: async () => {}, ...over,
});

describe('round3: the whole job on fakes', () => {
  it('writes fresh prompts, drops repeats of frozen ones, runs two arms and reports the pre-registered numbers', async () => {
    const log = newLog();
    const root = tempDir('sweep-r3-root-');
    const out = await go('round3', log, { root });
    const { summary, result, round3 } = out;
    assert.equal(out.frozen, undefined, 'round 1 file is never rewritten');
    assert.equal(log.firstCallRuleLogged, true, 'the rule is printed before the first model call');
    assert.equal(result.mode, 'round3');
    assert.deepEqual(result.sizes, [100]);
    assert.deepEqual(result.arms.map((a: any) => a.arm), ['C', 'MSL']);
    // Prompt making: 100 skills x 3 written, 12 exact and 12 near repeats of frozen prompts dropped before the judge.
    const s = result.prompts;
    assert.equal(s.written, 300);
    assert.deepEqual([s.dupExact, s.dupNear, s.kept], [12, 12, 276]);
    assert.ok(!log.systems.has('You write realistic every'), 'no easy negatives are written');
    assert.equal(s.hardPassesRun, 2, 'the hard pass repeats until 60 are kept');
    assert.equal(s.hardKept, 60);
    assert.equal(s.hardFresh, 60);
    assert.ok(s.hardDupExact >= 1, 'a hard request equal to a frozen one is dropped');
    assert.ok(s.hardAmbiguous > 0 && s.hardAmbiguous <= 20);
    // Items: fresh positives only; 5 easy + 4 frozen hard + 60 fresh hard pooled.
    const pos = 276;
    const negs = 5 + 4 + 60 + 1 + s.ambFresh;
    assert.equal(log.probes, (pos + negs) * 2);
    for (const arm of ['C', 'MSL']) assert.equal(log.arms.get(arm), pos + negs, arm);
    assert.equal(result.row.accepted.pairs, pos);
    assert.equal(result.row.neg.pooled.n, 69);
    assert.equal(result.row.neg.ambiguous.n, 1 + s.ambFresh, 'ambiguous kept apart');
    assert.ok(!log.notes.some((n) => n.includes('ORCHID')), 'the full run adds no marker');
    for (const n of log.notes) {
      const ids = n.split('\n').slice(1, -1);
      assert.ok(ids.length >= 1 && ids.length <= 5 && ids.every((l) => /^- skill-q\d+zz$/.test(l)));
    }
    // The decision: MSL gains 25 points, no false loads, same precision.
    assert.equal(result.decision.pass, true);
    assert.ok(result.ci.accepted.lo > 0.03 && result.ci.accepted.hi < 0.4);
    assert.ok(result.ci.strict);
    // Summary.
    assert.ok(summary.indexOf('Pre-registered rule') < summary.indexOf('## MSL against C'));
    for (const h of ['Newcombe method 10', 'strict gold', 'accepted gold', '## Rule checks', 'gold in the note but not loaded', 'hard (fresh)', 'ambiguous (fresh)', 'right loads / all loads on positives', 'precision', 'MSL passes the pre-registered rule', 'reached the model']) assert.ok(summary.includes(h), h);
    assert.ok(!summary.includes(String.fromCharCode(8212)));
    // The artifact: fresh prompts and gold ids only.
    assert.deepEqual(Object.keys(round3).sort(), ['negatives', 'positives', 'round', 'seed', 'size', 'version']);
    assert.equal(round3.positives.length, pos);
    assert.equal(round3.negatives.hard.length, 60);
    const frozenAll = new Set([...FROZEN().positives[100].map((p) => p.prompt), ...FROZEN().negatives.hard, ...FROZEN().negatives.easy]);
    assert.ok(round3.positives.every((p: any) => !frozenAll.has(p.prompt) && !/again$/.test(p.prompt)), 'no frozen prompt is run again');
    assert.ok(round3.negatives.hard.every((h: string) => !frozenAll.has(h)));
    for (const p of round3.positives) assert.deepEqual(Object.keys(p).sort(), ['gold', 'prompt']);
    const artifactText = JSON.stringify(round3);
    for (const bad of ['SECRETDESC', 'Handles', 'description', 'Skills that may fit']) assert.ok(!artifactText.includes(bad), bad);
    // Privacy of the numbers and the summary.
    const pub = JSON.stringify(result) + summary;
    for (const bad of ['SECRETDESC', 'job d', 'explain what', 'please handle', 'fix the loop', 'what does recursion', 'tidy my notes', 'Skills that may fit']) assert.ok(!pub.includes(bad), bad);
    assert.equal(readdirSync(root).length, 0);
  });
  it('fails the rule when MSL adds false loads on the pooled negatives', async () => {
    const log = newLog();
    log.mslNegLoads = true;
    const { result, summary } = await go('round3', log);
    assert.equal(result.row.neg.pooled.loadsArm - result.row.neg.pooled.loadsBase, 5);
    assert.equal(result.decision.pass, false);
    assert.match(result.decision.reasons.join(' '), /test 2/);
    assert.ok(summary.includes('does not pass the pre-registered rule'));
  });
  it('fails before any model call when a size-100 frozen skill is gone, or the file lacks size 100', async () => {
    const log = newLog();
    const f = FROZEN();
    f.catalog[100][60] = 'skill-gone';
    await assert.rejects(go('round3', log, { frozen: f }), (e: any) => e.code === 'FROZEN_MISSING');
    const g = FROZEN();
    g.sizes = [25]; delete (g.catalog as any)[100];
    await assert.rejects(go('smoke-round3', log, { frozen: g }), (e: any) => e.code === 'BAD_FROZEN');
    assert.equal(log.probes, 0);
    assert.equal(log.systems.size, 0, 'no model call of any kind');
    await assert.rejects(go('round3', newLog(), { frozen: null }), (e: any) => e.code === 'NO_FROZEN');
  });
});

describe('round3: the smoke run on fakes', () => {
  it('runs C and MSL on 2 fresh positives and 1 negative, proves the note arrived, and writes no artifact', async () => {
    const log = newLog();
    const root = tempDir('sweep-r3-smoke-root-');
    const out = await go('smoke-round3', log, { cap: 1, root });
    const { summary, result } = out;
    assert.equal(result.smoke, true);
    assert.deepEqual(result.arms.map((a: any) => a.arm).sort(), ['C', 'MSL']);
    assert.equal(result.prompts.kept, 2, 'two fresh positives');
    assert.equal(result.prompts.easy, 1, 'one negative');
    assert.equal(log.probes, 3 * 2);
    // Prep cost: one writing call and one judge call, no hard negatives, no easy negatives.
    const prepCalls = [...log.systems.entries()].filter(([k]) => !k.startsWith('You grade whether a skill'));
    assert.equal(prepCalls.reduce((t, [, n]) => t + n, 0), 2);
    assert.ok(!log.systems.has('You write plain, everyday-'.slice(0, 24)));
    const msl = result.arms.find((a: any) => a.arm === 'MSL');
    assert.ok(msl.markerSent >= 1 && msl.markerEchoed === msl.markerSent);
    assert.equal(result.arms.find((a: any) => a.arm === 'C').hookFired, 0);
    assert.equal(sweep.smokeProvesNote(result.arms), true);
    assert.equal(out.round3, undefined, 'a smoke run freezes nothing');
    assert.ok(summary.includes('Smoke run') && summary.includes('note delivered (marker echoed)'));
    assert.ok(!summary.includes('## MSL against C'));
    assert.ok(result.spentUsd < 0.1, `cost ${result.spentUsd}`);
    assert.equal(readdirSync(root).length, 0);
  });
  it('is red when the model never echoes the marker', async () => {
    const log = newLog();
    log.echo = false;
    const { result } = await go('smoke-round3', log, { cap: 1 });
    assert.equal(sweep.smokeProvesNote(result.arms), false);
  });
});
