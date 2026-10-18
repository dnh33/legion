/** Accuracy round 1 of the skill finder sweep (mode `round1`). A fake query and a fake fetch only: no network call, no model call. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';

const REPO = new URL('../../', import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const sweep: any = await import(new URL('scripts/skill-finder-sweep.mjs', REPO).href);
const shared: any = await import(new URL('scripts/lib/finder-shared.mjs', REPO).href);

// The three strings of the brief, written out here on purpose: the tests pin the arms to these literals.
const SEARCH_HINT = 'If no listed skill clearly fits, call armory_find with what you want to do before answering.';
const SLIM_SEARCH_HINT = 'Your skill list shows short descriptions. If no listed skill clearly fits, call armory_find with what you want to do before answering.';
const H2 = 'Before answering, check the skill list. If a skill fits even partly, load it with the Skill tool, even if you could do the task yourself. If you skip an obvious skill, say why in one line. If none fit, call armory_find with what you want to do.';
const LH2 = 'Before answering, check the skill list. If a skill fits even partly, load it with the Skill tool, even if you could do the task yourself. If you skip an obvious skill, say why in one line.';
const PROBE = 'Use a skill only if one clearly fits; otherwise answer briefly.';

describe('round1: modes, arms and hint strings', () => {
  const by = () => Object.fromEntries(sweep.ARMS_ROUND1.map((a: any) => [a.name, a]));
  it('is a mode of its own, next to its smoke run, and keeps the other modes', () => {
    assert.deepEqual(sweep.MODES, ['smoke', 'full-11e', 'accuracy-11f', 'followup-11g', 'round1', 'smoke-round1']);
    assert.equal(sweep.parseSweepMode('round1\n'), 'round1');
    assert.equal(sweep.parseSweepMode('smoke-round1 # first'), 'smoke-round1');
    assert.equal(sweep.parseSweepMode('followup-11g'), 'followup-11g');
    assert.deepEqual(sweep.ROUND1_SIZES, [25, 100]);
    assert.equal(sweep.ROUND1_CAP_USD, 15);
    assert.equal(sweep.ACCURACY_CONCURRENCY, 6);
    assert.equal(sweep.ROUND1_POSITIVES, 100);
    assert.equal(sweep.ROUND1_EASY_NEGATIVES, 60);
    assert.equal(sweep.ROUND1_HARD_NEGATIVES, 60);
  });
  it('pins the hint strings word for word', () => {
    assert.equal(sweep.SEARCH_HINT, SEARCH_HINT);
    assert.equal(sweep.HINT, SLIM_SEARCH_HINT, 'the long measured hint of 11g');
    assert.equal(sweep.STRONG_HINT, H2);
    assert.equal(sweep.LH2_HINT, LH2);
    assert.equal(H2, `${LH2} If none fit, call armory_find with what you want to do.`, 'LH2 is the strong hint without its last sentence');
  });
  it('has the five arms: C, CL, H2, D and LH2', () => {
    assert.deepEqual(sweep.ARMS_ROUND1.map((a: any) => a.name), ['C', 'CL', 'H2', 'D', 'LH2']);
    assert.equal(sweep.ROUND1_BASELINE, 'C');
    const a = by();
    for (const x of sweep.ARMS_ROUND1) assert.deepEqual(x.settings, {}, `${x.name} keeps the full listing`);
    assert.equal(a.C.append, SEARCH_HINT, "no probe line: Legion sends only the hint");
    assert.equal(a.CL.append, SLIM_SEARCH_HINT);
    assert.equal(a.H2.append, H2);
    assert.equal(a.D.append, a.C.append, 'D differs from C only in what a hit shows');
    assert.equal(a.LH2.append, LH2);
    for (const arm of Object.values(a) as any[]) assert.ok(!String(arm.append).includes(PROBE), `${arm.name} carries no probe line`);
    for (const n of ['C', 'CL', 'H2', 'D']) assert.equal(a[n].search && a[n].thirdParty, true, `${n} searches and shows hits as third-party`);
    assert.equal(a.LH2.search, false, 'LH2 has no armory_find');
    assert.ok(!a.LH2.thirdParty);
    assert.equal(a.D.describeHits, true);
    for (const n of ['C', 'CL', 'H2', 'LH2']) assert.ok(!a[n].describeHits);
  });
  it('writes the find phrase once in the source, so the hints cannot drift apart', () => {
    const src = readFileSync(new URL('scripts/skill-finder-sweep.mjs', REPO), 'utf8');
    assert.equal(src.split('call armory_find with what you want to do').length - 1, 1);
  });
  it('uses the smoke arms C, D and LH2', () => {
    assert.deepEqual(sweep.ARMS_SMOKE_ROUND1.map((a: any) => a.name), ['C', 'D', 'LH2']);
  });
});

describe('round1: the description a search hit may show (arm D)', () => {
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  const clean = (s: string, cap?: number) => sweep.sanitizeHitDescription(s, oneLine, cap);
  it('collapses whitespace like oneLine and caps at 120 characters', () => {
    assert.equal(clean('  Export   invoices\n\nto\tPDF  '), 'Export invoices to PDF');
    assert.equal(sweep.HIT_DESCRIPTION_CHARS, 120);
    assert.equal(clean('x'.repeat(300)).length, 120);
    assert.equal(clean('y'.repeat(120)).length, 120);
    assert.equal(clean(`${'z'.repeat(119)} tail`), 'z'.repeat(119), 'the cut leaves no trailing space');
  });
  it('strips control, zero-width, bidi and tag characters', () => {
    assert.equal(clean('a\u0000b\u0007c\u001bd\u007fe\u009ff'), 'abcdef');
    for (const ch of ['​', '‌', '‍', '‎', '‏', '‪', '‮', '⁠', '⁦', '⁩', '﻿', '­']) {
      assert.equal(clean(`hid${ch}den`), 'hidden', `U+${ch.codePointAt(0)!.toString(16)}`);
    }
    assert.equal(clean(`tag${String.fromCodePoint(0xE0041)}${String.fromCodePoint(0xE007F)}ged`), 'tagged');
  });
  it('strips before it cuts, so hidden text does not eat the 120 characters', () => {
    const text = `${'​'.repeat(200)}${'a'.repeat(130)}`;
    assert.equal(clean(text), 'a'.repeat(120));
  });
  it('gives an empty text for nothing, and never throws on odd input', () => {
    assert.equal(clean(''), '');
    assert.equal(clean(undefined as any), '');
    assert.equal(clean('​​'), '');
  });
  it('shows the text as `- id (third-party): description` through the real armory_find handler, and counts the lines', async () => {
    const mods = await sweep.loadArmory();
    const items = [
      { name: 'pdf-export', description: 'Export invoices and reports to PDF files.​' },
      { name: 'git-helper', description: 'Rebase, merge and resolve git conflicts.' },
    ];
    const search = sweep.makeSearch(mods, [{ size: 2, items }]);
    const hits = search.forSize(2, true, true)('export invoices to pdf', 5);
    assert.ok(hits.length > 0 && hits.every((h: any) => h.thirdParty === true && typeof h.description === 'string'));
    let counted = 0;
    const server = search.buildServer(search.forSize(2, true, true), { describe: true, onDescribed: (n: number) => { counted += n; } });
    const text = (await server.instance._registeredTools.armory_find.handler({ query: 'export invoices to pdf' }, {})).content[0].text as string;
    assert.match(text, /^\d+ skill\(s\) may fit:\n- pdf-export \(third-party\): Export invoices and reports to PDF files\.$/m);
    assert.ok(text.split('\n').slice(1).every((l) => /^- \S+ \(third-party\): .+$/.test(l)), 'every line has the third-party tag and a description');
    assert.ok(!text.includes('​'));
    assert.equal(counted, text.split('\n').length - 1);
    const plain = search.buildServer(search.forSize(2, true), {});
    const bare = (await plain.instance._registeredTools.armory_find.handler({ query: 'export invoices to pdf' }, {})).content[0].text as string;
    assert.ok(bare.split('\n').slice(1).every((l) => /^- \S+ \(third-party\)$/.test(l)), 'the other arms still get the id only');
  });
  it('refuses to run when the real handler is missing, so D never silently equals C', () => {
    assert.throws(() => sweep.showDescriptions({ type: 'sdk' }, new Map()), (e: any) => e.code === 'NO_FIND_HANDLER');
    assert.throws(() => sweep.showDescriptions({ type: 'sdk', instance: { _registeredTools: {} } }, new Map()), (e: any) => e.code === 'NO_FIND_HANDLER');
  });
});

describe('round1: the equivalence judge', () => {
  it('parses flags per item and ignores anything else', () => {
    const m = sweep.parseEquivalence('noise ```json\n[{"n":1,"a":1,"b":0},{"n":2,"a":"1","b":1},{"n":"x"},{"n":3}]\n```');
    assert.deepEqual(m.get(1), { a: 1, b: 0 });
    assert.deepEqual(m.get(2), { a: 1, b: 1 });
    assert.equal(m.has(3), false);
    assert.equal(sweep.parseEquivalence('not json').size, 0);
  });
  it('accepts only when both orders say the called skill solves the request', () => {
    // Run 1 shows the gold skill as A and the called skill as B; run 2 shows them the other way round.
    assert.equal(sweep.acceptEquivalent({ a: 1, b: 1 }, { a: 1, b: 1 }), true);
    assert.equal(sweep.acceptEquivalent({ a: 1, b: 1 }, { a: 0, b: 1 }), false, 'run 2 says the called skill (now A) does not solve it');
    assert.equal(sweep.acceptEquivalent({ a: 1, b: 0 }, { a: 1, b: 1 }), false, 'run 1 says the called skill (B) does not');
    assert.equal(sweep.acceptEquivalent({ a: 0, b: 1 }, { a: 1, b: 0 }), true, 'the gold flag does not matter, only the called skill');
    assert.equal(sweep.acceptEquivalent(undefined, { a: 1, b: 1 }), false, 'an answer that did not parse is not accepted');
    assert.equal(sweep.acceptEquivalent({ a: 1, b: 1 }, undefined), false);
  });
  const desc = (n: string) => ({ gold: 'GOLD-DESC', called: 'CALLED-DESC', other: undefined }[n as 'gold']);
  const fakeJudge = (log: string[], rule: (order: 'gold-first' | 'called-first', n: number) => { a: number; b: number }) => ({ prompt, options }: any) => (async function* () {
    log.push(String(options.systemPrompt));
    assert.deepEqual(options.tools, []);
    const text = String(prompt);
    assert.ok(!/\bC\b|\bH2\b|\bLH2\b|\barm\b/i.test(text.replace(/\bSkill [AB]\b/g, '')), 'the judge is not told which arm made the call');
    const items = [...text.matchAll(/Item (\d+)\nRequest: [^\n]*\nSkill A: [^\n]*?(GOLD|CALLED)-DESC/g)];
    const out = items.map((m) => ({ n: Number(m[1]), ...rule(m[2] === 'GOLD' ? 'gold-first' : 'called-first', Number(m[1])) }));
    yield { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(out) }] } };
    yield { type: 'result', total_cost_usd: 0.01, usage: {} };
  })();
  it('runs every pair twice with the order swapped, and accepts a pair only if both runs agree', async () => {
    const log: string[] = [];
    const query = fakeJudge(log, (order, n) => (n === 2 && order === 'called-first' ? { a: 0, b: 1 } : { a: 1, b: 1 }));
    const pairs = [
      { key: 'k1', prompt: 'make a pdf', gold: 'gold', called: 'called' },
      { key: 'k2', prompt: 'make a doc', gold: 'gold', called: 'called' },
      { key: 'k3', prompt: 'make a pdf', gold: 'gold', called: 'other' },
    ];
    const spend = sweep.makeSpend(5);
    const { verdicts, stats } = await sweep.judgeEquivalence({ query, spend, pairs, describe: desc, cwd: process.cwd() });
    assert.equal(log.length, 2, 'one batch, two runs');
    assert.equal(verdicts.get('k1'), 'yes');
    assert.equal(verdicts.get('k2'), 'no', 'the swapped run disagreed');
    assert.equal(verdicts.get('k3'), 'unknown', 'a called skill with no description in the catalog is never accepted');
    assert.deepEqual(stats, { pairs: 3, accepted: 1, rejected: 1, unknown: 1, unjudged: 0 });
    assert.ok(spend.calls === 2 && spend.spent > 0);
  });
  it('leaves a pair unjudged when the answer does not parse or the budget is gone', async () => {
    const bad = () => (async function* () { yield { type: 'assistant', message: { content: [{ type: 'text', text: 'I cannot say' }] } }; yield { type: 'result', total_cost_usd: 0.01, usage: {} }; })();
    const pairs = [{ key: 'k1', prompt: 'p', gold: 'gold', called: 'called' }];
    const a = await sweep.judgeEquivalence({ query: bad, spend: sweep.makeSpend(5), pairs, describe: desc, cwd: process.cwd() });
    assert.equal(a.verdicts.get('k1'), 'no');
    assert.equal(a.stats.rejected, 1);
    const b = await sweep.judgeEquivalence({ query: bad, spend: sweep.makeSpend(0.0001), pairs, describe: desc, cwd: process.cwd() });
    assert.equal(b.verdicts.get('k1'), 'unjudged');
    assert.equal(b.stats.unjudged, 1);
  });
});

describe('round1: hard negatives', () => {
  it('reads one verdict per item and leaves a missing or odd one undefined', () => {
    const v = sweep.parseHardVerdicts('[{"n":1,"verdict":"none"},{"n":2,"verdict":"Ambiguous"},{"n":3,"verdict":"applies"},{"n":4,"verdict":"maybe"}]', 5);
    assert.deepEqual(v, ['none', 'ambiguous', 'applies', undefined, undefined]);
    assert.deepEqual(sweep.parseHardVerdicts('nope', 2), [undefined, undefined]);
  });
  it('keeps only "none applies" as hard, holds "ambiguous" apart, drops "applies", and caps each bucket', () => {
    const cands = Array.from({ length: 10 }, (_, i) => ({ prompt: `req ${i}`, source: `s${i}` }));
    const verdicts = ['none', 'ambiguous', 'applies', 'none', undefined, 'ambiguous', 'none', 'none', 'ambiguous', 'none'];
    const r = sweep.bucketHardNegatives(cands, verdicts, { hardMax: 3, ambMax: 2 });
    assert.deepEqual(r.hard, ['req 0', 'req 3', 'req 6']);
    assert.deepEqual(r.ambiguous, ['req 1', 'req 5']);
    assert.equal(r.applies, 1);
    assert.equal(r.unjudged, 1);
    assert.deepEqual(r.overflow, { hard: 2, ambiguous: 1 }, 'the extra ones are counted, not lost without a trace');
  });
  it('defaults to 60 hard and 20 ambiguous', () => {
    const cands = Array.from({ length: 200 }, (_, i) => ({ prompt: `r${i}`, source: 's' }));
    const r = sweep.bucketHardNegatives(cands, cands.map((_, i) => (i % 4 === 0 ? 'ambiguous' : 'none')));
    assert.equal(r.hard.length, 60);
    assert.equal(r.ambiguous.length, 20);
  });
});

describe('round1: the called name and the listing', () => {
  it('normalises the called name as isGold does', () => {
    assert.equal(sweep.normalizeSkillName('/Plugin:My Skill'), 'my-skill');
    assert.equal(sweep.normalizeSkillName('pdf-export'), 'pdf-export');
    assert.equal(sweep.normalizeSkillName(null), null);
    assert.equal(sweep.isGold('/p:pdf-export', 'pdf-export'), true);
  });
  it('counts listed skills that carry a description only when the list shows any', () => {
    assert.equal(shared.describedCount(['a', 'b']), null, 'names only: not observable');
    assert.equal(shared.describedCount([{ name: 'a', description: 'x' }, { name: 'b' }, { name: 'c', description: '' }]), 1);
    assert.equal(shared.describedCount(undefined), null);
  });
});

const rec = (size: number, arm: string, kind: string, i: number, over: Record<string, unknown> = {}) => ({
  size, i, kind, arm, hit: false, accepted: false, called: false, calledName: null, tokens: 100, searches: 0, goldInTop5: false, bucket: null, ...over,
});

describe('round1: the miss split', () => {
  it('splits strict misses into four parts that add up, plus the two top-5 counts', () => {
    const r = [
      rec(100, 'H2', 'pos', 0, { hit: true, accepted: true, called: true }),
      rec(100, 'H2', 'pos', 1, { called: false, searches: 0 }),
      rec(100, 'H2', 'pos', 2, { called: false, searches: 1, goldInTop5: false }),
      rec(100, 'H2', 'pos', 3, { called: false, searches: 2, goldInTop5: true }),
      rec(100, 'H2', 'pos', 4, { called: true, calledName: 'other', accepted: true, searches: 0 }),
      rec(100, 'H2', 'pos', 5, { called: true, calledName: 'wrong', accepted: false, searches: 1, goldInTop5: true }),
      rec(100, 'H2', 'pos', 6, { called: true, calledName: 'wrong', accepted: false, searches: 1, goldInTop5: false }),
      rec(25, 'H2', 'pos', 7, {}),
      rec(100, 'C', 'pos', 8, {}),
      rec(100, 'H2', 'neg', 9, { called: true }),
    ];
    const s = sweep.missSplit(r, 100, 'H2');
    assert.equal(s.positives, 7);
    assert.equal(s.misses, 6);
    assert.equal(s.noCallNoSearch, 1);
    assert.equal(s.noCallSearched, 2);
    assert.equal(s.acceptedAlternative, 1);
    assert.equal(s.wrongSkill, 2);
    assert.equal(s.noCallNoSearch + s.noCallSearched + s.acceptedAlternative + s.wrongSkill, s.misses);
    assert.equal(s.searchedGoldNotTop5, 2, 'searched at least once and the gold skill was never in the first five');
    assert.equal(s.goldTop5NotLoaded, 2, 'the gold skill was in the first five and the first Skill call did not name it');
  });
  it('does not count a strict hit as a miss even when the judge was not asked', () => {
    const s = sweep.missSplit([rec(25, 'C', 'pos', 0, { hit: true, accepted: true, called: true })], 25, 'C');
    assert.equal(s.misses, 0);
  });
});

describe('round1: the comparison and the rule', () => {
  /** Positives i = 0..n-1; the base gets `base` of them right and the arm `arm`, paired by position (arm-only ones come after base-only). */
  const make = (size: number, name: string, n: number, baseOnly: number, armOnly: number, both: number, extra: { baseLoads?: number; armLoads?: number; hardBase?: number; hardArm?: number; ambArm?: number } = {}) => {
    const out: any[] = [];
    let i = 0;
    const pos = (b: boolean, a: boolean) => { out.push(rec(size, 'C', 'pos', i, { hit: b, accepted: b, called: b })); out.push(rec(size, name, 'pos', i, { hit: a, accepted: a, called: a })); i++; };
    for (let k = 0; k < both; k++) pos(true, true);
    for (let k = 0; k < baseOnly; k++) pos(true, false);
    for (let k = 0; k < armOnly; k++) pos(false, true);
    for (; i < n;) pos(false, false);
    const neg = (bucket: string, k: number, b: boolean, a: boolean) => { out.push(rec(size, 'C', 'neg', 1000 + k, { bucket, called: b })); out.push(rec(size, name, 'neg', 1000 + k, { bucket, called: a })); };
    for (let k = 0; k < 60; k++) neg('easy', k, k < (extra.baseLoads ?? 0), k < (extra.armLoads ?? 0));
    for (let k = 0; k < 60; k++) neg('hard', 100 + k, k < (extra.hardBase ?? 0), k < (extra.hardArm ?? 0));
    for (let k = 0; k < 20; k++) neg('ambiguous', 200 + k, false, k < (extra.ambArm ?? 0));
    return out;
  };
  const rows = (name: string, recs: any[]) => [25, 100].map((s) => sweep.compareRound1(recs, s, 'C', name));

  it('keeps ambiguous negatives out of the pooled false loads and reports them apart', () => {
    const recs = make(100, 'H2', 100, 0, 10, 60, { baseLoads: 2, armLoads: 3, hardBase: 1, hardArm: 2, ambArm: 5 });
    const row = sweep.compareRound1(recs, 100, 'C', 'H2');
    assert.equal(row.neg.easy.n, 60);
    assert.equal(row.neg.hard.n, 60);
    assert.equal(row.neg.pooled.n, 120);
    assert.equal(row.neg.pooled.loadsBase, 3);
    assert.equal(row.neg.pooled.loadsArm, 5);
    assert.equal(row.neg.ambiguous.n, 20);
    assert.equal(row.neg.ambiguous.loadsArm, 5);
    assert.equal(row.accepted.pairs, 100, 'the positives are the pairs; no negative is counted as one');
  });
  it('counts loads and searches apart', () => {
    const recs = [
      rec(100, 'C', 'neg', 0, { bucket: 'easy', called: false, searches: 1 }), rec(100, 'D', 'neg', 0, { bucket: 'easy', called: false, searches: 1 }),
      rec(100, 'C', 'neg', 1, { bucket: 'hard', called: true, searches: 0 }), rec(100, 'D', 'neg', 1, { bucket: 'hard', called: true, searches: 2 }),
    ];
    const n = sweep.compareRound1(recs, 100, 'C', 'D').neg.pooled;
    assert.deepEqual([n.loadsBase, n.loadsArm, n.searchesBase, n.searchesArm], [1, 1, 1, 2]);
  });
  it('reports strict and accepted gold side by side', () => {
    const recs = make(100, 'D', 100, 0, 8, 50);
    // Three of the arm's strict misses are accepted alternatives.
    let flipped = 0;
    for (const r of recs) if (r.arm === 'D' && r.kind === 'pos' && !r.hit && flipped < 3) { r.accepted = true; r.called = true; flipped++; }
    const row = sweep.compareRound1(recs, 100, 'C', 'D');
    assert.equal(row.strict.goldArm, 58);
    assert.equal(row.accepted.goldArm, 61);
    assert.equal(row.accepted.goldBase, 50);
  });
  it('passes at 100 with +5 points and a significant McNemar, and holds at 25', () => {
    const rule = (name: string, recs: any[]) => sweep.decideRound1({ [name]: rows(name, recs) }).arms[0];
    const good = [...make(100, 'H2', 100, 1, 14, 50), ...make(25, 'H2', 25, 0, 0, 20)];
    assert.equal(rule('H2', good).pass, true);
    const five = [...make(100, 'H2', 100, 0, 5, 50), ...make(25, 'H2', 25, 0, 0, 20)];
    assert.equal(rule('H2', five).pass, false, '+5 points is not significant at 5 versus 0 (exact p = 0.0625)');
    const six = [...make(100, 'H2', 100, 0, 6, 50), ...make(25, 'H2', 25, 0, 0, 20)];
    assert.equal(rule('H2', six).pass, true, '+6 points at 6 versus 0 (exact p = 0.03125) passes');
  });
  it('fails below +5 points, without significance, with a loss of two at 25, or with more than two extra false loads', () => {
    const at = (a: any[], b: any[]) => sweep.decideRound1({ X: rows('X', [...a, ...b]) }).arms[0];
    const ok100 = make(100, 'X', 100, 0, 15, 50);
    const ok25 = make(25, 'X', 25, 0, 0, 20);
    assert.equal(at(ok100, ok25).pass, true);
    assert.equal(at(make(100, 'X', 100, 0, 4, 50), ok25).pass, false, '+4 points');
    assert.equal(at(make(100, 'X', 100, 3, 8, 50), ok25).pass, false, '+5 points but 8 versus 3 is not significant');
    assert.equal(at(ok100, make(25, 'X', 25, 2, 0, 20)).pass, false, 'two items lower at 25');
    assert.equal(at(ok100, make(25, 'X', 25, 1, 0, 20)).pass, true, 'one item lower at 25 is allowed');
    assert.equal(at(make(100, 'X', 100, 0, 15, 50, { baseLoads: 0, armLoads: 2, hardBase: 0, hardArm: 1 }), ok25).pass, false, 'three extra pooled false loads');
    assert.equal(at(make(100, 'X', 100, 0, 15, 50, { baseLoads: 0, armLoads: 1, hardBase: 0, hardArm: 1 }), ok25).pass, true, 'exactly two extra pooled false loads');
    assert.equal(at(ok100, make(25, 'X', 25, 0, 0, 20, { armLoads: 3 })).pass, false, 'the false-load limit holds at 25 too');
  });
  it('fails an arm with no 100-skill or no 25-skill row, and says why', () => {
    const only25 = sweep.decideRound1({ X: [sweep.compareRound1(make(25, 'X', 25, 0, 0, 20), 25, 'C', 'X')] });
    assert.equal(only25.arms[0].pass, false);
    assert.ok(only25.arms[0].reasons.some((r: string) => /100/.test(r)));
  });
  it('reads the CL against C line: only a significant gain means the short hint loses gain', () => {
    const win = rows('CL', [...make(100, 'CL', 100, 0, 12, 50), ...make(25, 'CL', 25, 0, 0, 20)]);
    assert.match(sweep.clVerdict(win), /loses gain/);
    const same = rows('CL', [...make(100, 'CL', 100, 3, 4, 50), ...make(25, 'CL', 25, 0, 0, 20)]);
    assert.match(sweep.clVerdict(same), /keeps the gain/);
    const worse = rows('CL', [...make(100, 'CL', 100, 12, 0, 50), ...make(25, 'CL', 25, 0, 0, 20)]);
    assert.match(sweep.clVerdict(worse), /keeps the gain/, 'a significant loss for CL is not a gain for it');
  });
  it('prints the rule before the results and names the report-only line', () => {
    const t = sweep.ruleTextRound1();
    assert.ok(t.startsWith('Pre-registered rule'));
    for (const frag of ['C (the full listing', 'accepted gold', 'at least 5 points', 'McNemar', 'not lower by more than one item at 25', 'at most C + 2', 'easy and hard', 'CL against C', 'report only']) assert.ok(t.includes(frag), frag);
    assert.deepEqual(sweep.ROUND1_RULE, { minGoldDiff: 0.05, mcnemarAlpha: 0.05, maxItemsLowerAtSmall: 1, maxExtraFalseLoads: 2, bigSize: 100, smallSize: 25 });
  });
});

// ---- the whole job on fakes ----

const NAMES = Array.from({ length: 120 }, (_, i) => `tool-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`);
const fakeFetch = async (url: string) => {
  const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });
  if (url === 'https://skills.sh/') return ok(`<html>${NAMES.map((n) => `<a href="/o/r/${n}">${n}</a>`).join('')}</html>`);
  if (url.startsWith('https://skills.sh/')) return ok('<html></html>');
  if (url.includes('/git/trees/')) return ok(JSON.stringify({ tree: NAMES.map((n) => ({ type: 'blob', path: `skills/${n}/SKILL.md` })) }));
  const raw = /skills\/([^/]+)\/SKILL\.md/.exec(url);
  return raw ? ok(`---\nname: ${raw[1]}\ndescription: Helps with ${raw[1].replace(/-/g, ' ')} work for SECRETDESC people.\n---\nbody`) : { ok: false, status: 404, text: async () => '' };
};

function fakeQueryR1(log: { probes: number; shown: string[]; judges: number; systems: Set<string>; arms: Map<string, number> }) {
  return ({ prompt, options }: any) => (async function* () {
    if (options.tools?.length === 0) {
      const sys = String(options.systemPrompt);
      let body = '[]';
      const n = [...String(prompt).matchAll(/Item (\d+)/g)].length;
      if (sys.includes('write realistic test requests')) {
        const ns = [...String(prompt).matchAll(/Skill (\d+): ([\w-]+)/g)];
        body = JSON.stringify(ns.map((m) => ({ n: Number(m[1]), requests: [`please deal with ${m[2].split('-')[1]} stuff now`, `I need help getting ${m[2].split('-')[1]} done`] })));
        log.systems.add('gen');
      } else if (sys.includes('everyday requests')) {
        body = JSON.stringify(Array.from({ length: 50 }, (_, i) => `fix the loop in my script number ${i}`));
        log.systems.add('easy');
      } else if (sys.includes('a target skill')) {
        body = JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, ok: 1 })));
        log.systems.add('posjudge');
      } else if (sys.includes('none applies')) {
        body = JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, verdict: i % 4 === 3 ? 'ambiguous' : i % 7 === 6 ? 'applies' : 'none' })));
        log.systems.add('hardjudge');
      } else if (sys.includes('plain, everyday-sounding')) {
        const ns = [...String(prompt).matchAll(/Skill (\d+): ([\w-]+)/g)];
        body = JSON.stringify(ns.map((m) => ({ n: Number(m[1]), request: `what does ${m[2].split('-')[1]} mean in general terms ${m[2]}` })));
        log.systems.add('hardgen');
      } else if (sys.includes('Both skills are candidates')) {
        log.judges++;
        body = JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, a: 1, b: 1 })));
        log.systems.add('equiv');
      } else {
        body = JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, applies: 0 })));
        log.systems.add('negjudge');
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: body }] } };
      yield { type: 'result', total_cost_usd: 0.002, usage: {} };
      return;
    }
    log.probes++;
    // C and D share one system text (D differs in what a hit shows), so they get one label.
    const arm = sweep.ARMS_ROUND1.filter((x: any) => x.append === String(options.systemPrompt?.append ?? '')).map((x: any) => x.name).join('/');
    log.arms.set(arm, (log.arms.get(arm) ?? 0) + 1);
    const search = options.mcpServers?.legion_armory;
    assert.equal(Boolean(search), arm !== 'LH2');
    assert.equal(options.maxTurns, search ? 4 : 1);
    const word = /(?:deal with|getting) (\w+)/.exec(String(prompt))?.[1];
    const dir = join(String(options.env.HOME), '.claude', 'skills');
    const names = existsSync(dir) ? readdirSync(dir) : [];
    const gold = names.find((n) => n.split('-')[1] === word);
    // H2 and LH2 load a skill for every request; on a "getting" request H2 picks another skill than the gold one.
    const eager = arm === 'H2' || arm === 'LH2';
    const hardNeg = /^what does/.test(String(prompt));
    if (search) {
      const res = await search.instance._registeredTools.armory_find.handler({ query: String(word ?? 'stuff') }, {});
      log.shown.push(...String(res.content[0].text).split('\n').slice(1).filter(Boolean).map((l: string) => `${arm}|${l}`));
      yield { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 5, cache_read_input_tokens: 40 }, content: [{ type: 'tool_use', name: 'mcp__legion_armory__armory_find', input: { query: 'SECRET QUERY TEXT' } }] } };
    }
    const wrong = names.find((n) => n !== gold);
    const pick = hardNeg ? names[0] : eager && /getting/.test(String(prompt)) ? wrong : gold;
    // CL stays silent on "getting" requests (a miss with no Skill call); the eager arms also load a skill for a hard negative.
    const calls = hardNeg ? eager : Boolean(gold) && !(arm === 'CL' && /getting/.test(String(prompt)));
    if (calls && pick) yield { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 5, cache_read_input_tokens: 60 }, content: [{ type: 'tool_use', name: 'Skill', input: { skill: `/plug:${pick}` } }] } };
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
      return { content: [{ type: 'text', text: `${hits.length} skill(s) may fit:\n${hits.map((h: any) => (h.thirdParty ? `- ${h.id} (third-party)` : `- ${h.id} (0.50)`)).join('\n')}` }] };
    } } } },
  });
  return { ...real, buildFindServer };
};

describe('round1: the whole job on fakes', () => {
  it('runs five arms at 25 and 100, scores alternatives, splits the misses and freezes the sets without skill text', async () => {
    const log = { probes: 0, shown: [] as string[], judges: 0, systems: new Set<string>(), arms: new Map<string, number>() };
    const root = tempDir('sweep-r1-');
    const { summary, result, frozen } = await sweep.runSweep({ query: fakeQueryR1(log), fetch: fakeFetch, mode: 'round1', cap: 60, root, armory: await fakeArmory(), log: () => {}, sleep: async () => {} });
    assert.equal(result.mode, 'round1');
    assert.deepEqual(result.sizes, [25, 100]);
    assert.deepEqual(result.arms.map((a: any) => a.arm), ['C', 'CL', 'H2', 'D', 'LH2']);
    assert.deepEqual(Object.keys(result.rows), ['CL', 'H2', 'D', 'LH2']);
    for (const s of ['gen', 'easy', 'posjudge', 'negjudge', 'hardgen', 'hardjudge', 'equiv']) assert.ok(log.systems.has(s), `the ${s} step ran`);
    assert.ok(log.judges >= 2 && log.judges % 2 === 0, 'the equivalence judge runs in pairs of swapped orders');
    // D shows descriptions, the others do not.
    const shownBy = (arm: string) => log.shown.filter((l) => l.startsWith(`${arm}|`));
    assert.ok(shownBy('C/D').some((l) => /\(third-party\): Helps with /.test(l)), 'D shows a description');
    assert.ok(shownBy('C/D').some((l) => /\(third-party\)$/.test(l)), 'C shows the id only');
    assert.ok(shownBy('C/D').every((l) => /\(third-party\)(: Helps with .*)?$/.test(l)));
    for (const arm of ['CL', 'H2']) assert.ok(shownBy(arm).length > 0 && shownBy(arm).every((l) => /\(third-party\)$/.test(l)), arm);
    assert.equal(shownBy('LH2').length, 0);
    assert.ok(result.describedHits.D > 0 && result.describedHits.C === 0);
    // H2 and LH2 call a wrong skill on "getting" requests, which the equivalence judge accepts.
    const h2 = result.rows.H2.find((r: any) => r.size === 100);
    assert.ok(h2.accepted.goldArm > h2.strict.goldArm, 'accepted gold is above strict gold');
    assert.ok(result.equivalence.accepted > 0);
    const split = result.missSplit.find((m: any) => m.arm === 'H2' && m.size === 100);
    assert.equal(split.noCallNoSearch + split.noCallSearched + split.acceptedAlternative + split.wrongSkill, split.misses);
    // Hard-negative buckets, reported apart.
    assert.ok(result.prompts.hardKept > 0 && result.prompts.hardAmbiguous > 0);
    const neg = result.rows.H2.find((r: any) => r.size === 100).neg;
    assert.ok(neg.hard.n > 0 && neg.easy.n > 0 && neg.ambiguous.n > 0 && neg.pooled.n === neg.easy.n + neg.hard.n);
    // Listing: names only.
    assert.equal(result.listing.describedObservable, false);
    assert.ok(result.listing.meanListed > 0);
    // The summary: rule first, then the sections.
    assert.ok(summary.indexOf('Pre-registered rule') < summary.indexOf('## Results'));
    for (const h of ['## Results against C', '## Misses', '## Hard negatives', '## Decision', '## Listing', 'CL against C', 'not observable']) assert.ok(summary.includes(h), h);
    // Privacy: no request, no query and no skill description in anything public.
    const pub = JSON.stringify(result) + summary;
    assert.ok(!pub.includes('SECRET QUERY TEXT') && !pub.includes('SECRETDESC') && !pub.includes('please deal with') && !pub.includes('fix the loop') && !pub.includes('what does'));
    // The frozen sets hold the prompts and gold ids, and no description text.
    assert.deepEqual(Object.keys(frozen).sort(), ['catalog', 'negatives', 'positives', 'seed', 'sizes', 'version']);
    assert.ok(frozen.positives['100'].length > 0 && frozen.positives['25'].length > 0);
    assert.ok(frozen.positives['100'].every((p: any) => typeof p.prompt === 'string' && typeof p.gold === 'string' && Object.keys(p).length === 2));
    assert.ok(frozen.negatives.easy.length > 0 && frozen.negatives.hard.length > 0 && frozen.negatives.ambiguous.length > 0);
    assert.ok(!JSON.stringify(frozen).includes('SECRETDESC') && !JSON.stringify(frozen).includes('Helps with'));
    assert.deepEqual(frozen.catalog['100'].every((n: string) => NAMES.includes(n)), true);
    assert.equal(readdirSync(root).length, 0);
  });
  it('keeps query texts out of the records', async () => {
    const calls: string[] = [];
    const search = { forSize: () => async () => [{ id: 'a', score: 1, thirdParty: true }], buildServer: (find: any) => ({ type: 'sdk', find }) };
    const query = ({ options }: any) => (async function* () {
      await options.mcpServers.legion_armory.find('SECRET QUERY TEXT', 5);
      calls.push('x');
      yield { type: 'result', total_cost_usd: 0.001, usage: {} };
    })();
    const homes = new Map([[25, process.cwd()]]);
    const { records } = await sweep.runArms({ query, spend: sweep.makeSpend(5), items: [{ size: 25, i: 0, kind: 'pos', prompt: 'p', gold: 'a' }], homes, arms: [sweep.ARMS_ROUND1[0]], search, concurrency: 1, workDir: process.cwd() });
    assert.equal(records[0].searches, 1);
    assert.deepEqual(records[0].queries, ['SECRET QUERY TEXT'], 'available in memory for the miss split');
    assert.ok(!JSON.stringify(records).includes('SECRET QUERY TEXT'), 'but never serialised');
    assert.equal(calls.length, 1);
  });
});

describe('round1: the workflow and the mode file', () => {
  const yml = readFileSync(new URL('.github/workflows/skill-finder-sweep.yml', REPO), 'utf8').replace(/\r\n/g, '\n');
  it('uploads the frozen sets as their own artifact and keeps the token in the sweep step only', () => {
    assert.match(yml, /name: round1-frozen\n\s+path: round1-frozen\.json/);
    assert.match(yml, /--frozen round1-frozen\.json/);
  });
  it('lists round1 and smoke-round1 in the workflow comment', () => {
    assert.ok(yml.includes('round1') && yml.includes('smoke-round1'));
  });
});

describe('round1: the budget and the order of the items', () => {
  it('keeps the judge reserve out of the arms\' reach, after the prompts have spent theirs', () => {
    const spend = sweep.makeSpend(15);
    spend.add(3);
    const arms = sweep.armBudget(spend, 15);
    assert.ok(Math.abs(arms.left() - 10.5) < 1e-9, 'a tenth of the cap is held back');
    arms.add(10.5);
    assert.ok(Math.abs(spend.left() - 1.5) < 1e-9, 'what is left for the judge');
    assert.equal(arms.fits(0.01), false);
    assert.equal(sweep.makeSpend(1).left(), 1);
    const broke = sweep.makeSpend(1);
    broke.add(2);
    assert.equal(sweep.armBudget(broke, 1).fits(0.001), false, 'nothing fits once the cap is gone');
  });
  it('uses one fixed negative pool at every size and spreads it evenly, so a stop at the cap keeps the same share of each kind', () => {
    const skills = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `sk-${i}`, description: `d${i}` }));
    const subsets = [{ size: 25, items: skills(25) }, { size: 100, items: skills(100) }];
    const positives = Array.from({ length: 200 }, (_, i) => ({ prompt: `p${i}`, gold: `sk-${i % 100}` }));
    const prompts = { positives, negatives: Array.from({ length: 150 }, (_, i) => `easy ${i}`) };
    const hard = Array.from({ length: 80 }, (_, i) => `hard ${i}`);
    const amb = Array.from({ length: 30 }, (_, i) => `amb ${i}`);
    const { items } = sweep.planItems(subsets, prompts, 100, 60, tempDir('sweep-plan-'), { hard, amb, proportional: true });
    const of = (size: number) => items.filter((it: any) => it.size === size);
    const negs = (size: number) => of(size).filter((it: any) => it.kind === 'neg');
    assert.deepEqual(negs(25).map((n: any) => n.prompt).sort(), negs(100).map((n: any) => n.prompt).sort(), 'the same pool at every size');
    const count = (list: any[], b: string) => list.filter((it) => it.bucket === b).length;
    assert.deepEqual([count(negs(100), 'easy'), count(negs(100), 'hard'), count(negs(100), 'ambiguous')], [60, 60, 20]);
    assert.equal(of(100).filter((it: any) => it.kind === 'pos').length, 100);
    assert.equal(new Set(negs(100).map((n: any) => n.i)).size, 140, 'every negative has its own index');
    const half = of(100).slice(0, Math.floor(of(100).length / 2));
    const pos = half.filter((it: any) => it.kind === 'pos').length;
    assert.ok(Math.abs(pos - 50) <= 2, `about half the positives in the first half (${pos})`);
    for (const [b, want] of [['easy', 30], ['hard', 30], ['ambiguous', 10]] as const) assert.ok(Math.abs(count(half, b) - want) <= 2, `${b} ${count(half, b)}`);
  });
  it('keeps the older alternating order when round 1 is off', () => {
    const subsets = [{ size: 2, items: [{ name: 'sk-0', description: 'd' }, { name: 'sk-1', description: 'd' }] }];
    const prompts = { positives: [{ prompt: 'a b c d', gold: 'sk-0' }, { prompt: 'e f g h', gold: 'sk-1' }], negatives: ['n1 n1 n1', 'n2 n2 n2'] };
    const { items } = sweep.planItems(subsets, prompts, 100, 60, tempDir('sweep-plan-'));
    assert.deepEqual(items.map((it: any) => it.kind), ['pos', 'neg', 'pos', 'neg']);
    assert.ok(items.filter((it: any) => it.kind === 'neg').every((it: any) => it.bucket === 'easy'));
  });
});

describe('round1: the smoke run on fakes', () => {
  it('runs C, D and LH2 on one positive at 5 skills, shows the check and the frozen sets, and skips the results', async () => {
    const log = { probes: 0, shown: [] as string[], judges: 0, systems: new Set<string>(), arms: new Map<string, number>() };
    const root = tempDir('sweep-r1-smoke-');
    const { summary, result, frozen } = await sweep.runSweep({ query: fakeQueryR1(log), fetch: fakeFetch, mode: 'smoke-round1', cap: 1, root, armory: await fakeArmory(), log: () => {}, sleep: async () => {} });
    assert.equal(result.smoke, true);
    assert.deepEqual(result.sizes, [5]);
    assert.deepEqual(result.arms.map((a: any) => a.arm), ['C', 'D', 'LH2']);
    assert.equal(log.probes, 3, 'one positive, three arms, no negatives');
    assert.ok(!log.systems.has('hardgen'), 'no hard negatives in the smoke run');
    assert.ok(result.describedHits.D > 0, 'arm D showed a description');
    assert.ok(summary.includes('**Smoke run.**') && summary.includes('## Listing') && !summary.includes('## Results against'));
    assert.equal(frozen.positives['5'].length, 1);
    assert.deepEqual(frozen.negatives, { easy: [], hard: [], ambiguous: [] });
    assert.equal(readdirSync(root).length, 0);
  });
});

describe('round1: arm D through the server\'s own tools/call path', () => {
  const via = async (server: any, query: string) => {
    // A real MCP client over an in-memory pair: the call goes through the server's request dispatch, not straight to the handler.
    const clientPath = '@modelcontextprotocol/sdk/client/index.js';
    const memoryPath = '@modelcontextprotocol/sdk/inMemory.js';
    const { Client } = await import(clientPath);
    const { InMemoryTransport } = await import(memoryPath);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 'round1-test', version: '1' });
    await client.connect(clientSide);
    try {
      const res = await client.callTool({ name: 'armory_find', arguments: { query } });
      return (res.content as any[])[0].text as string;
    } finally {
      await client.close();
    }
  };
  it('returns descriptions for D and the id only for the other arms, through the dispatch', async () => {
    const mods = await sweep.loadArmory();
    const items = [{ name: 'pdf-export', description: 'Export invoices and reports to PDF files.​' }, { name: 'git-helper', description: 'Rebase, merge and resolve git conflicts.' }];
    const search = sweep.makeSearch(mods, [{ size: 2, items }]);
    let counted = 0;
    const d = await via(search.buildServer(search.forSize(2, true, true), { describe: true, onDescribed: (n: number) => { counted += n; } }), 'export invoices to pdf');
    assert.match(d, /^\d+ skill\(s\) may fit:\n- pdf-export \(third-party\): Export invoices and reports to PDF files\.$/m);
    assert.ok(!d.includes('​'));
    assert.ok(counted > 0, 'the wrapper ran on the dispatch path');
    const c = await via(search.buildServer(search.forSize(2, true), {}), 'export invoices to pdf');
    assert.ok(c.split('\n').slice(1).every((l) => /^- \S+ \(third-party\)$/.test(l)), 'C shows the id only');
  });
});

describe('round1: the check on arm D', () => {
  it('fails only when D searched and showed nothing; says "not exercised" when D never searched', () => {
    assert.equal(sweep.armDCheck([{ arm: 'C', searchCalled: 5, describedHits: 0 }]), '');
    assert.match(sweep.armDCheck([{ arm: 'D', searchCalled: 0, describedHits: 0 }]), /did not search.*not exercised/);
    assert.match(sweep.armDCheck([{ arm: 'D', searchCalled: 3, describedHits: 0 }]), /^\*\*Check failed\.\*\*/);
    assert.equal(sweep.armDCheck([{ arm: 'D', searchCalled: 3, describedHits: 7 }]), '');
  });
});
