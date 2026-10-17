/** Catalog-size sweep (scripts/skill-finder-sweep.mjs). A fake query and a fake fetch only: no network call, no model call. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
    assert.equal(options.maxTurns, 1);
    assert.equal(options.persistSession, false);
    assert.deepEqual(options.settingSources, ['user']);
    assert.equal(options.settings.disableAllHooks, true);
    const slim = options.settings.skillListingBudgetFraction === 0.002 && options.settings.skillListingMaxDescChars === 120;
    // The probe calls a skill named after the first word of the request, so the full list finds more than the short one.
    const word = /(?:deal with|getting) (\w+)/.exec(String(prompt))?.[1];
    const dir = join(String(options.env.HOME), '.claude', 'skills');
    const names = existsSync(dir) ? readdirSync(dir) : [];
    const hit = names.find((n) => n.startsWith(word ?? '\u0000'));
    if (hit && !slim) yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: hit } }] } };
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
    const { summary, result } = await sweep.runSweep({ query: fakeQuery(log), fetch: fn, smoke: true, cap: 5, root, log: (m: string) => lines.push(m), sleep: async () => {} });
    assert.ok(log.probes > 0 && log.probes % 2 === 0);
    assert.ok(summary.indexOf('Pre-registered rule') < summary.indexOf('## Results'));
    assert.ok(summary.includes('Smoke run'));
    assert.equal(result.seed, 20261018);
    assert.equal(result.sizes.length, 1);
    assert.equal(result.sizes[0].size, 5);
    assert.ok(result.sizes[0].pairs <= 2 && result.sizes[0].negatives <= 2);
    assert.ok(result.sizes[0].tokenSaving > 0.8, 'the fake short list is much smaller');
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
