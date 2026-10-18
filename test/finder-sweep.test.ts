/** Catalog-size sweep (scripts/skill-finder-sweep.mjs). A fake query and a fake fetch only: no network call, no model call. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempDir } from './tmp-cleanup.js';

const REPO = new URL('../../', import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const sweep: any = await import(new URL('scripts/skill-finder-sweep.mjs', REPO).href);
const shared: any = await import(new URL('scripts/lib/finder-shared.mjs', REPO).href);
void pathToFileURL;

const row = (size: number, over: Record<string, unknown> = {}) => ({
  size, pairs: 100, table: { both: 80, aOnly: 2, sOnly: 2, neither: 16 }, diff: 0, mcnemarP: 1, falseA: 0.05, falseS: 0.05, tokenSaving: 0.4, ...over,
});

describe('sweep: subsets and seed', () => {
  it('uses the pre-registered seed and sizes', () => {
    assert.equal(sweep.SEED, 20261018);
    assert.deepEqual(sweep.SIZES, [10, 25, 40, 60, 100, 200, 400]);
    assert.equal(sweep.CAP_USD, 15);
  });
  it('nests the subsets and repeats for the same seed', () => {
    const items = Array.from({ length: 400 }, (_, i) => `s${i}`);
    const subs = sweep.nestedSubsets(items, sweep.SIZES);
    assert.deepEqual(subs.map((s: any) => s.items.length), sweep.SIZES);
    for (let i = 1; i < subs.length; i++) {
      const bigger = new Set(subs[i].items);
      for (const x of subs[i - 1].items) assert.ok(bigger.has(x), 'a smaller subset sits inside the larger one');
    }
    assert.deepEqual(sweep.nestedSubsets(items, [10, 25])[1].items, subs[1].items);
    assert.notDeepEqual(sweep.nestedSubsets(items, [10], 1)[0].items, subs[0].items);
    assert.notDeepEqual(subs[0].items, items.slice(0, 10), 'it is shuffled, not the first ten');
  });
});

describe('sweep: McNemar', () => {
  it('gives exact two-sided p-values', () => {
    assert.equal(shared.mcnemar(0, 0), 1);
    assert.equal(shared.mcnemar(3, 3), 1);
    assert.ok(Math.abs(shared.mcnemar(5, 0) - 0.0625) < 1e-9);
    assert.ok(Math.abs(shared.mcnemar(10, 0) - 2 / 1024) < 1e-9);
    assert.ok(Math.abs(shared.mcnemar(1, 4) - 0.375) < 1e-9);
  });
});

describe('sweep: the threshold rule', () => {
  it('finds the smallest N from which every larger size passes', () => {
    const rows = [10, 25, 40, 60, 100, 200, 400].map((s) => row(s, s < 60 ? { tokenSaving: 0.05 } : {}));
    const d = sweep.decideThreshold(rows);
    assert.equal(d.n, 60);
    assert.equal(d.recommended, 40);
  });
  it('does not accept a pass that has a failing size above it', () => {
    const rows = [10, 25, 40, 60, 100, 200, 400].map((s) => row(s, s === 200 ? { diff: -0.05 } : {}));
    const d = sweep.decideThreshold(rows);
    assert.equal(d.n, 400);
    assert.equal(d.recommended, 200);
  });
  it('says no N when the largest size fails', () => {
    const rows = [10, 25, 400].map((s) => row(s, s === 400 ? { falseS: 0.2 } : {}));
    const d = sweep.decideThreshold(rows);
    assert.equal(d.n, null);
    assert.equal(d.recommended, null);
  });
  it('checks each of the four tests', () => {
    assert.equal(sweep.rowPasses(row(10)), true);
    assert.equal(sweep.rowPasses(row(10, { diff: -0.03 })), true, 'exactly -0.03 passes');
    assert.equal(sweep.rowPasses(row(10, { diff: -0.04 })), false);
    assert.equal(sweep.rowPasses(row(10, { mcnemarP: 0.01, table: { both: 70, aOnly: 12, sOnly: 1, neither: 17 } })), false, 'a significant loss');
    assert.equal(sweep.rowPasses(row(10, { mcnemarP: 0.01, table: { both: 70, aOnly: 1, sOnly: 12, neither: 17 } })), true, 'a significant gain is not a loss');
    assert.equal(sweep.rowPasses(row(10, { falseS: 0.06 })), true, 'A plus 1 point is allowed');
    assert.equal(sweep.rowPasses(row(10, { falseS: 0.07 })), false);
    assert.equal(sweep.rowPasses(row(10, { tokenSaving: 0.149 })), false);
    assert.equal(sweep.rowPasses(row(10, { pairs: 0 })), false);
  });
  it('prints the rule before the results', () => {
    const text = sweep.renderSummary({
      rows: [], decision: { n: null, recommended: null, passes: [] }, catalog: { source: 'x', counts: { fetched: 0, noDescription: 0, duplicate: 0, notFound: 0, fetchError: 0, nonGithub: 0 } },
      prompts: { stats: { written: 0, kept: 0, negWritten: 0, negKept: 0 } }, spend: { spent: 0, calls: 0 }, cap: 15, stopped: false, smoke: false,
    });
    assert.ok(text.indexOf('Pre-registered rule') < text.indexOf('## Results'));
    assert.ok(text.includes('opt-in only'));
  });
});

describe('sweep: the cap', () => {
  it('counts a child against its parent and refuses what no longer fits', () => {
    const total = sweep.makeSpend(1);
    const child = sweep.makeSpend(0.4, total);
    child.add(0.3);
    assert.equal(total.spent, 0.3);
    assert.equal(child.fits(0.1), true);
    assert.equal(child.fits(0.2), false);
    total.add(0.65);
    assert.equal(child.fits(0.06), false, 'the parent has too little left');
  });
  it('stops the arms at the cap and keeps whole pairs', async () => {
    const dir = tempDir('sweep-cap-');
    const home = join(dir, 'h');
    const items = Array.from({ length: 40 }, (_, i) => ({ size: 10, i, kind: 'pos', prompt: `p${i}`, gold: 'g' }));
    const query = () => (async function* () {
      yield { type: 'result', total_cost_usd: 0.1, usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } };
    })();
    const spend = sweep.makeSpend(1);
    const { records, stopped } = await sweep.runArms({ query, spend, items, homes: new Map([[10, home]]), workDir: dir });
    assert.equal(stopped, true);
    assert.ok(spend.spent <= 1.0001, `spent ${spend.spent}`);
    assert.ok(records.length < 80);
    assert.equal(records.length % 2, 0);
    const a = records.filter((r: any) => r.arm === 'A').length;
    assert.equal(a, records.length / 2);
  });
});

const SKILLS_SH_FIXTURE = `<html><body><main>
<a href="/acme-labs/toolkit/zeta-finder">zeta-finder</a>
<a href="/acme-labs/toolkit/quill-notes?ref=home">quill-notes</a>
<a href="/mossy/skillbox/pebble-plan">pebble-plan</a>
<a href="/site/example.test/domain-skill">domain-skill</a>
<a href="/docs/getting-started/intro">docs</a>
<a href="/_next/static/chunk">x</a>
<a href="/acme-labs/toolkit/zeta-finder">zeta-finder again</a>
<script>self.__next_f.push([1,"{\\"source\\":\\"drift/pack\\",\\"skillId\\":\\"lumen-check\\"}"])</script>
</main></body></html>`;

describe('sweep: the catalog parser', () => {
  it('reads skill links, ignores site and docs links and repeats, and reads embedded rows', () => {
    const { skills, nonGithub } = sweep.parseSkillsSh(SKILLS_SH_FIXTURE);
    assert.deepEqual(skills.map((s: any) => `${s.owner}/${s.repo}/${s.name}`), [
      'acme-labs/toolkit/zeta-finder', 'acme-labs/toolkit/quill-notes', 'mossy/skillbox/pebble-plan', 'drift/pack/lumen-check',
    ]);
    assert.equal(nonGithub, 1);
  });
  it('reads a frontmatter with plain, quoted and folded descriptions', () => {
    assert.deepEqual(sweep.parseFrontmatter('---\nname: a-b\ndescription: Does a thing.\n---\nbody'), { name: 'a-b', description: 'Does a thing.' });
    assert.equal(sweep.parseFrontmatter('---\nname: x\ndescription: "Quoted: yes"\n---\n').description, 'Quoted: yes');
    assert.equal(sweep.parseFrontmatter('---\nname: x\ndescription: >\n  First line\n  second line\nother: 1\n---\n').description, 'First line second line');
    assert.equal(sweep.parseFrontmatter('no frontmatter'), null);
  });
  it('writes a personal skill folder per skill', () => {
    const root = tempDir('sweep-home-');
    sweep.writeHome(root, [{ name: 'one-skill', description: 'Does "one" thing: well.' }]);
    const md = readFileSync(join(root, '.claude', 'skills', 'one-skill', 'SKILL.md'), 'utf8');
    assert.match(md, /^---\nname: one-skill\ndescription: "Does \\"one\\" thing: well\."\n---\n/);
  });
});

// ---- a fake network and a fake model, to run the whole job ----

const REPOS: Record<string, string[]> = {
  'acme-labs/toolkit': ['zeta-finder', 'quill-notes', 'no-desc', 'dup-name'],
  'mossy/skillbox': ['pebble-plan', 'dup-name'],
  'drift/pack': ['lumen-check', 'ember-sort'],
};
function fakeFetch() {
  const seen: string[] = [];
  const fn = async (url: string) => {
    seen.push(url);
    const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });
    if (url === 'https://skills.sh/') {
      const links = Object.entries(REPOS).flatMap(([r, names]) => names.map((n) => `<a href="/${r}/${n}">${n}</a>`));
      // 50 or more candidates are needed for skills.sh to count as readable; pad with links that are not in any repo.
      const pad = Array.from({ length: 50 }, (_, i) => `<a href="/ghost/repo/ghost-${i}">g</a>`);
      return ok(`<html>${links.join('')}${pad.join('')}</html>`);
    }
    if (url.startsWith('https://skills.sh/')) return ok('<html></html>');
    const tree = /api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees/.exec(url);
    if (tree) {
      const names = REPOS[tree[1]];
      if (!names) return { ok: false, status: 404, text: async () => '' };
      return ok(JSON.stringify({ tree: names.map((n) => ({ type: 'blob', path: `skills/${n}/SKILL.md` })) }));
    }
    const raw = /raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/HEAD\/skills\/([^/]+)\/SKILL\.md/.exec(url);
    if (raw) {
      const n = decodeURIComponent(raw[2]);
      if (n === 'no-desc') return ok('---\nname: no-desc\n---\nbody');
      return ok(`---\nname: ${n}\ndescription: Helps with ${n.replace(/-/g, ' ')} work for people who ask about ${n}.\n---\nbody`);
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  return { fn, seen };
}

/** A fake model. It answers by the kind of call: prompt writing, judging, or the probe with the Skill tool. */
function fakeQuery(log: { probes: number; text: number; homes: Set<string> }) {
  return ({ prompt, options }: any) => (async function* () {
    if (options.tools?.length === 0) {
      log.text++;
      const sys = String(options.systemPrompt);
      let body = '[]';
      if (sys.includes('write realistic test requests')) {
        const ns = [...String(prompt).matchAll(/Skill (\d+): ([\w-]+)/g)];
        body = JSON.stringify(ns.map((m) => ({ n: Number(m[1]), requests: [`please deal with ${m[2].split('-')[0]} stuff now`, `I need help getting ${m[2].split('-')[1] ?? 'it'} done`] })));
      } else if (sys.includes('everyday requests')) {
        body = JSON.stringify(Array.from({ length: 50 }, (_, i) => `fix the loop in my script number ${i}`));
      } else if (sys.includes('a target skill')) {
        const n = [...String(prompt).matchAll(/Item (\d+)/g)].length;
        body = JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, ok: i % 3 === 2 ? 0 : 1 })));
      } else {
        const n = [...String(prompt).matchAll(/Item (\d+)/g)].length;
        body = JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, applies: 0 })));
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: body }] } };
      yield { type: 'result', total_cost_usd: 0.002, usage: {} };
      return;
    }
    log.probes++;
    log.homes.add(String(options.env.HOME));
    assert.deepEqual(options.tools, ['Skill']);
    assert.equal(options.persistSession, false);
    assert.deepEqual(options.settingSources, ['user']);
    assert.equal(options.settings.disableAllHooks, true);
    const search = options.mcpServers?.legion_armory;
    if (search) {
      assert.equal(options.maxTurns, 4);
      assert.deepEqual(options.allowedTools, ['mcp__legion_armory__armory_find']);
    } else assert.equal(options.maxTurns, 1);
    const slim = options.settings.skillListingBudgetFraction === 0.002 && options.settings.skillListingMaxDescChars === 120;
    // The probe calls a skill named after the first word of the request, so the full list finds more than the short one.
    const word = /(?:deal with|getting) (\w+)/.exec(String(prompt))?.[1];
    const dir = join(String(options.env.HOME), '.claude', 'skills');
    const names = existsSync(dir) ? readdirSync(dir) : [];
    const hit = names.find((n) => n.startsWith(word ?? '\u0000'));
    // A short list with the hint searches first, then calls the skill; the usage is spread over two turns.
    const hinted = String(options.systemPrompt?.append ?? '').includes('armory_find');
    if (search && hinted) {
      await search.find(String(word ?? 'stuff'), 5);
      yield { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 5, cache_read_input_tokens: 40 }, content: [{ type: 'tool_use', name: 'mcp__legion_armory__armory_find', input: { query: 'x' } }] } };
    }
    if (hit && (!slim || hinted)) yield { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 5, cache_read_input_tokens: slim ? 60 : 1000 }, content: [{ type: 'tool_use', name: 'Skill', input: { skill: hit } }] } };
    yield { type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: slim ? 100 : 1000, cache_creation_input_tokens: 0 } };
  })();
}

describe('sweep: the whole job on fakes', () => {
  it('builds a catalog, skips bad skills, runs both arms and prints the summary', async () => {
    const { fn, seen } = fakeFetch();
    const cat = await sweep.buildCatalog({ fetch: fn, token: undefined, target: 5, sleep: async () => {} });
    assert.equal(cat.source, 'skills.sh');
    assert.deepEqual(cat.skills.map((s: any) => s.name), ['zeta-finder', 'quill-notes', 'dup-name', 'pebble-plan', 'lumen-check']);
    assert.ok(cat.counts.noDescription >= 1);
    assert.ok(cat.counts.duplicate >= 1, 'a second skill with the same name is skipped');
    assert.ok(seen.every((u: string) => !u.includes('search/code')), 'no fallback when skills.sh works');

    const log = { probes: 0, text: 0, homes: new Set<string>() };
    const root = tempDir('sweep-run-');
    const lines: string[] = [];
    // Legion's real index and ranking, from the build; only the server is a stand-in that exposes the find function to the fake model.
    const real = await sweep.loadArmory();
    const armory = { ...real, buildFindServer: (_job: unknown, find: unknown) => ({ type: 'sdk', name: 'legion_armory', find }) };
    const { summary, result } = await sweep.runSweep({ query: fakeQuery(log), fetch: fn, mode: 'smoke', cap: 5, root, armory, log: (m: string) => lines.push(m), sleep: async () => {} });
    assert.ok(log.probes > 0);
    assert.ok(summary.indexOf('Pre-registered rule') < summary.indexOf('## Arms'));
    assert.ok(summary.includes('Smoke run'));
    assert.equal(result.seed, 20261018);
    assert.equal(result.mode, 'smoke');
    assert.deepEqual(result.sizes, [5]);
    assert.deepEqual(result.arms.map((a: any) => a.arm), ['SFH120', 'AFH', 'SFH120-TP']);
    assert.ok(result.arms.every((a: any) => a.calls === 1), 'one call per arm');
    assert.ok(result.arms[0].searchCalled > 0, 'the multi-turn path ran: the fake model searched');
    assert.ok(result.spentUsd <= 5);
    // Numbers only: no request text from the fake model reaches the summary, the result or the log lines.
    for (const text of [summary, JSON.stringify(result), lines.join('\n')]) {
      assert.ok(!text.includes('please deal with') && !text.includes('fix the loop') && !text.includes('Helps with'));
    }
    assert.equal(readdirSync(root).length, 0, 'the temp folders are removed');
  });

  it('falls back to the GitHub code search when skills.sh cannot be read', async () => {
    const base = fakeFetch();
    const fn = async (url: string) => {
      if (url.startsWith('https://skills.sh/')) return { ok: false, status: 503, text: async () => '' };
      if (url.includes('search/code')) {
        const items = Object.entries(REPOS).flatMap(([r, names]) => names.map((n) => ({ path: `skills/${n}/SKILL.md`, repository: { full_name: r } })));
        return { ok: true, status: 200, text: async () => JSON.stringify({ items: url.includes('page=1') ? items : [] }) };
      }
      return base.fn(url);
    };
    const cat = await sweep.buildCatalog({ fetch: fn, token: 't', target: 3, sleep: async () => {} });
    assert.equal(cat.source, 'github-search');
    assert.equal(cat.skills.length, 3);
  });
});

// ---- Task 11f: the short list with the search tool ----

/** A fake query that plays back messages and hands the options to a spy. */
const playback = (messages: any[], spy: (options: any) => void = () => {}) => ({ options }: any) => (async function* () {
  spy(options);
  for (const m of messages) yield m;
})();
const tool = (name: string, input: Record<string, unknown>, id = 'm', usage: Record<string, number> | undefined = undefined) =>
  ({ type: 'assistant', message: { id, ...(usage ? { usage } : {}), content: [{ type: 'tool_use', name, input }] } });
const FIND = 'mcp__legion_armory__armory_find';

describe('sweep 11f: the arms', () => {
  it('has the four arms with the exact settings and the verbatim hint', () => {
    assert.deepEqual(sweep.ARMS_11F.map((a: any) => a.name), ['AF', 'SF120', 'SFH120', 'SFH250']);
    assert.ok(sweep.ARMS_11F.every((a: any) => a.search === true), 'every 11f arm has the search tool');
    const by = Object.fromEntries(sweep.ARMS_11F.map((a: any) => [a.name, a]));
    assert.deepEqual(by.AF.settings, {});
    assert.deepEqual(by.SF120.settings, { skillListingBudgetFraction: 0.002, skillListingMaxDescChars: 120 });
    assert.deepEqual(by.SFH120.settings, { skillListingBudgetFraction: 0.002, skillListingMaxDescChars: 120 });
    assert.deepEqual(by.SFH250.settings, { skillListingBudgetFraction: 0.002, skillListingMaxDescChars: 250 });
    assert.equal(sweep.HINT, 'Your skill list shows short descriptions. If no listed skill clearly fits, call armory_find with what you want to do before answering.');
    assert.ok(by.SFH120.append.endsWith(sweep.HINT) && by.SFH250.append.endsWith(sweep.HINT));
    assert.ok(!by.AF.append.includes('armory_find') && !by.SF120.append.includes('armory_find'));
    assert.equal(sweep.BASELINE_11F, 'AF');
  });
  it('keeps the 11e arms (one turn, no search) and uses one search arm for the smoke run', () => {
    assert.deepEqual(sweep.ARMS_11E.map((a: any) => a.name), ['A', 'S']);
    assert.ok(sweep.ARMS_11E.every((a: any) => a.search === false));
    assert.deepEqual(sweep.ARMS_11E[1].settings, sweep.SLIM_SETTINGS);
    assert.deepEqual(sweep.ARMS_SMOKE.map((a: any) => a.name), ['SFH120', 'AFH', 'SFH120-TP']);
    assert.ok(sweep.ARMS_SMOKE.every((a: any) => a.search === true));
  });
  it('uses the sizes, counts and cap of the brief', () => {
    assert.deepEqual(sweep.ACCURACY_SIZES, [40, 60, 100, 200]);
    assert.equal(sweep.ACCURACY_POSITIVES, 100);
    assert.equal(sweep.ACCURACY_NEGATIVES, 60);
    assert.equal(sweep.ACCURACY_CONCURRENCY, 6);
    assert.equal(sweep.ACCURACY_CAP_USD, 15);
    assert.equal(sweep.MAX_TURNS, 4);
    assert.equal(sweep.SEED, 20261018);
  });
  it('prints the 11f rule, with the new false-call test, before any result', () => {
    const text = sweep.ruleText11f();
    assert.ok(text.includes('at most 2 more false calls'));
    assert.ok(text.includes('finer than one call in 60'));
    assert.ok(text.includes('15 percent'));
    const out = sweep.renderSummary11f({
      rows: {}, decision: { arms: [], best: null }, catalog: { source: 'x', counts: { fetched: 0, noDescription: 0, duplicate: 0, notFound: 0, fetchError: 0, nonGithub: 0 } },
      prompts: { stats: { written: 0, kept: 0, negWritten: 0, negKept: 0 } }, spend: { spent: 0, calls: 0 }, cap: 15, stopped: false, smoke: false, armStats: [],
    });
    assert.ok(out.indexOf('Pre-registered rule') < out.indexOf('## Arms'));
    assert.ok(out.indexOf('Pre-registered rule') < out.indexOf('## Results'));
  });
});

describe('sweep 11f: a run with search', () => {
  it('counts the first Skill call as the gold hit, whatever search calls come before it', async () => {
    const seen: any[] = [];
    const base = { model: 'haiku', prompt: 'p', cwd: '.', env: {} };
    const search = tool(FIND, { query: 'invoices' }, 'a');
    const result = { type: 'result', total_cost_usd: 0.01, subtype: 'success', usage: { input_tokens: 1 } };
    const hit = await shared.runSkillCall(playback([search, search, tool('Skill', { skill: 'pdf-export' }, 'b'), result], (o) => seen.push(o)), { ...base, maxTurns: 4 });
    assert.equal(hit.called, 'pdf-export');
    assert.equal(sweep.isGold(hit.called, 'pdf-export'), true);
    const wrongFirst = await shared.runSkillCall(playback([search, tool('Skill', { skill: 'other' }, 'b'), tool('Skill', { skill: 'pdf-export' }, 'c'), result]), base);
    assert.equal(wrongFirst.called, 'other');
    assert.equal(sweep.isGold(wrongFirst.called, 'pdf-export'), false, 'only the first Skill call counts');
    const searchOnly = await shared.runSkillCall(playback([search, search, result]), base);
    assert.equal(searchOnly.called, null);
    assert.equal(sweep.isGold(searchOnly.called, 'pdf-export'), false);
    assert.equal(seen[0].maxTurns, 4);
  });
  it('records and denies every Skill call, and passes the search server and tool', async () => {
    let options: any;
    await shared.runSkillCall(playback([{ type: 'result', total_cost_usd: 0, usage: {} }], (o) => { options = o; }), {
      model: 'haiku', prompt: 'p', cwd: '.', env: {}, maxTurns: 4, mcpServers: { legion_armory: { name: 'x' } }, allowedTools: [FIND],
    });
    assert.deepEqual(options.tools, ['Skill']);
    assert.deepEqual(options.allowedTools, [FIND]);
    assert.equal(options.mcpServers.legion_armory.name, 'x');
    const answer = await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'a' } });
    assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
  });
  it('sums input tokens over every turn', async () => {
    const turn1 = tool(FIND, { query: 'a' }, 'm1', { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 5 });
    const turn2 = tool('Skill', { skill: 's' }, 'm2', { input_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 50, output_tokens: 5 });
    // A second block of turn 2 repeats its usage: it must count once.
    const again = tool('Skill', { skill: 's' }, 'm2', { input_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 50, output_tokens: 5 });
    const lastOnly = { type: 'result', total_cost_usd: 0.01, subtype: 'success', usage: { input_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 } };
    const r1 = await shared.runSkillCall(playback([turn1, turn2, again, lastOnly]), { model: 'haiku', prompt: 'p', cwd: '.', env: {}, maxTurns: 4 });
    assert.equal(shared.inputTokens(r1.tokens), 10 + 100 + 20 + 300 + 50, 'a result that reports only the last turn is raised to the sum');
    const cumulative = { type: 'result', total_cost_usd: 0.01, subtype: 'success', usage: { input_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 } };
    const r2 = await shared.runSkillCall(playback([turn1, turn2, cumulative]), { model: 'haiku', prompt: 'p', cwd: '.', env: {}, maxTurns: 4 });
    assert.equal(shared.inputTokens(r2.tokens), 480, 'a cumulative result is not counted twice');
    assert.equal(shared.inputTokens(shared.sumUsage([{ input_tokens: 1 }, { cache_read_input_tokens: 2 }, undefined])), 3);
  });
  it('runs a search arm: records the searches and whether the gold skill was in the top five', async () => {
    const dir = tempDir('sweep-search-');
    const items = [{ size: 5, i: 0, kind: 'pos', prompt: 'p0', gold: 'pdf-export' }, { size: 5, i: 0, kind: 'neg', prompt: 'n0', gold: null }];
    const arms = [{ name: 'AF', settings: {}, append: 'x', search: true }, { name: 'SF', settings: {}, append: 'x', search: true }];
    const query = ({ prompt, options }: any) => (async function* () {
      // SF searches (and finds the gold skill) but then calls nothing; AF calls a wrong skill without searching.
      if (String(prompt) === 'p0' && options.settings.mark === 'sf') await options.mcpServers.legion_armory.find('pdf', 5);
      if (options.settings.mark === 'af') yield tool('Skill', { skill: 'wrong' }, 'a');
      yield { type: 'result', total_cost_usd: 0.001, subtype: 'success', usage: { input_tokens: 1 } };
    })();
    const search = {
      forSize: () => async () => [{ id: 'a' }, { id: 'pdf-export' }, { id: 'b' }],
      buildServer: (find: any) => ({ id: 'server', find }),
    };
    arms[0].settings = { mark: 'af' } as any;
    arms[1].settings = { mark: 'sf' } as any;
    const { records } = await sweep.runArms({ query, spend: sweep.makeSpend(5), items, homes: new Map([[5, join(dir, 'h')]]), arms, search, concurrency: 1, workDir: dir });
    const sf = records.find((r: any) => r.arm === 'SF' && r.kind === 'pos');
    assert.equal(sf.searches, 1);
    assert.equal(sf.goldInTop5, true);
    assert.equal(sf.hit, false);
    const af = records.find((r: any) => r.arm === 'AF' && r.kind === 'pos');
    assert.equal(af.searches, 0);
    assert.equal(af.called, true);
    assert.equal(records.length, 4);
    await assert.rejects(() => sweep.runArms({ query, spend: sweep.makeSpend(5), items, homes: new Map(), arms, concurrency: 1, workDir: dir }), { code: 'NO_SEARCH' });
  });
});

/** Records for compareArms: n positives and m negatives for two arms. */
function recs(size: number, base: { pos: boolean[]; neg: boolean[] }, arm: { pos: boolean[]; neg: boolean[] }, extra: Record<string, unknown> = {}) {
  const out: any[] = [];
  for (const [name, d] of [['AF', base], ['X', arm]] as const) {
    d.pos.forEach((hit, i) => out.push({ size, i, kind: 'pos', arm: name, called: hit, hit, tokens: name === 'AF' ? 1000 : 700, cost: 0, error: null, searches: 0, goldInTop5: false, ...extra }));
    d.neg.forEach((called, i) => out.push({ size, i, kind: 'neg', arm: name, called, hit: false, tokens: name === 'AF' ? 1000 : 700, cost: 0, error: null, searches: 0, goldInTop5: false }));
  }
  return out;
}
const flags = (n: number, trueAt: number[]) => Array.from({ length: n }, (_, i) => trueAt.includes(i));

describe('sweep 11f: the false-call rule and the comparison', () => {
  it('allows at most two extra false calls in 60 and pairs the negatives', () => {
    const base = { pos: flags(20, [...Array(20).keys()]), neg: flags(60, [0, 1, 2, 3, 4]) };
    const withExtra = (k: number) => compareArms_(base, { pos: base.pos, neg: flags(60, [0, 1, 2, 3, 4, ...Array.from({ length: k }, (_, j) => 10 + j)]) });
    const r2 = withExtra(2);
    assert.equal(r2.falseExtra, 2);
    assert.equal(r2.falseMore, 2);
    assert.equal(sweep.rowPasses11f(r2), true, '2 extra calls pass');
    const r3 = withExtra(3);
    assert.equal(r3.falseExtra, 3);
    assert.equal(sweep.rowPasses11f(r3), false, '3 extra calls fail');
    // Same count of false calls, different prompts: no net increase.
    const swapped = compareArms_(base, { pos: base.pos, neg: flags(60, [5, 6, 7, 8, 9]) });
    assert.equal(swapped.falseExtra, 0);
    assert.equal(swapped.falseMore, 5);
    assert.equal(swapped.falseFewer, 5);
    assert.equal(sweep.rowPasses11f(swapped), true);
  });
  it('fails a significant increase even when the count is small, and checks the other three tests', () => {
    const ok = { pairs: 100, negatives: 60, table: { both: 80, aOnly: 2, sOnly: 2, neither: 16 }, diff: 0, mcnemarP: 1, falseMore: 1, falseFewer: 1, falseExtra: 0, falseP: 1, tokenSaving: 0.4 };
    assert.equal(sweep.rowPasses11f(ok), true);
    assert.equal(sweep.rowPasses11f({ ...ok, falseP: 0.01, falseMore: 9, falseFewer: 1, falseExtra: 2 }), false, 'a significant rise fails');
    assert.equal(sweep.rowPasses11f({ ...ok, falseP: 0.01, falseMore: 1, falseFewer: 9, falseExtra: -2 }), true, 'a significant fall is fine');
    assert.equal(sweep.rowPasses11f({ ...ok, diff: -0.04 }), false);
    assert.equal(sweep.rowPasses11f({ ...ok, diff: -0.03 }), true);
    assert.equal(sweep.rowPasses11f({ ...ok, mcnemarP: 0.01, table: { both: 70, aOnly: 12, sOnly: 1, neither: 17 } }), false);
    assert.equal(sweep.rowPasses11f({ ...ok, tokenSaving: 0.149 }), false);
    assert.equal(sweep.rowPasses11f({ ...ok, tokenSaving: null }), false);
    assert.equal(sweep.rowPasses11f({ ...ok, negatives: 0 }), false);
    assert.equal(sweep.rowPasses11f({ ...ok, pairs: 0 }), false);
  });
  it('compares gold, tokens, search use and the miss split', () => {
    const base = { pos: flags(10, [0, 1, 2, 3, 4, 5, 6, 7]), neg: flags(4, []) };
    const arm = { pos: flags(10, [0, 1, 2, 3, 4, 5]), neg: flags(4, []) };
    const records = recs(40, base, arm);
    // Arm misses are positives 6..9: two searched, and one of those had the gold skill in its top five.
    const misses = records.filter((r: any) => r.arm === 'X' && r.kind === 'pos' && !r.hit);
    misses[0].searches = 1; misses[0].goldInTop5 = true;
    misses[1].searches = 2;
    const row = sweep.compareArms(records, 40, 'AF', 'X');
    assert.equal(row.pairs, 10);
    assert.deepEqual(row.table, { both: 6, aOnly: 2, sOnly: 0, neither: 2 });
    assert.equal(row.diff, -0.2);
    assert.equal(row.tokenSaving, 0.3);
    assert.equal(row.misses, 4);
    assert.equal(row.missesSearched, 2);
    assert.equal(row.missesGoldInTop5, 1);
    assert.equal(row.searchRate, round4(2 / 14));
    assert.equal(sweep.compareArms(records, 60, 'AF', 'X').pairs, 0, 'a size with no records has no pairs');
  });
  it('names where each arm passes from, and the best arm by lowest N then most tokens saved', () => {
    const row = (size: number, over: Record<string, unknown> = {}) => ({
      size, pairs: 100, negatives: 60, table: { both: 80, aOnly: 2, sOnly: 2, neither: 16 }, diff: 0, mcnemarP: 1, falseMore: 0, falseFewer: 0, falseExtra: 0, falseP: 1, tokenSaving: 0.3, ...over,
    });
    const sizes = [40, 60, 100, 200];
    const d = sweep.decideAccuracy({
      SF120: sizes.map((s) => row(s, s < 100 ? { diff: -0.1 } : { tokenSaving: 0.2 })),
      SFH120: sizes.map((s) => row(s, s < 100 ? { diff: -0.1 } : { tokenSaving: 0.4 })),
      SFH250: sizes.map((s) => row(s, s === 200 ? { falseExtra: 3 } : {})),
    });
    const n = Object.fromEntries(d.arms.map((a: any) => [a.arm, a.n]));
    assert.deepEqual(n, { SF120: 100, SFH120: 100, SFH250: null });
    assert.equal(d.best, 'SFH120', 'a tie on N goes to the larger saving');
    assert.equal(sweep.decideAccuracy({ SF120: sizes.map((s) => row(s, { tokenSaving: 0.05 })) }).best, null);
    const lowest = sweep.decideAccuracy({ A1: sizes.map((s) => row(s, s < 100 ? { diff: -0.1 } : {})), A2: sizes.map((s) => row(s, s < 60 ? { diff: -0.1 } : {})) });
    assert.equal(lowest.best, 'A2');
  });
});

const round4 = (x: number) => Math.round(x * 10000) / 10000;
function compareArms_(base: { pos: boolean[]; neg: boolean[] }, arm: { pos: boolean[]; neg: boolean[] }) {
  return sweep.compareArms(recs(40, base, arm), 40, 'AF', 'X');
}

describe('sweep 11f: the mode file', () => {
  it('reads the mode from the file text', () => {
    assert.equal(sweep.parseSweepMode(''), 'accuracy-11f');
    assert.equal(sweep.parseSweepMode(undefined), 'accuracy-11f');
    assert.equal(sweep.parseSweepMode('smoke\n'), 'smoke');
    assert.equal(sweep.parseSweepMode('  Full-11E \r\n'), 'full-11e');
    assert.equal(sweep.parseSweepMode('# the mode\n\naccuracy-11f # default\n'), 'accuracy-11f');
    assert.equal(sweep.parseSweepMode('# nothing but a note\n'), 'accuracy-11f');
    assert.throws(() => sweep.parseSweepMode('smoek'), { code: 'BAD_MODE' });
  });
  it('picks the mode from --mode, then the file, then the default', () => {
    const dir = tempDir('sweep-mode-');
    const file = join(dir, '.sweep-mode');
    assert.equal(sweep.chooseMode({}), 'accuracy-11f');
    assert.equal(sweep.chooseMode({ modeFile: file }), 'accuracy-11f', 'a missing file gives the default');
    writeFileSync(file, 'smoke\n');
    assert.equal(sweep.chooseMode({ modeFile: file }), 'smoke');
    assert.equal(sweep.chooseMode({ modeFile: file, mode: 'full-11e' }), 'full-11e');
  });
  it('is wired into the workflow with the 240 minute limit', () => {
    const yml = readFileSync(new URL('.github/workflows/skill-finder-sweep.yml', REPO), 'utf8');
    assert.match(yml, /timeout-minutes: 240/);
    assert.match(yml, /--mode-file \.sweep-mode/);
  });
});

describe('sweep 11f: Legion\'s own search tool', () => {
  it('builds the real armory_find server and ranks by keyword over the size\'s skills', async () => {
    const mods = await sweep.loadArmory();
    assert.equal(mods.serverName, 'legion_armory');
    const items = [
      { name: 'pdf-export', description: 'Export invoices and reports to PDF files.' },
      { name: 'git-helper', description: 'Rebase, merge and resolve git conflicts.' },
      { name: 'long-one', description: `Spreadsheet work. ${'word '.repeat(100)}` },
    ];
    const search = sweep.makeSearch(mods, [{ size: 3, items }]);
    const find = search.forSize(3);
    const hits = find('export invoices to pdf', 5);
    assert.equal(hits[0].id, 'pdf-export');
    assert.ok(hits[0].score > 0 && hits[0].thirdParty === false);
    assert.ok(hits.every((h: any) => h.score > 0), 'a skill with no matching word is left out');
    assert.deepEqual(find('zzzz qqqq', 5), []);
    assert.ok(find('spreadsheet', 5)[0].description.length <= 200);
    assert.equal(find('export invoices to pdf', 1).length, 1);
    const server = search.buildServer(find);
    assert.equal(server.type, 'sdk');
    assert.equal(server.name, 'legion_armory');
    const tools = (server.instance as any)?._registeredTools;
    if (tools) {
      assert.deepEqual(Object.keys(tools), ['armory_find']);
      assert.match(tools.armory_find.description, /^Search the skills the owner has turned on for you/);
    }
  });
  it('keeps the description cut equal to the one in Legion\'s armory', () => {
    const src = readFileSync(new URL('src/core/armory/index.ts', REPO), 'utf8');
    const m = /const MAX_FIND_DESCRIPTION = (\d+);/.exec(src);
    assert.ok(m, 'the constant still exists in the armory');
    assert.equal(sweep.FIND_DESCRIPTION_CHARS, Number(m![1]));
  });
});

describe('sweep 11f: the whole accuracy job on fakes', () => {
  it('runs every arm against the baseline at a size and prints the rule, the arms, the results and the decision', async () => {
    const names = Array.from({ length: 50 }, (_, i) => `tool-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`);
    const fn = async (url: string) => {
      const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });
      if (url === 'https://skills.sh/') return ok(`<html>${names.map((n) => `<a href="/o/r/${n}">${n}</a>`).join('')}</html>`);
      if (url.startsWith('https://skills.sh/')) return ok('<html></html>');
      if (url.includes('/git/trees/')) return ok(JSON.stringify({ tree: names.map((n) => ({ type: 'blob', path: `skills/${n}/SKILL.md` })) }));
      const raw = /skills\/([^/]+)\/SKILL\.md/.exec(url);
      return raw ? ok(`---\nname: ${raw[1]}\ndescription: Helps with ${raw[1].replace(/-/g, ' ')} work.\n---\nbody`) : { ok: false, status: 404, text: async () => '' };
    };
    const log = { probes: 0, text: 0, homes: new Set<string>() };
    const root = tempDir('sweep-11f-');
    const real = await sweep.loadArmory();
    const armory = { ...real, buildFindServer: (_job: unknown, find: unknown) => ({ type: 'sdk', name: 'legion_armory', find }) };
    const { summary, result } = await sweep.runSweep({ query: fakeQuery(log), fetch: fn, mode: 'accuracy-11f', cap: 5, root, armory, log: () => {}, sleep: async () => {} });
    assert.equal(result.mode, 'accuracy-11f');
    assert.deepEqual(result.sizes, [40], 'only the sizes the catalog can fill');
    assert.deepEqual(result.arms.map((a: any) => a.arm), ['AF', 'SF120', 'SFH120', 'SFH250']);
    assert.ok(result.arms.every((a: any) => a.calls === result.arms[0].calls), 'every arm ran the same items');
    assert.deepEqual(Object.keys(result.rows), ['SF120', 'SFH120', 'SFH250']);
    assert.ok(result.rows.SFH120[0].pairs > 0);
    assert.ok(result.arms.find((a: any) => a.arm === 'SFH120').searchCalled > 0, 'the hint arm searched');
    assert.equal(result.arms.find((a: any) => a.arm === 'AF').searchCalled, 0);
    assert.ok(summary.indexOf('Pre-registered rule') < summary.indexOf('## Results against AF'));
    assert.ok(summary.includes('## Search use and misses') && summary.includes('## Decision'));
    assert.equal(readdirSync(root).length, 0);
    await assert.rejects(() => sweep.runSweep({ query: fakeQuery(log), fetch: fakeFetch().fn, mode: 'accuracy-11f', cap: 5, root, armory, log: () => {}, sleep: async () => {} }), { code: 'CATALOG' });
  });
});

// ---- Task 11g: the follow-up ----

describe('sweep 11g: arms, rule and sizes', () => {
  const by = () => Object.fromEntries(sweep.ARMS_11G.map((a: any) => [a.name, a]));
  it('is a mode of its own and keeps the other modes', () => {
    assert.deepEqual(sweep.MODES, ['smoke', 'full-11e', 'accuracy-11f', 'followup-11g', 'round1', 'smoke-round1']);
    assert.equal(sweep.parseSweepMode('followup-11g\n'), 'followup-11g');
    assert.equal(sweep.parseSweepMode('accuracy-11f'), 'accuracy-11f');
    assert.equal(sweep.parseSweepMode(''), 'accuracy-11f');
    assert.deepEqual(sweep.FOLLOWUP_SIZES, [10, 25, 40, 100]);
    assert.equal(sweep.ACCURACY_CAP_USD, 15);
    assert.equal(sweep.ACCURACY_CONCURRENCY, 6);
    assert.equal(sweep.ACCURACY_POSITIVES, 100);
    assert.equal(sweep.ACCURACY_NEGATIVES, 60);
  });
  it('has the four arms with the right listing, hint and search', () => {
    assert.deepEqual(sweep.ARMS_11G.map((a: any) => a.name), ['AF', 'AFH', 'SFH120', 'SFH120-TP']);
    const a = by();
    assert.ok(sweep.ARMS_11G.every((x: any) => x.search === true));
    assert.deepEqual(a.AF.settings, {});
    assert.deepEqual(a.AFH.settings, {}, 'AFH keeps the full listing');
    assert.deepEqual(a.SFH120.settings, { skillListingBudgetFraction: 0.002, skillListingMaxDescChars: 120 });
    assert.deepEqual(a['SFH120-TP'].settings, a.SFH120.settings, 'the listing is unchanged in the third-party arm');
    assert.equal(a['SFH120-TP'].append, a.SFH120.append);
    assert.ok(!a.AF.append.includes('armory_find') && !a.AF.thirdParty);
    assert.ok(!a.AFH.thirdParty && !a.SFH120.thirdParty);
    assert.equal(a['SFH120-TP'].thirdParty, true);
  });
  it('gives AFH the very same hint as SFH120 (the 11f constant, not a copy)', () => {
    const a = by();
    assert.equal(a.AFH.append, a.SFH120.append);
    assert.ok(a.AFH.append.endsWith(sweep.HINT));
    assert.equal(sweep.HINT, 'Your skill list shows short descriptions. If no listed skill clearly fits, call armory_find with what you want to do before answering.');
    assert.strictEqual(sweep.ARMS_11G[2], sweep.ARMS_11F[2], 'SFH120 is the 11f arm itself');
    const src = readFileSync(new URL('scripts/skill-finder-sweep.mjs', REPO), 'utf8');
    assert.equal(src.split('call armory_find with what you want to do').length - 1, 1, 'the hint text is written once');
  });
  it('prints the unchanged 11f rule for the three tested arms, plus the SFH120 against AFH note', () => {
    const t = sweep.ruleText11f('followup-11g');
    assert.ok(t.includes('(AFH, SFH120, SFH120-TP)') && t.includes('with AF'));
    assert.ok(t.includes('SFH120 against AFH'));
    assert.ok(!sweep.ruleText11f('accuracy-11f').includes('SFH120 against AFH'));
    assert.deepEqual(sweep.ACCURACY_RULE, { minGoldDiff: -0.03, mcnemarAlpha: 0.05, maxExtraFalseCalls: 2, negativesPerSize: 60, minTokenSaving: 0.15 });
  });
  it('renders the SFH120 against AFH table and the small-size note', () => {
    const r = sweep.compareArms([], 10, 'AFH', 'SFH120');
    const out = sweep.renderSummary11f({
      rows: { AFH: [r], SFH120: [r], 'SFH120-TP': [r] }, vsAfh: [r], decision: { arms: [], best: null }, mode: 'followup-11g',
      catalog: { source: 's', counts: { fetched: 0, noDescription: 0, duplicate: 0, notFound: 0, fetchError: 0, nonGithub: 0 } },
      prompts: { stats: { written: 0, kept: 0, negWritten: 0, negKept: 0 } }, spend: { spent: 0, calls: 0 }, cap: 15, stopped: false, smoke: false, armStats: [],
    });
    assert.ok(out.includes('## SFH120 against AFH') && out.includes('at size 10 there are about 20'));
    assert.ok(out.indexOf('Pre-registered rule') < out.indexOf('## SFH120 against AFH'));
  });
  it('compares SFH120 with AFH on the same pairs', () => {
    const rec = (arm: string, i: number, hit: boolean, tokens: number) => ({ size: 10, i, kind: 'pos', arm, hit, called: hit, tokens, searches: 0 });
    const recs = [rec('AFH', 0, true, 1000), rec('SFH120', 0, false, 500), rec('AFH', 1, true, 1000), rec('SFH120', 1, true, 500)];
    const c = sweep.compareArms(recs, 10, 'AFH', 'SFH120');
    assert.equal(c.pairs, 2);
    assert.equal(c.table.aOnly, 1);
    assert.equal(c.diff, -0.5);
    assert.equal(c.tokenSaving, 0.5);
  });
});

describe('sweep 11g: third-party search answers pinned to Legion\'s source', () => {
  const items = [
    { name: 'pdf-export', description: 'Export invoices and reports to PDF files.' },
    { name: 'git-helper', description: 'Rebase, merge and resolve git conflicts.' },
  ];
  const callFind = async (mods: any, find: any) => {
    const server = mods.buildFindServer(undefined, find);
    return (await server.instance._registeredTools.armory_find.handler({ query: 'export invoices to pdf' }, {})).content[0].text as string;
  };
  it('returns the id and (third-party) with no description, as Legion\'s own server formats it', async () => {
    const mods = await sweep.loadArmory();
    const search = sweep.makeSearch(mods, [{ size: 2, items }]);
    const hits = search.forSize(2, true)('export invoices to pdf', 5);
    assert.ok(hits.length > 0 && hits.every((h: any) => h.thirdParty === true && h.description === undefined));
    const tp = await callFind(mods, search.forSize(2, true));
    assert.match(tp, /^\d+ skill\(s\) may fit:\n- pdf-export \(third-party\)/);
    assert.ok(!tp.includes('Export invoices'), 'no description reaches the model');
    assert.ok(tp.split('\n').slice(1).every((l) => /^- \S+ \(third-party\)$/.test(l)));
    const own = await callFind(mods, search.forSize(2));
    assert.match(own, /- pdf-export \(\d+\.\d+\): Export invoices/, 'the owner-skill arms still get descriptions');
  });
  it('keeps the format equal to the one in src/core/armory (tools.ts formats, index.ts drops the description)', () => {
    const tools = readFileSync(new URL('src/core/armory/tools.ts', REPO), 'utf8');
    assert.ok(tools.includes('h.thirdParty ? `- ${h.id} (third-party)`'), 'tools.ts still formats a third-party hit as the id and (third-party)');
    const index = readFileSync(new URL('src/core/armory/index.ts', REPO), 'utf8');
    assert.ok(index.includes("const description = thirdParty || !doc ? '' : oneLine(doc.description)"), 'index.ts still drops the description of a third-party hit');
  });
});

describe('sweep 11g: the workflow', () => {
  const yml = readFileSync(new URL('.github/workflows/skill-finder-sweep.yml', REPO), 'utf8').replace(/\r\n/g, '\n');
  const marker = '\n    steps:\n';
  /** The steps of the job as text blocks: each starts at a line "      - ". */
  const steps = () => yml.slice(yml.indexOf(marker) + marker.length).split(/\n(?=      - )/).filter((b) => b.trim().startsWith('- '));
  it('holds the model token under the sweep step only', () => {
    const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
    const head = yml.slice(0, yml.indexOf(marker));
    assert.ok(!head.includes(TOKEN), 'not in the top-level or job-level env, nor anywhere before the steps');
    const holders = steps().filter((b) => b.includes(TOKEN));
    assert.equal(holders.length, 1, 'exactly one step names the token');
    assert.match(holders[0], /^ {6}- name: Run the sweep\n/);
    assert.match(holders[0], /\n {8}env:\n {10}CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
    assert.ok(holders[0].includes('node scripts/skill-finder-sweep.mjs --mode-file .sweep-mode'));
    const install = steps().filter((b) => /^ {6}- run: npm (ci|run build:ts)$/.test(b));
    assert.ok(install.length >= 2 && install.every((b) => !b.includes(TOKEN)));
    assert.equal(yml.split(TOKEN).length, holders[0].split(TOKEN).length, 'every mention is inside the sweep step');
  });
  it('keeps the GitHub token and the 240 minute limit', () => {
    assert.match(yml, /\n {4}env:\n {6}GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n/);
    assert.match(yml, /timeout-minutes: 240/);
  });
});

describe('sweep 11g: the whole follow-up job on fakes', () => {
  it('runs the four arms over the 11g sizes and prints the extra comparison', async () => {
    const names = Array.from({ length: 50 }, (_, i) => `tool-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`);
    const fn = async (url: string) => {
      const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });
      if (url === 'https://skills.sh/') return ok(`<html>${names.map((n) => `<a href="/o/r/${n}">${n}</a>`).join('')}</html>`);
      if (url.startsWith('https://skills.sh/')) return ok('<html></html>');
      if (url.includes('/git/trees/')) return ok(JSON.stringify({ tree: names.map((n) => ({ type: 'blob', path: `skills/${n}/SKILL.md` })) }));
      const raw = /skills\/([^/]+)\/SKILL\.md/.exec(url);
      return raw ? ok(`---\nname: ${raw[1]}\ndescription: Helps with ${raw[1].replace(/-/g, ' ')} work.\n---\nbody`) : { ok: false, status: 404, text: async () => '' };
    };
    const log = { probes: 0, text: 0, homes: new Set<string>() };
    const root = tempDir('sweep-11g-');
    const real = await sweep.loadArmory();
    const armory = { ...real, buildFindServer: (_job: unknown, find: unknown) => ({ type: 'sdk', name: 'legion_armory', find }) };
    const { summary, result } = await sweep.runSweep({ query: fakeQuery(log), fetch: fn, mode: 'followup-11g', cap: 5, root, armory, log: () => {}, sleep: async () => {} });
    assert.equal(result.mode, 'followup-11g');
    assert.deepEqual(result.sizes, [10, 25, 40], 'only the sizes the catalog can fill');
    assert.deepEqual(result.arms.map((a: any) => a.arm), ['AF', 'AFH', 'SFH120', 'SFH120-TP']);
    assert.deepEqual(Object.keys(result.rows), ['AFH', 'SFH120', 'SFH120-TP']);
    assert.equal(result.vsAfh.length, 3);
    assert.ok(result.rows.AFH.every((r: any) => r.pairs > 0));
    assert.ok(summary.includes('## SFH120 against AFH') && summary.includes('## Decision'));
    assert.equal(readdirSync(root).length, 0);
  });
});
