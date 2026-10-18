#!/usr/bin/env node
/**
 * Catalog-size sweep for the short skill list. It runs on a GitHub runner, never on the owner's PC.
 *
 * It takes the most installed public skills (skills.sh leaderboard), keeps only each skill's name and description, writes them into
 * a temp HOME as personal skills, and asks real Claude Code (Haiku, one turn, only the Skill tool) which skill it would call. Arm A
 * has the full listing, arm S has the short list with the settings Legion passes. A hook records and denies every Skill call, so no
 * skill text loads. The logs are public: only counts and metrics are printed, never env, tokens, prompts or skill text.
 *
 * Eight modes (a .sweep-mode file on the branch picks one; the default is accuracy-11f):
 *   smoke         5 skills, one short-list arm with the search tool, under $0.10. It proves the multi-turn path.
 *   round1        accuracy round 1: sizes 25 and 100, arms C, CL, H2, D, LH2 against C, hard negatives, an equivalence re-score of
 *                 the misses, a miss split, and the frozen prompt sets (round1-frozen.json).
 *   round2        accuracy round 2: the frozen round 1 sets (eval/round1-frozen.json, read with --frozen-in), arms C, M, SL, MSL and H2.
 *                 M is a middle hint; SL and MSL add a per-turn shortlist note from a UserPromptSubmit hook. M, SL and MSL are
 *                 tested against C; H2 is a reference point.
 *   smoke-round2  arms SL and M on one frozen positive and one frozen negative: proves the note reaches the model, under $0.10.
 *   smoke-round1  5 skills, arms C, D and LH2, one positive: proves the description wrapper of arm D and the logging, under $0.10.
 *   full-11e      the catalog-size sweep above (arms A and S, one turn, Skill tool only).
 *   followup-11g  size 10, 25, 40, 100; arms AF, AFH (full list + hint), SFH120, SFH120-TP (third-party search answers).
 *   accuracy-11f  the short list as Legion ships it: with the search tool (armory_find, Legion's own server and ranking),
 *                 up to 4 turns, a hint and a longer description cut tested against the full list plus search.
 *
 * usage: skill-finder-sweep.mjs [--mode name] [--mode-file path] [--smoke] [--cap usd] [--json file] [--frozen file] [--frozen-in file]
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inputTokens, mcnemar, round, runSkillCall, sample, wilson, writeFresh } from './lib/finder-shared.mjs';

export const SEED = 20261018;
export const SIZES = [10, 25, 40, 60, 100, 200, 400];
export const CAP_USD = 15;
export const CATALOG_TARGET = 400;
export const POSITIVES_PER_SIZE = 120;
export const NEGATIVES_PER_SIZE = 60;
export const NEGATIVES_WANTED = 150;
/** Exactly the settings Legion passes for the short list (src/core/engine.ts). */
export const SLIM_SETTINGS = { skillListingBudgetFraction: 0.002, skillListingMaxDescChars: 120 };
export const THRESHOLD_RULE = {
  minGoldDiff: -0.03, mcnemarAlpha: 0.05, maxExtraFalseCalls: 0.01, minTokenSaving: 0.15,
};
/** The 11f rule, written before any result. The false-call test is paired and counted in calls: one call in 60 is 1.7 points, finer than a point. */
export const ACCURACY_RULE = { minGoldDiff: -0.03, mcnemarAlpha: 0.05, maxExtraFalseCalls: 2, negativesPerSize: 60, minTokenSaving: 0.15 };
const PROBE_SYSTEM = 'Use a skill only if one clearly fits; otherwise answer briefly.';
const FIND_PHRASE = 'call armory_find with what you want to do';
/**
 * The hint Legion ships for a full listing. It is copied from the finder branch's defaults (src/core/armory/finder/defaults.ts), which
 * this branch does not have; a test pins the literal.
 */
export const SEARCH_HINT = `If no listed skill clearly fits, ${FIND_PHRASE} before answering.`;
/** The one-line hint of the SFH arms (the long measured hint of 11g), word for word. */
export const HINT = `Your skill list shows short descriptions. ${SEARCH_HINT}`;
/** The strong hint of round 1 without its last sentence: the hint of the arm with no search tool. */
export const LH2_HINT = 'Before answering, check the skill list. If a skill fits even partly, load it with the Skill tool, even if you could do the task yourself. If you skip an obvious skill, say why in one line.';
/** The strong hint of round 1 for arms that have the search tool. */
export const STRONG_HINT = `${LH2_HINT} If none fit, ${FIND_PHRASE}.`;

// ---------- modes and arms ----------

export const MODES = ['smoke', 'full-11e', 'accuracy-11f', 'followup-11g', 'round1', 'smoke-round1', 'round2', 'smoke-round2'];
export const DEFAULT_MODE = 'accuracy-11f';
export const ACCURACY_SIZES = [40, 60, 100, 200];
export const ACCURACY_POSITIVES = 100;
export const ACCURACY_NEGATIVES = 60;
export const ACCURACY_CAP_USD = 15;
export const ACCURACY_CONCURRENCY = 6;
export const MAX_TURNS = 4;
export const FIND_TOOL = 'mcp__legion_armory__armory_find';
/** Legion's own description cut for a search hit (MAX_FIND_DESCRIPTION in src/core/armory/index.ts; a test keeps the two equal). */
export const FIND_DESCRIPTION_CHARS = 200;
const SHORT_LIST = { skillListingBudgetFraction: 0.002 };

/** Arms of the 11e sweep: one turn, Skill tool only. */
export const ARMS_11E = [
  { name: 'A', settings: {}, append: PROBE_SYSTEM, search: false },
  { name: 'S', settings: { ...SHORT_LIST, skillListingMaxDescChars: 120 }, append: PROBE_SYSTEM, search: false },
];
/** Arms of the 11f run: all have the search tool. AF is the baseline. */
export const ARMS_11F = [
  { name: 'AF', settings: {}, append: PROBE_SYSTEM, search: true },
  { name: 'SF120', settings: { ...SHORT_LIST, skillListingMaxDescChars: 120 }, append: PROBE_SYSTEM, search: true },
  { name: 'SFH120', settings: { ...SHORT_LIST, skillListingMaxDescChars: 120 }, append: `${PROBE_SYSTEM} ${HINT}`, search: true },
  { name: 'SFH250', settings: { ...SHORT_LIST, skillListingMaxDescChars: 250 }, append: `${PROBE_SYSTEM} ${HINT}`, search: true },
];
export const BASELINE_11F = 'AF';
/** Sizes of the 11g follow-up. At size 10 there are about 20 positives (2 per skill, before the judge), so fewer than 100. */
export const FOLLOWUP_SIZES = [10, 25, 40, 100];
/**
 * Arms of the 11g follow-up. AFH is the full listing with the search tool and the same hint as SFH120 (HINT is the 11f constant, not retyped).
 * SFH120 is the 11f arm itself. SFH120-TP is SFH120 where armory_find answers the way Legion answers for a third-party skill: the id and
 * " (third-party)", no description. The listing is unchanged, so Claude Code still lists descriptions at 120 characters.
 */
export const ARMS_11G = [
  ARMS_11F[0],
  { name: 'AFH', settings: {}, append: `${PROBE_SYSTEM} ${HINT}`, search: true },
  ARMS_11F[2],
  { ...ARMS_11F[2], name: 'SFH120-TP', thirdParty: true },
];
/** The smoke run uses the arms with the most parts: short list, hint and search; plus AFH and the third-party search. */
export const ARMS_SMOKE = [ARMS_11F[2], ARMS_11G[1], ARMS_11G[3]];

// ---------- round 1 ----------

export const ROUND1_SIZES = [25, 100];
export const ROUND1_CAP_USD = 15;
export const ROUND1_POSITIVES = 100;
export const ROUND1_EASY_NEGATIVES = 60;
export const ROUND1_HARD_NEGATIVES = 60;
export const ROUND1_AMBIGUOUS_MAX = 20;
export const ROUND1_BASELINE = 'C';
/** A search hit's description in arm D: the cap the slim listing uses. */
export const HIT_DESCRIPTION_CHARS = 120;
/** The share of the cap kept back for the equivalence judge, so the arms cannot spend it. */
const JUDGE_RESERVE_SHARE = 0.1;
/** The round 1 rule, written before any result. The arm is compared with C on accepted gold; false loads count Skill calls on negatives. */
export const ROUND1_RULE = { minGoldDiff: 0.05, mcnemarAlpha: 0.05, maxItemsLowerAtSmall: 1, maxExtraFalseLoads: 2, bigSize: 100, smallSize: 25 };
/**
 * Round 1 arms carry only their hint, as Legion sends it: no probe line. 11e to 11g put "only if one clearly fits" in front of every hint,
 * which Legion never sends and which pulls against the strong hint, so round 1 numbers are not comparable with those runs.
 */
const r1Arm = (name, hint, extra = {}) => ({ name, settings: {}, append: hint, search: true, thirdParty: true, ...extra });
/**
 * C is the control: the full listing, armory_find, the shipped hint. Search hits show every skill as third-party (id only), the case with
 * many plugin skills. CL is C with the long hint measured in 11g. H2 has the strong hint. D is C where a hit also shows its description.
 * LH2 has the strong hint without its last sentence and no search tool.
 */
export const ARMS_ROUND1 = [
  r1Arm('C', SEARCH_HINT),
  r1Arm('CL', HINT),
  r1Arm('H2', STRONG_HINT),
  r1Arm('D', SEARCH_HINT, { describeHits: true }),
  r1Arm('LH2', LH2_HINT, { search: false, thirdParty: false }),
  // N: C with no hint at all. Report only: does the shipped hint still help once no probe line pulls the other way?
  r1Arm('N', ''),
];
export const ARMS_SMOKE_ROUND1 = [ARMS_ROUND1[0], ARMS_ROUND1[3], ARMS_ROUND1[4]];

// ---------- round 2 ----------

export const ROUND2_SIZES = ROUND1_SIZES;
/** The middle hint of round 2: the shipped idea plus "say why you skipped one", without the strong hint's "even partly". */
export const MIDDLE_HINT = `Before answering, check the skill list. Load a skill with the Skill tool when it clearly fits the task. If you skip a skill that looks relevant, say why in one line. If you are unsure whether one fits, ${FIND_PHRASE}.`;
/** The per-turn note: the harness's top skills for the prompt, then a forced pick-one-or-none step. */
export const SHORTLIST_SIZE = 5;
export const SHORTLIST_HEAD = 'Skills that may fit this request:';
export const SHORTLIST_FOOT = 'For each one, decide whether it clearly fits. If one does, load it with the Skill tool. If none does, answer without a skill.';
/** The note text for a ranked list of skill ids (id only, as the third-party rule asks), or null when nothing ranked. */
export function buildShortlistNote(ids, n = SHORTLIST_SIZE) {
  const lines = ids.slice(0, n).map((id) => `- ${id}`);
  return lines.length ? `${SHORTLIST_HEAD}\n${lines.join('\n')}\n${SHORTLIST_FOOT}` : null;
}
/** The round 2 rule: the same three tests as round 1, now with M, SL and MSL as the tested arms. Written before any result. */
export const ROUND2_RULE = ROUND1_RULE;
/**
 * Round 2 arms: the full list plus armory_find, hits id-only, no probe line, as round 1 C. C is the control (the shipped hint). SL is C plus
 * the shortlist note; MSL is M plus it. H2 is round 1's strong hint, a reference point only.
 */
export const ARMS_ROUND2 = [
  r1Arm('C', SEARCH_HINT),
  r1Arm('M', MIDDLE_HINT),
  r1Arm('SL', SEARCH_HINT, { shortlist: true }),
  r1Arm('MSL', MIDDLE_HINT, { shortlist: true }),
  r1Arm('H2', STRONG_HINT),
];
export const ARMS_SMOKE_ROUND2 = [ARMS_ROUND2[2], ARMS_ROUND2[1]];
const ROUND2_TESTED = ['M', 'SL', 'MSL'];

/** The mode named in a .sweep-mode file. Empty text gives the default; an unknown word throws, so a typo never runs the wrong job. */
export function parseSweepMode(text) {
  const word = String(text ?? '').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).find((l) => l) ?? '';
  if (!word) return DEFAULT_MODE;
  const mode = word.toLowerCase();
  if (!MODES.includes(mode)) throw Object.assign(new Error('mode'), { code: 'BAD_MODE' });
  return mode;
}
const GEN_MODEL = 'haiku';
const JUDGE_MODEL = 'sonnet';
const FETCH_CONCURRENCY = 8;
const PROBE_CONCURRENCY = 3;
const FIRST_CALL_USD = 0.005;
/** A full run with fewer real negatives than this measures nothing about false calls, so the job fails. */
const MIN_NEGATIVES = 50;
/** Share of the cap that prompt writing and judging may use, so the arms always get most of it. */
const PREP_SHARE = 0.35;

// ---------- the pre-registered rule ----------

export function ruleText() {
  const r = THRESHOLD_RULE;
  return [
    'Pre-registered rule (written before any result):',
    'The threshold is the smallest tested size N such that, at N and at every larger tested size, all four hold:',
    `1. gold rate of S minus gold rate of A is at least ${r.minGoldDiff};`,
    `2. McNemar shows no significant loss for S (two-sided exact test, alpha ${r.mcnemarAlpha});`,
    `3. the false Skill call rate of S on negatives is at most A's plus ${r.maxExtraFalseCalls * 100} percentage point;`,
    `4. S saves at least ${r.minTokenSaving * 100} percent of mean input tokens per call.`,
    "The recommended 'auto' threshold is the largest tested size below N; the core rule is \"more than X skills\".",
    'If no N exists, the short list should be opt-in only.',
  ].join('\n');
}

/** Does one size row pass all four tests? A row with no pairs fails. */
export function rowPasses(row) {
  const r = THRESHOLD_RULE;
  if (!row || !row.pairs) return false;
  const lossSignificant = row.mcnemarP < r.mcnemarAlpha && row.table.aOnly > row.table.sOnly;
  return row.diff >= r.minGoldDiff - 1e-9
    && !lossSignificant
    && row.falseS <= row.falseA + r.maxExtraFalseCalls + 1e-9
    && row.tokenSaving !== null && row.tokenSaving >= r.minTokenSaving - 1e-9;
}

/** rows are sorted by size. Returns { n, recommended, passes } where n is the smallest size from which every larger size passes. */
export function decideThreshold(rows, passFn = rowPasses) {
  const sorted = rows.slice().sort((a, b) => a.size - b.size);
  const passes = sorted.map((row) => ({ size: row.size, pass: passFn(row) }));
  let n = null;
  for (let i = sorted.length - 1; i >= 0 && passes[i].pass; i--) n = sorted[i].size;
  const below = sorted.filter((r) => n !== null && r.size < n);
  return { n, recommended: below.length ? below[below.length - 1].size : null, passes };
}

// ---------- subsets ----------

/** Nested seeded subsets: one shuffle, each size is a prefix, so a smaller set is always inside a larger one. */
export function nestedSubsets(items, sizes, seed = SEED) {
  const order = sample(items, items.length, seed);
  return sizes.map((size) => ({ size, items: order.slice(0, Math.min(size, order.length)) }));
}

// ---------- the cap ----------

/** A spend counter. A child counts against its own limit and the parent's. */
export function makeSpend(cap, parent = null) {
  const s = {
    cap, spent: 0, calls: 0,
    add(cost) { s.spent += cost; s.calls++; parent?.add(cost); },
    left() { return Math.min(s.cap - s.spent, parent ? parent.left() : Infinity); },
    /** True when a call expected to cost about `est` would still fit. */
    fits(est) { return s.left() >= est; },
  };
  return s;
}

// ---------- the catalog ----------

const RESERVED = new Set(['docs', 'api', 'site', 'trending', 'hot', 'audits', 'agents', 'official', 'about', 'leaderboard', 'blog', 'login', 'privacy', 'terms', 'static']);

/** The skills a skills.sh page links to: /owner/repo/skill links, plus any embedded JSON with a source and a skill id. */
export function parseSkillsSh(html) {
  const out = [];
  const seen = new Set();
  let nonGithub = 0;
  const add = (owner, repo, name) => {
    const key = `${owner}/${repo}/${name}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ owner, repo, name });
  };
  const text = html.replaceAll('\\"', '"');
  for (const m of text.matchAll(/href="\/site\/[^"]+"/g)) { void m; nonGithub++; }
  for (const m of text.matchAll(/href="\/([\w.-]+)\/([\w.-]+)\/([\w.:-]+)(?:[?#][^"]*)?"/g)) {
    const [, owner, repo, name] = m;
    if (RESERVED.has(owner.toLowerCase()) || owner.startsWith('_')) continue;
    add(owner, repo, name);
  }
  for (const m of text.matchAll(/"(?:source|repo)":"([\w.-]+)\/([\w.-]+)","(?:skillId|skill|name)":"([\w.:-]+)"/g)) add(m[1], m[2], m[3]);
  return { skills: out, nonGithub };
}

/** name and description from a SKILL.md frontmatter. Returns null when there is no frontmatter. */
export function parseFrontmatter(md) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    const block = /^[>|][+-]?$/.test(value);
    const parts = block ? [] : [value];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
    value = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    out[kv[1]] = value;
  }
  return { name: out.name ?? '', description: out.description ?? '' };
}

/** A safe directory and skill name. */
export const safeName = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

async function getText(fetchFn, url, headers) {
  const res = await fetchFn(url, { headers });
  if (!res.ok) throw Object.assign(new Error('http'), { code: `HTTP_${res.status}` });
  return res.text();
}

/**
 * Builds the catalog: skills.sh first, then a GitHub code search top-up when skills.sh gives too few. Only name and description are kept.
 * Returns { skills: [{name, description, from}], source, counts }. Nothing it prints holds a skill's text.
 */
export async function buildCatalog({ fetch: fetchFn, token, target = CATALOG_TARGET, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const ghHeaders = { 'user-agent': 'legion-skill-sweep', accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const counts = { candidates: 0, fetched: 0, noDescription: 0, duplicate: 0, notFound: 0, fetchError: 0, nonGithub: 0 };
  const sources = [];
  const trees = new Map(); // owner/repo -> Promise<paths[]>

  const treeOf = (owner, repo) => {
    const key = `${owner}/${repo}`;
    if (!trees.has(key)) {
      trees.set(key, getText(fetchFn, `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, ghHeaders)
        .then((t) => (JSON.parse(t).tree ?? []).filter((e) => e.type === 'blob' && /(^|\/)SKILL\.md$/i.test(e.path)).map((e) => e.path)));
    }
    return trees.get(key);
  };
  const pathFor = async (c) => {
    if (c.path) return c.path;
    const paths = await treeOf(c.owner, c.repo);
    const want = c.name.toLowerCase();
    const hits = paths.filter((p) => p.split('/').slice(-2, -1)[0]?.toLowerCase() === want).sort((a, b) => a.length - b.length);
    if (hits[0]) return hits[0];
    return paths.length === 1 && paths[0].toLowerCase() === 'skill.md' && c.repo.toLowerCase() === want ? paths[0] : null;
  };
  const load = async (c) => {
    try {
      const path = await pathFor(c);
      if (!path) return { skip: 'notFound' };
      const md = await getText(fetchFn, `https://raw.githubusercontent.com/${c.owner}/${c.repo}/HEAD/${enc(path)}`, {});
      const fm = parseFrontmatter(md);
      if (!fm || !fm.description) return { skip: 'noDescription' };
      const name = safeName(fm.name || c.name);
      return name ? { name, description: fm.description, from: `${c.owner}/${c.repo}` } : { skip: 'noDescription' };
    } catch {
      return { skip: 'fetchError' };
    }
  };

  const taken = new Set();
  const skills = [];
  const consume = async (cands) => {
    for (let i = 0; i < cands.length && skills.length < target; i += FETCH_CONCURRENCY * 4) {
      const chunk = cands.slice(i, i + FETCH_CONCURRENCY * 4);
      const done = new Array(chunk.length);
      let next = 0;
      await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, async () => {
        for (;;) { const j = next++; if (j >= chunk.length) return; done[j] = await load(chunk[j]); }
      }));
      for (const d of done) {
        counts.candidates++;
        if (skills.length >= target) break;
        if (d.skip) { counts[d.skip]++; continue; }
        if (taken.has(d.name)) { counts.duplicate++; continue; }
        taken.add(d.name);
        skills.push(d);
        counts.fetched++;
      }
    }
  };

  // skills.sh: the leaderboard page, then ?page=N while a page still adds skills.
  const listed = [];
  try {
    const seen = new Set();
    for (let page = 1; page <= 8; page++) {
      const html = await getText(fetchFn, page === 1 ? 'https://skills.sh/' : `https://skills.sh/?page=${page}`, { 'user-agent': 'legion-skill-sweep' });
      const { skills: found, nonGithub } = parseSkillsSh(html);
      if (page === 1) counts.nonGithub = nonGithub;
      const fresh = found.filter((s) => !seen.has(`${s.owner}/${s.repo}/${s.name}`.toLowerCase()));
      fresh.forEach((s) => seen.add(`${s.owner}/${s.repo}/${s.name}`.toLowerCase()));
      if (fresh.length === 0) break;
      listed.push(...fresh);
    }
  } catch (e) {
    log(`skills.sh could not be read (${e?.code ?? 'error'})`);
  }
  log(`skills.sh gave ${listed.length} candidates`);
  if (listed.length >= 50) {
    sources.push('skills.sh');
    await consume(listed);
  }

  if (skills.length < target) {
    // The fallback: GitHub code search for SKILL.md files under a skills folder. The API cannot sort by stars, so this is its own order.
    const found = [];
    try {
      for (let page = 1; page <= 10 && found.length < target * 2; page++) {
        const body = JSON.parse(await getText(fetchFn, `https://api.github.com/search/code?q=${encodeURIComponent('filename:SKILL.md path:skills')}&per_page=100&page=${page}`, ghHeaders));
        const items = body.items ?? [];
        if (items.length === 0) break;
        for (const it of items) {
          const parts = String(it.path).split('/');
          const name = parts.length > 1 ? parts[parts.length - 2] : '';
          const [owner, repo] = String(it.repository?.full_name ?? '').split('/');
          if (name && owner && repo) found.push({ owner, repo, name, path: it.path });
        }
        await sleep(7000);
      }
    } catch (e) {
      log(`github code search failed (${e?.code ?? 'error'})`);
    }
    log(`github code search gave ${found.length} candidates`);
    if (found.length) {
      sources.push('github-search');
      await consume(found);
    }
  }
  return { skills, source: sources.join(' + ') || 'none', counts };
}

// ---------- the temp HOME ----------

/** Writes ~/.claude/skills/<name>/SKILL.md for each skill (frontmatter plus a one-line body). Returns the home folder. */
export function writeHome(root, skills) {
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  for (const s of skills) {
    const dir = join(root, '.claude', 'skills', s.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\nUse this skill when the request matches its description.\n`);
  }
  return root;
}

// ---------- prompts and judging ----------

const WORDS = /[a-z][a-z0-9]{3,}/g;
const STOP = new Set(['this', 'that', 'with', 'from', 'when', 'your', 'have', 'will', 'into', 'using', 'used', 'user', 'skill', 'should', 'about', 'which', 'their', 'there', 'also', 'such', 'more', 'than', 'other', 'make', 'help']);
const tokensOf = (s) => new Set((String(s).toLowerCase().match(WORDS) ?? []).filter((w) => !STOP.has(w)));

/** The skills whose words overlap a text the most. The judge sees these as "the other skills that could apply". */
export function closest(text, skills, n, exceptName) {
  const t = tokensOf(text);
  return skills
    .filter((s) => s.name !== exceptName)
    .map((s) => {
      let hit = 0;
      for (const w of s.tokens) if (t.has(w)) hit++;
      return { s, hit };
    })
    .sort((a, b) => b.hit - a.hit || (a.s.name < b.s.name ? -1 : 1))
    .slice(0, n)
    .map((x) => x.s);
}

/** The first JSON array in a model answer, or null. */
export function parseJsonArray(text) {
  const body = String(text).replace(/```(?:json)?/gi, '');
  const a = body.indexOf('[');
  const b = body.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(body.slice(a, b + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** One text-only model call. Returns { text, cost }. Errors give an empty text. */
async function ask(query, spend, { model, system, prompt, cwd }) {
  let text = '';
  let cost = 0;
  try {
    for await (const m of query({ prompt, options: { model, maxTurns: 1, cwd, settingSources: [], strictMcpConfig: true, persistSession: false, tools: [], systemPrompt: system, settings: { disableAllHooks: true }, env: { ...process.env } } })) {
      if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b?.type === 'text') text += b.text;
      if (m.type === 'result') cost = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0;
    }
  } catch { /* counted by the caller as an empty answer */ }
  spend.add(cost);
  return { text, cost };
}

const GEN_SYSTEM = 'You write realistic test requests for an AI coding assistant. For each skill listed, write the requests a real user would type '
  + 'when that skill is the right tool. Do not copy the skill\'s distinctive words, do not name the skill, and sound like a person in a hurry. '
  + 'Answer with a JSON array only: [{"n":1,"requests":["...","..."]}].';
const NEG_SYSTEM = 'You write realistic everyday requests to an AI coding assistant: small coding tasks, debugging questions, git questions, quick chat. '
  + 'None should need a specialist skill. Vary topic and length. Answer with a JSON array of strings only.';
const JUDGE_POS_SYSTEM = 'You grade test requests. Each item has a request, a target skill and a few other skills. Say whether the request clearly calls for the '
  + 'target skill and for no other listed skill (ok 1), or not (ok 0). Judge the request on its own words. Answer with a JSON array only: [{"n":1,"ok":1}].';
const JUDGE_NEG_SYSTEM = 'You grade test requests. Each item has a request and a list of skills. Say whether any listed skill would clearly apply to the request '
  + '(applies 1) or none would (applies 0). Answer with a JSON array only: [{"n":1,"applies":0}].';

const oneLine = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
const chunked = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

/**
 * Haiku writes the requests, a Sonnet judge grades them, failures are dropped. Stops when the prep budget is used.
 * Returns { positives: [{prompt, gold}], negatives: [prompt], stats }.
 */
export async function makePrompts({ query, spend, skills, perSkill = 2, negWanted = NEGATIVES_WANTED, hard = false, cwd, log = () => {} }) {
  const stats = { written: 0, kept: 0, negWritten: 0, negKept: 0, badBatches: 0, stoppedForBudget: false, hardWritten: 0, hardKept: 0, hardAmbiguous: 0, hardApplies: 0, hardUnjudged: 0 };
  const withTokens = skills.map((s) => ({ ...s, tokens: tokensOf(`${s.name} ${s.description}`) }));
  const byName = new Map(withTokens.map((s) => [s.name, s]));
  const est = () => Math.max(0.03, spend.calls ? spend.spent / spend.calls : 0.03);

  const written = [];
  for (const batch of chunked(withTokens, 10)) {
    if (!spend.fits(est() * 2)) { stats.stoppedForBudget = true; break; }
    const prompt = batch.map((s, i) => `Skill ${i + 1}: ${s.name}: ${oneLine(s.description, 300)}`).join('\n') + `\nWrite ${perSkill} requests for each skill.`;
    const { text } = await ask(query, spend, { model: GEN_MODEL, system: GEN_SYSTEM, prompt, cwd });
    const arr = parseJsonArray(text);
    if (!arr) { stats.badBatches++; continue; }
    for (const r of arr) {
      const s = batch[Number(r?.n) - 1];
      if (!s || !Array.isArray(r.requests)) continue;
      for (const q of r.requests.slice(0, perSkill)) if (typeof q === 'string' && q.trim().length > 5) written.push({ prompt: q.trim(), gold: s.name });
    }
  }
  stats.written = written.length;

  const negWritten = new Set();
  for (let i = 0; i < Math.ceil(negWanted / 50) && negWritten.size < negWanted * 1.5; i++) {
    if (!spend.fits(est() * 2)) { stats.stoppedForBudget = true; break; }
    const { text } = await ask(query, spend, { model: GEN_MODEL, system: NEG_SYSTEM, prompt: `Write ${Math.min(50, negWanted)} different requests. Batch ${i + 1}: take a fresh angle.`, cwd });
    const arr = parseJsonArray(text);
    if (!arr) { stats.badBatches++; continue; }
    for (const q of arr) if (typeof q === 'string' && q.trim().length > 5) negWritten.add(q.trim());
  }
  stats.negWritten = negWritten.size;

  const positives = [];
  for (const batch of chunked(written, 8)) {
    if (!spend.fits(est() * 2)) { stats.stoppedForBudget = true; break; }
    const prompt = batch.map((w, i) => {
      const g = byName.get(w.gold);
      const others = closest(`${w.prompt} ${g.description}`, withTokens, 5, w.gold).map((o) => `- ${o.name}: ${oneLine(o.description, 120)}`).join('\n');
      return `Item ${i + 1}\nRequest: ${w.prompt}\nTarget: ${g.name}: ${oneLine(g.description, 250)}\nOther skills:\n${others}`;
    }).join('\n\n');
    const { text } = await ask(query, spend, { model: JUDGE_MODEL, system: JUDGE_POS_SYSTEM, prompt, cwd });
    const arr = parseJsonArray(text);
    if (!arr) { stats.badBatches++; continue; }
    for (const r of arr) if (Number(r?.ok) === 1 && batch[Number(r?.n) - 1]) positives.push(batch[Number(r.n) - 1]);
  }
  stats.kept = positives.length;

  const negatives = [];
  for (const batch of chunked([...negWritten], 10)) {
    if (!spend.fits(est() * 2)) { stats.stoppedForBudget = true; break; }
    const prompt = batch.map((q, i) => `Item ${i + 1}\nRequest: ${q}\nSkills:\n${closest(q, withTokens, 12).map((o) => `- ${o.name}: ${oneLine(o.description, 120)}`).join('\n')}`).join('\n\n');
    const { text } = await ask(query, spend, { model: JUDGE_MODEL, system: JUDGE_NEG_SYSTEM, prompt, cwd });
    const arr = parseJsonArray(text);
    if (!arr) { stats.badBatches++; continue; }
    for (const r of arr) if (Number(r?.applies) === 0 && batch[Number(r?.n) - 1]) negatives.push(batch[Number(r.n) - 1]);
  }
  stats.negKept = negatives.length;

  // Hard negatives: one request per skill that uses its topic words but needs no specialist skill. A Sonnet judge sees the 12 closest
  // skills (the source skill first) and gives none / ambiguous / applies.
  let hardOut = { hard: [], ambiguous: [] };
  if (hard) {
    const cands = [];
    const seen = new Set([...negWritten]);
    for (const batch of chunked(withTokens, 10)) {
      if (!spend.fits(est() * 2)) { stats.stoppedForBudget = true; break; }
      const prompt = batch.map((s, i) => `Skill ${i + 1}: ${s.name}: ${oneLine(s.description, 300)}`).join('\n') + '\nWrite one request for each skill.';
      const { text } = await ask(query, spend, { model: GEN_MODEL, system: HARD_GEN_SYSTEM, prompt, cwd });
      const arr = parseJsonArray(text);
      if (!arr) { stats.badBatches++; continue; }
      for (const r of arr) {
        const s = batch[Number(r?.n) - 1];
        const q = typeof r?.request === 'string' ? r.request.trim() : '';
        if (s && q.length > 5 && !seen.has(q)) { seen.add(q); cands.push({ prompt: q, source: s.name }); }
      }
    }
    stats.hardWritten = cands.length;
    const verdicts = new Array(cands.length).fill(undefined);
    let at = 0;
    for (const batch of chunked(cands, 8)) {
      if (!spend.fits(est() * 2)) { stats.stoppedForBudget = true; break; }
      const prompt = batch.map((c, i) => {
        const others = [byName.get(c.source), ...closest(c.prompt, withTokens, 11, c.source)].map((o) => `- ${o.name}: ${oneLine(o.description, 120)}`).join('\n');
        return `Item ${i + 1}\nRequest: ${c.prompt}\nSkills:\n${others}`;
      }).join('\n\n');
      const { text } = await ask(query, spend, { model: JUDGE_MODEL, system: HARD_JUDGE_SYSTEM, prompt, cwd });
      parseHardVerdicts(text, batch.length).forEach((v, i) => { verdicts[at + i] = v; });
      at += batch.length;
    }
    const b = bucketHardNegatives(cands, verdicts);
    hardOut = { hard: b.hard, ambiguous: b.ambiguous };
    Object.assign(stats, { hardKept: b.hard.length, hardAmbiguous: b.ambiguous.length, hardApplies: b.applies, hardUnjudged: b.unjudged });
  }
  log(`prompts: ${stats.written} positives written, ${stats.kept} kept; ${stats.negWritten} negatives written, ${stats.negKept} kept; ${stats.hardWritten} hard written, ${stats.hardKept} kept, ${stats.hardAmbiguous} ambiguous; ${stats.badBatches} unparsed batches`);
  return { positives, negatives: negatives.slice(0, negWanted), hard: hardOut.hard, ambiguous: hardOut.ambiguous, stats };
}

// ---------- the arms ----------

/** Does a Skill call name the gold skill? Plugin prefixes and a leading slash are ignored. */
export const normalizeSkillName = (called) => (called === null || called === undefined ? null : safeName(String(called).replace(/^\//, '').split(':').pop()));
export const isGold = (called, gold) => called !== null && normalizeSkillName(called) === safeName(gold);

/**
 * Runs every arm for every item, interleaved across sizes (item 0 of every size, then item 1 ...), so a stop at the cap leaves
 * similar counts per size. Items: [{ size, i, kind, prompt, gold }]. The arms of one item run one after the other, in an order that
 * turns with the item number, so no arm always goes first. Returns the records (no prompt text).
 *
 * An arm with `search: true` gets Legion's own armory_find server. `search` is { forSize(size) -> find function, buildServer(find) ->
 * server config }; every search is recorded per call (how many, and the first five ids each returned).
 */
export async function runArms({ query, spend, items, homes, arms = ARMS_11E, search = null, model = 'haiku', concurrency = PROBE_CONCURRENCY, workDir, log = () => {} }) {
  if (arms.some((a) => a.search) && !search) throw Object.assign(new Error('search'), { code: 'NO_SEARCH' });
  const records = [];
  const costs = [];
  let next = 0;
  let stopped = false;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length || stopped) return;
      const it = items[idx];
      // Before the first answer, a Haiku call is about $0.005 (measured in the 11e run); 0.05 stopped every small run.
      const avg = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : FIRST_CALL_USD;
      if (!spend.fits(arms.length * avg * 1.5 * Math.min(concurrency, items.length))) { stopped = true; return; }
      const home = homes.get(it.size);
      const turn = idx % arms.length;
      for (const arm of [...arms.slice(turn), ...arms.slice(0, turn)]) {
        const searched = [];
        const queries = []; // in memory only, for the miss split: never serialised, logged or uploaded
        let described = 0;
        const useSearch = arm.search ? search : null;
        const describe = arm.describeHits === true;
        if (arm.shortlist && !useSearch) throw Object.assign(new Error('search'), { code: 'NO_SEARCH' });
        const find = useSearch?.forSize(it.size, arm.thirdParty === true, describe);
        // Shortlist arms: the note is built inside the prompt hook from Legion's own ranking of the prompt. This ranking is not a model search.
        let noteIds = null;
        const rank = arm.shortlist ? useSearch.forSize(it.size, true, false) : null;
        const noteFor = rank ? async (p) => {
          noteIds = (await rank(String(p), SHORTLIST_SIZE)).slice(0, SHORTLIST_SIZE).map((h) => h.id);
          return buildShortlistNote(noteIds);
        } : null;
        const server = useSearch?.buildServer(async (q, limit) => {
          queries.push(String(q));
          const hits = await find(q, limit);
          searched.push(hits.slice(0, 5).map((h) => h.id));
          return hits;
        }, { describe, onDescribed: (n) => { described += n; } });
        const rec = await runSkillCall(query, {
          model, prompt: it.prompt, cwd: workDir, append: arm.append,
          settings: arm.settings,
          ...(noteFor ? { noteFor } : {}),
          ...(server ? { maxTurns: MAX_TURNS, mcpServers: { legion_armory: server }, allowedTools: [FIND_TOOL] } : {}),
          env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') },
        });
        spend.add(rec.cost);
        if (rec.cost > 0) costs.push(rec.cost);
        const hit = it.kind === 'pos' && isGold(rec.called, it.gold);
        const out = {
          size: it.size, i: it.i, kind: it.kind, bucket: it.bucket ?? null, arm: arm.name, called: rec.called !== null, calledName: normalizeSkillName(rec.called),
          hit, accepted: hit, tokens: inputTokens(rec.tokens), cost: rec.cost, error: rec.error ?? null,
          searches: searched.length, goldInTop5: it.kind === 'pos' && searched.some((ids) => ids.some((id) => isGold(id, it.gold))),
          listed: rec.init?.skills ?? null, listedDescribed: rec.init?.skillsDescribed ?? null, describedHits: described,
          noteFired: rec.fired, noted: rec.noted, hookEvents: rec.hookEvents, noteSeen: rec.noteSeen, noteSize: noteIds ? noteIds.length : null,
          goldInNote: it.kind === 'pos' && Boolean(noteIds?.some((id) => isGold(id, it.gold))),
        };
        Object.defineProperty(out, 'queries', { value: queries, enumerable: false });
        records.push(out);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(`arms: ${records.length} calls, stopped at the cap ${stopped}`);
  return { records, stopped };
}

/**
 * One arm against the baseline at one size, on the items that have both. Gold is the first Skill call naming the gold skill.
 * The false-call test pairs the negatives: `more` is the prompts where the arm called a skill and the baseline did not, `fewer` the reverse.
 * Tokens count every turn of every prompt. Misses are the positives the arm did not get right.
 */
export function compareArms(records, size, baseName, armName, field = 'hit') {
  const mine = records.filter((r) => r.size === size);
  const key = (r) => `${r.kind}${r.i}`;
  const of = (arm) => new Map(mine.filter((r) => r.arm === arm).map((r) => [key(r), r]));
  const B = of(baseName);
  const X = of(armName);
  const both = [...B.keys()].filter((k) => X.has(k));
  const pos = both.filter((k) => k.startsWith('pos'));
  const neg = both.filter((k) => k.startsWith('neg') && B.get(k).bucket !== 'ambiguous');
  const table = { both: 0, aOnly: 0, sOnly: 0, neither: 0 };
  for (const k of pos) {
    const a = B.get(k)[field];
    const x = X.get(k)[field];
    if (a && x) table.both++; else if (a) table.aOnly++; else if (x) table.sOnly++; else table.neither++;
  }
  const n = pos.length;
  const goldBase = table.both + table.aOnly;
  const goldArm = table.both + table.sOnly;
  const more = neg.filter((k) => X.get(k).called && !B.get(k).called).length;
  const fewer = neg.filter((k) => B.get(k).called && !X.get(k).called).length;
  const falseBase = neg.filter((k) => B.get(k).called).length;
  const falseArm = neg.filter((k) => X.get(k).called).length;
  const mean = (m) => {
    const t = both.map((k) => m.get(k).tokens).filter((x) => typeof x === 'number');
    return t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null;
  };
  const tokBase = mean(B);
  const tokArm = mean(X);
  const misses = pos.filter((k) => !X.get(k)[field]).map((k) => X.get(k));
  return {
    size, arm: armName, pairs: n, negatives: neg.length, table, goldBase, goldArm,
    rateBase: n ? round(goldBase / n) : null, rateArm: n ? round(goldArm / n) : null, ciBase: wilson(goldBase, n), ciArm: wilson(goldArm, n),
    diff: n ? round((goldArm - goldBase) / n) : null, mcnemarP: round(mcnemar(table.aOnly, table.sOnly)),
    falseBase, falseArm, falseMore: more, falseFewer: fewer, falseExtra: falseArm - falseBase, falseP: round(mcnemar(more, fewer)),
    tokensBase: tokBase, tokensArm: tokArm, tokenSaving: tokBase && tokArm !== null ? round(1 - tokArm / tokBase) : null,
    searchRate: both.length ? round(both.filter((k) => X.get(k).searches > 0).length / both.length) : null,
    searchRateBase: both.length ? round(both.filter((k) => B.get(k).searches > 0).length / both.length) : null,
    misses: misses.length, missesSearched: misses.filter((r) => r.searches > 0).length, missesGoldInTop5: misses.filter((r) => r.goldInTop5).length,
  };
}

/** The 11f rule on one comparison row: all four tests. A row with no pairs or no negatives fails. */
export function rowPasses11f(row) {
  const r = ACCURACY_RULE;
  if (!row || !row.pairs || !row.negatives) return false;
  const lossSignificant = row.mcnemarP < r.mcnemarAlpha && row.table.aOnly > row.table.sOnly;
  const falseSignificant = row.falseP < r.mcnemarAlpha && row.falseMore > row.falseFewer;
  return row.diff >= r.minGoldDiff - 1e-9
    && !lossSignificant
    && !falseSignificant && row.falseExtra <= r.maxExtraFalseCalls
    && row.tokenSaving !== null && row.tokenSaving >= r.minTokenSaving - 1e-9;
}

/**
 * Per short arm: the smallest tested size from which it passes at every larger size too. The best arm has the lowest N; a tie goes to
 * the arm that saves the most tokens (mean saving over the sizes from N up).
 */
export function decideAccuracy(rowsByArm) {
  const arms = Object.entries(rowsByArm).map(([arm, rows]) => {
    const d = decideThreshold(rows, rowPasses11f);
    const from = rows.filter((r) => d.n !== null && r.size >= d.n && r.tokenSaving !== null);
    const saving = from.length ? from.reduce((a, r) => a + r.tokenSaving, 0) / from.length : null;
    return { arm, n: d.n, passes: d.passes, saving: saving === null ? null : round(saving) };
  });
  const ranked = arms.filter((a) => a.n !== null).sort((a, b) => a.n - b.n || (b.saving ?? 0) - (a.saving ?? 0));
  return { arms, best: ranked[0]?.arm ?? null };
}

/** The per-size numbers from the records. Pairs are the items that have both arms. */
export function summarize(records, sizes) {
  const rows = [];
  for (const size of sizes) {
    const mine = records.filter((r) => r.size === size);
    const key = (r) => `${r.kind}${r.i}`;
    const of = (arm) => new Map(mine.filter((r) => r.arm === arm).map((r) => [key(r), r]));
    const A = of('A');
    const S = of('S');
    const pos = [...A.keys()].filter((k) => k.startsWith('pos') && S.has(k));
    const neg = [...A.keys()].filter((k) => k.startsWith('neg') && S.has(k));
    const table = { both: 0, aOnly: 0, sOnly: 0, neither: 0 };
    for (const k of pos) {
      const a = A.get(k).hit;
      const s = S.get(k).hit;
      if (a && s) table.both++; else if (a) table.aOnly++; else if (s) table.sOnly++; else table.neither++;
    }
    const n = pos.length;
    const goldA = table.both + table.aOnly;
    const goldS = table.both + table.sOnly;
    const falseCount = (m) => neg.filter((k) => m.get(k).called).length;
    const meanTok = (m) => {
      const t = [...m.values()].map((r) => r.tokens).filter((x) => typeof x === 'number');
      return t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null;
    };
    const tokA = meanTok(A);
    const tokS = meanTok(S);
    rows.push({
      size, pairs: n, negatives: neg.length, table, goldA, goldS,
      rateA: n ? round(goldA / n) : null, rateS: n ? round(goldS / n) : null, ciA: wilson(goldA, n), ciS: wilson(goldS, n),
      diff: n ? round((goldS - goldA) / n) : null, mcnemarP: round(mcnemar(table.aOnly, table.sOnly)),
      falseA: neg.length ? round(falseCount(A) / neg.length) : 0, falseS: neg.length ? round(falseCount(S) / neg.length) : 0,
      tokensA: tokA, tokensS: tokS, tokenSaving: tokA && tokS !== null ? round(1 - tokS / tokA) : null,
    });
  }
  return rows;
}

// ---------- the report ----------

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function renderSummary({ rows, decision, catalog, prompts, spend, cap, stopped, smoke }) {
  const out = [];
  out.push('# Skill finder catalog-size sweep', '');
  if (smoke) out.push('**Smoke run.** It proves the job end to end. These numbers are not a result.', '');
  out.push('```', ruleText(), '```', '');
  out.push('## Catalog', `- source: ${catalog.source}`, `- skills fetched: ${catalog.counts.fetched}; skipped: ${catalog.counts.noDescription} without a description, ${catalog.counts.duplicate} duplicate names, ${catalog.counts.notFound} not found in the repo, ${catalog.counts.fetchError} fetch errors, ${catalog.counts.nonGithub} on non-GitHub sources`, '');
  out.push('## Prompts', `- positives: ${prompts.stats.written} written, ${prompts.stats.kept} kept by the judge; negatives: ${prompts.stats.negWritten} written, ${prompts.stats.negKept} kept`, `- model calls: written by haiku, judged by sonnet`, '');
  out.push(`## Spend`, `- $${round(spend.spent)} of the $${cap} cap over ${spend.calls} calls${stopped ? '; the run stopped at the cap, so later items did not run' : ''}`, '');
  out.push('## Results', '', '| size | pairs | gold A (95% CI) | gold S (95% CI) | S minus A | both / A only / S only / neither | McNemar p | false calls A | false calls S | tokens A | tokens S | saved | passes |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const t = r.table;
    const ci = (c) => (c[0] === null ? '' : ` (${pct(c[0])} to ${pct(c[1])})`);
    out.push(`| ${r.size} | ${r.pairs} | ${pct(r.rateA)}${ci(r.ciA)} | ${pct(r.rateS)}${ci(r.ciS)} | ${r.diff === null ? 'n/a' : `${(r.diff * 100).toFixed(1)} pts`} | ${t.both} / ${t.aOnly} / ${t.sOnly} / ${t.neither} | ${r.mcnemarP} | ${pct(r.falseA)} of ${r.negatives} | ${pct(r.falseS)} | ${r.tokensA ?? 'n/a'} | ${r.tokensS ?? 'n/a'} | ${pct(r.tokenSaving)} | ${decision.passes.find((p) => p.size === r.size)?.pass ? 'yes' : 'no'} |`);
  }
  out.push('', '## Decision');
  if (decision.n === null) out.push('No size N meets the rule at itself and every larger size. The short list should be opt-in only.');
  else {
    out.push(`N = ${decision.n}.`);
    out.push(decision.recommended === null
      ? `N is the smallest size tested, so no tested size lies below it. The rule would hold from ${decision.n} skills; test smaller sizes before choosing a threshold.`
      : `Recommended 'auto' threshold: more than ${decision.recommended} skills.`);
  }
  out.push('', '## Limits', '- The positives are written by a model from each skill\'s description, then graded; the judge saw only the closest skills by word overlap, not all of them.', '- The skills are all personal skills in a temp HOME; the model also sees Claude Code\'s own built-in skills in both arms.');
  return out.join('\n');
}

// ---------- Legion's own search tool ----------

/**
 * Legion's real modules, from the build (npm run build:ts). The search server is `buildFindServer` from src/core/armory/tools.ts, the
 * same one a Claude run gets: its name, description and schema are Legion's, not copies. The ranking is the keyword ranker
 * (scoreIndex over buildIndex), the default ranker.
 */
export async function loadArmory(distDir = new URL('../dist/src/core/', import.meta.url)) {
  const tools = await import(new URL('armory/tools.js', distDir).href);
  const bm25 = await import(new URL('armory/finder/bm25.js', distDir).href);
  const text = await import(new URL('kg/text.js', distDir).href);
  return { buildFindServer: tools.buildFindServer, buildIndex: bm25.buildIndex, scoreIndex: bm25.scoreIndex, oneLine: text.oneLine, serverName: tools.ARMORY_SERVER_NAME };
}

/**
 * The adapter. rankSearch in src/core/armory/index.ts is a closure over the live catalog, usage store and settings, none of which exist in
 * an eval, so this repeats only its keyword branch (score, drop zero, sort by score then id, cut to the limit, a description cut to 200
 * characters) over a catalog made of the size's temp skills. Every skill counts as the owner's own, so a hit carries its description.
 * `subsets` is [{ size, items }]. Returns { forSize(size, thirdParty = false) -> find function, buildServer(find) -> server config }.
 * With thirdParty, every hit is a third-party hit with no description, and Legion's own server formats it as `- id (third-party)`.
 */
export function makeSearch(mods, subsets) {
  const finders = new Map();
  const forSize = (size, thirdParty = false, describe = false) => {
    const key = `${size}:${thirdParty}:${describe}`;
    if (!finders.has(key)) {
      const items = subsets.find((s) => s.size === size)?.items ?? [];
      const docs = items.map((s) => ({ id: s.name, name: s.name, description: s.description, whenToUse: '', headings: '', source: 'yours', thirdParty: false }));
      const ix = mods.buildIndex(docs);
      const byId = new Map(docs.map((d) => [d.id, d]));
      finders.set(key, (query, limit) => [...mods.scoreIndex(ix, query)]
        .map(([id, h]) => ({ id, score: h.score }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit)
        .map((h) => (thirdParty
          ? { ...h, thirdParty: true, ...(describe ? { description: sanitizeHitDescription(byId.get(h.id).description, mods.oneLine) } : {}) }
          : { ...h, thirdParty: false, description: mods.oneLine(byId.get(h.id).description).slice(0, FIND_DESCRIPTION_CHARS).trimEnd() })));
    }
    return finders.get(key);
  };
  /**
   * With `describe`, Legion's own server still formats the answer (it prints `- id (third-party)` for a third-party hit); showDescriptions
   * then adds `: description` to those lines. `onDescribed(n)` is told how many lines got one.
   */
  const buildServer = (find, opts = {}) => {
    if (!opts.describe) return mods.buildFindServer(undefined, find);
    const shown = new Map();
    const server = mods.buildFindServer(undefined, async (query, limit) => {
      const hits = await find(query, limit);
      shown.clear();
      for (const h of hits) if (h.description) shown.set(h.id, h.description);
      return hits;
    });
    return showDescriptions(server, shown, opts.onDescribed);
  };
  return { forSize, buildServer };
}

/**
 * The description a search hit may show in arm D, as the security lens set it out: the same oneLine treatment, control and hidden
 * characters stripped, capped at 120 characters. Hidden (format) characters go first, since JavaScript counts U+FEFF as white space and
 * oneLine would turn it into a gap. Only skills in the delivered set get a description; in the eval that is every skill.
 */
export function sanitizeHitDescription(raw, oneLineFn = (s) => String(s).replace(/\s+/g, ' ').trim(), cap = HIT_DESCRIPTION_CHARS) {
  const noHidden = String(raw ?? '').replace(/\p{Cf}/gu, '');
  const flat = oneLineFn(oneLineFn(noHidden).replace(/\p{Cc}/gu, ''));
  return Array.from(flat).slice(0, cap).join('').trimEnd();
}

/**
 * Wraps the real armory_find handler so each `- id (third-party)` line gains `: description` (from `shown`, id to text). It throws when the
 * handler cannot be found, so arm D can never run as a silent copy of C.
 */
export function showDescriptions(server, shown, onDescribed = () => {}) {
  const tool = server?.instance?._registeredTools?.armory_find;
  if (!tool || typeof tool.handler !== 'function') throw Object.assign(new Error('find handler'), { code: 'NO_FIND_HANDLER' });
  const inner = tool.handler.bind(tool);
  tool.handler = async (args, extra) => {
    const res = await inner(args, extra);
    let added = 0;
    const content = (res?.content ?? []).map((c) => (c?.type !== 'text' ? c : {
      ...c,
      text: String(c.text).replace(/^- (\S+) \(third-party\)$/gm, (line, id) => {
        const d = shown.get(id);
        if (!d) return line;
        added++;
        return `${line}: ${d}`;
      }),
    }));
    onDescribed(added);
    return { ...res, content };
  };
  return server;
}

// ---------- the 11f rule and report ----------

export function ruleText11f(mode = 'accuracy-11f') {
  const r = ACCURACY_RULE;
  const tested = (mode === 'followup-11g' ? ARMS_11G : ARMS_11F).slice(1).map((a) => a.name).join(', ');
  return [
    mode === 'followup-11g' ? 'Pre-registered rule (the 11f rule, unchanged, applied to the 11g arms):' : 'Pre-registered rule (written before any result):',
    `Each tested arm (${tested}) is compared with ${BASELINE_11F} (the full listing plus the search tool) at each size, on the same prompts.`,
    'An arm passes at a size when all four hold:',
    `1. its gold rate minus the gold rate of ${BASELINE_11F} is at least ${r.minGoldDiff}; a gold hit is the first Skill call naming the gold skill, and search calls before it do not matter;`,
    `2. McNemar on the paired positives shows no significant loss (two-sided exact test, alpha ${r.mcnemarAlpha});`,
    `3. false Skill calls on the paired negatives: McNemar shows no significant increase (alpha ${r.mcnemarAlpha}), AND the arm makes at most ${r.maxExtraFalseCalls} more false calls than ${BASELINE_11F} (of ${r.negativesPerSize} negatives per size). This replaces the 11e test of plus 1 point, which was finer than one call in ${r.negativesPerSize};`,
    `4. at least ${r.minTokenSaving * 100} percent fewer input tokens per prompt, counted over all turns (search adds turns).`,
    "An arm 'passes from N' when it passes at N and at every larger tested size. The best arm has the lowest N; a tie goes to the arm that saves the most tokens.",
    ...(mode === 'followup-11g' ? [`Also printed, not part of the rule: SFH120 against AFH (gold difference, McNemar, tokens), to show whether the short list adds anything beyond the hint. AFH keeps the full listing, so it is not expected to save tokens against ${BASELINE_11F}.`] : []),
  ].join('\n');
}

const SIZE_NOTE = (r) => `${r.pairs} pos / ${r.negatives} neg`;

export function renderSummary11f({ rows, decision, catalog, prompts, spend, cap, stopped, smoke, armStats, mode = 'accuracy-11f', vsAfh = null }) {
  const out = [];
  const is11g = mode === 'followup-11g';
  out.push(is11g ? '# Skill finder: hint and third-party search, follow-up' : '# Skill finder: short list accuracy with the search tool', '');
  if (smoke) out.push('**Smoke run.** It proves the multi-turn path end to end. These numbers are not a result.', '');
  out.push('```', ruleText11f(mode), '```', '');
  out.push('## Catalog', `- source: ${catalog.source}`, `- skills fetched: ${catalog.counts.fetched}; skipped: ${catalog.counts.noDescription} without a description, ${catalog.counts.duplicate} duplicate names, ${catalog.counts.notFound} not found in the repo, ${catalog.counts.fetchError} fetch errors, ${catalog.counts.nonGithub} on non-GitHub sources`, '');
  out.push('## Prompts', `- positives: ${prompts.stats.written} written, ${prompts.stats.kept} kept by the judge; negatives: ${prompts.stats.negWritten} written, ${prompts.stats.negKept} kept`, '- model calls: written by haiku, judged by sonnet', '');
  out.push('## Spend', `- $${round(spend.spent)} of the $${cap} cap over ${spend.calls} calls${stopped ? '; the run stopped at the cap, so later items did not run' : ''}`, '');
  out.push('## Arms', '', '| arm | calls | answered | skill called | search called | searches per call | gold hits |', '|---|---|---|---|---|---|---|');
  for (const a of armStats) out.push(`| ${a.arm} | ${a.calls} | ${a.answered} | ${a.skillCalled} | ${a.searchCalled} | ${a.searchesPerCall ?? 'n/a'} | ${a.goldHits} |`);
  out.push('');
  if (!smoke) {
    out.push('## Results against ' + BASELINE_11F, '', '| arm | size | pairs | gold AF | gold arm | arm minus AF | AF only / arm only | McNemar p | false calls AF | false calls arm | extra | false p | tokens AF | tokens arm | saved | passes |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
    for (const arm of Object.keys(rows)) {
      for (const r of rows[arm]) {
        const pass = decision.arms.find((d) => d.arm === arm)?.passes.find((p) => p.size === r.size)?.pass;
        out.push(`| ${arm} | ${r.size} | ${SIZE_NOTE(r)} | ${pct(r.rateBase)} | ${pct(r.rateArm)} | ${r.diff === null ? 'n/a' : `${(r.diff * 100).toFixed(1)} pts`} | ${r.table.aOnly} / ${r.table.sOnly} | ${r.mcnemarP} | ${r.falseBase} | ${r.falseArm} | ${r.falseExtra >= 0 ? '+' : ''}${r.falseExtra} | ${r.falseP} | ${r.tokensBase ?? 'n/a'} | ${r.tokensArm ?? 'n/a'} | ${pct(r.tokenSaving)} | ${pass ? 'yes' : 'no'} |`);
      }
    }
    if (vsAfh) {
      out.push('', '## SFH120 against AFH (not part of the rule)', '', '| size | pairs | gold AFH | gold SFH120 | SFH120 minus AFH | AFH only / SFH120 only | McNemar p | tokens AFH | tokens SFH120 | saved |', '|---|---|---|---|---|---|---|---|---|---|');
      for (const r of vsAfh) out.push(`| ${r.size} | ${SIZE_NOTE(r)} | ${pct(r.rateBase)} | ${pct(r.rateArm)} | ${r.diff === null ? 'n/a' : `${(r.diff * 100).toFixed(1)} pts`} | ${r.table.aOnly} / ${r.table.sOnly} | ${r.mcnemarP} | ${r.tokensBase ?? 'n/a'} | ${r.tokensArm ?? 'n/a'} | ${pct(r.tokenSaving)} |`);
    }
    out.push('', '## Search use and misses (counts)', '', '| arm | size | search-call rate | AF search-call rate | misses | misses with a search | misses where armory_find had the gold skill in its top 5 |', '|---|---|---|---|---|---|---|');
    for (const arm of Object.keys(rows)) for (const r of rows[arm]) out.push(`| ${arm} | ${r.size} | ${pct(r.searchRate)} | ${pct(r.searchRateBase)} | ${r.misses} | ${r.missesSearched} | ${r.missesGoldInTop5} |`);
    out.push('', '## Decision');
    for (const a of decision.arms) out.push(`- ${a.arm}: ${a.n === null ? 'passes from none of the tested sizes' : `passes from N = ${a.n} (mean saving from there ${pct(a.saving)})`}`);
    out.push(decision.best ? `Best arm: ${decision.best}.` : 'No arm passes at any tested size from which it keeps passing.');
  }
  out.push('', '## Limits', "- The positives are written by a model from each skill's description, then graded; the judge saw only the closest skills by word overlap, not all of them.", "- The skills are all personal skills in a temp HOME; the model also sees Claude Code's own built-in skills in every arm.", "- Search hits carry descriptions (every skill counts as the owner's own) and use Legion's keyword ranker over the size's skills only.", '- Input tokens are the sum over all turns of fresh, cache-read and cache-write tokens.');
  if (is11g) out.push('- Per size, up to 100 positives and 60 negatives. A small size has fewer positives: at size 10 there are about 20 (two written per skill, then judged). The pairs column shows the real counts.', '- SFH120-TP answers every search hit as a third-party skill: the id and "(third-party)", no description, as Legion does for third-party skills. The listing is unchanged.');
  return out.join('\n');
}

/** Counts per arm over all records, for the Arms table. */
export function armStats(records, armNames) {
  return armNames.map((arm) => {
    const mine = records.filter((r) => r.arm === arm);
    const searches = mine.reduce((a, r) => a + (r.searches ?? 0), 0);
    return {
      arm, calls: mine.length, answered: mine.filter((r) => r.error === null).length, skillCalled: mine.filter((r) => r.called).length,
      searchCalled: mine.filter((r) => (r.searches ?? 0) > 0).length, searchesPerCall: mine.length ? round(searches / mine.length) : null,
      goldHits: mine.filter((r) => r.hit).length,
    };
  });
}


// ---------- round 1: hard negatives, the equivalence judge, the miss split, the rule ----------

const HARD_GEN_SYSTEM = 'You write plain, everyday-sounding requests to an AI coding assistant. For each skill listed, write ONE request that uses the skill\'s topic words '
  + 'but that a general assistant answers well without any specialist skill: a conceptual question, a definition, a one-line fix or a small chat task. '
  + 'Do not ask for the skill\'s own specialist workflow and do not name the skill. Answer with a JSON array only: [{"n":1,"request":"..."}].';
const HARD_JUDGE_SYSTEM = 'You grade test requests. Each item has a request and a list of skills. Give one verdict per item: "none" when none applies to the request, '
  + '"applies" when a listed skill clearly applies, "ambiguous" when a careful reader could reasonably say either. Judge the request on its own words. '
  + 'Answer with a JSON array only: [{"n":1,"verdict":"none"}].';
const EQUIV_SYSTEM = 'You grade whether a skill would solve a request. Each item has a request and two skills, A and B. Both skills are candidates. Judge each skill on its own, '
  + 'from its description only: give 1 if a user would be clearly well served by loading it for this request, else 0. Answer with a JSON array only: [{"n":1,"a":1,"b":0}].';
const HARD_VERDICTS = new Set(['none', 'applies', 'ambiguous']);

/** One verdict per item, in order: 'none' | 'applies' | 'ambiguous', or undefined when the answer lacks it or says something else. */
export function parseHardVerdicts(text, count) {
  const out = new Array(count).fill(undefined);
  for (const r of parseJsonArray(text) ?? []) {
    const idx = Number(r?.n) - 1;
    const v = String(r?.verdict ?? '').toLowerCase();
    if (Number.isInteger(idx) && idx >= 0 && idx < count && HARD_VERDICTS.has(v)) out[idx] = v;
  }
  return out;
}

/**
 * Sorts judged hard-negative candidates. 'none' is a clean hard negative, 'ambiguous' goes to its own bucket (reported, never pooled),
 * 'applies' is dropped, a missing verdict is unjudged. Each bucket is capped; what is cut is counted.
 */
export function bucketHardNegatives(cands, verdicts, { hardMax = ROUND1_HARD_NEGATIVES, ambMax = ROUND1_AMBIGUOUS_MAX } = {}) {
  const hard = [];
  const ambiguous = [];
  let applies = 0;
  let unjudged = 0;
  const overflow = { hard: 0, ambiguous: 0 };
  cands.forEach((c, i) => {
    const v = verdicts[i];
    if (v === 'none') { if (hard.length < hardMax) hard.push(c.prompt); else overflow.hard++; }
    else if (v === 'ambiguous') { if (ambiguous.length < ambMax) ambiguous.push(c.prompt); else overflow.ambiguous++; }
    else if (v === 'applies') applies++;
    else unjudged++;
  });
  return { hard, ambiguous, applies, unjudged, overflow };
}

/** The flags of an equivalence answer, by item number: { a, b } with 1 when the judge says that skill clearly solves the request. */
export function parseEquivalence(text) {
  const out = new Map();
  for (const r of parseJsonArray(text) ?? []) {
    const n = Number(r?.n);
    if (!Number.isInteger(n) || n < 1 || r?.a === undefined || r?.b === undefined) continue;
    out.set(n, { a: Number(r.a) === 1 ? 1 : 0, b: Number(r.b) === 1 ? 1 : 0 });
  }
  return out;
}

/** run1 showed the gold skill as A and the called skill as B; run2 showed them the other way round. Accept only if both runs say the called skill solves it. */
export const acceptEquivalent = (run1, run2) => run1?.b === 1 && run2?.a === 1;

/**
 * For each distinct { key, prompt, gold, called }: does the called skill also clearly solve the request? A Sonnet judge sees the request and
 * both descriptions as A and B, nothing about the arm, and runs twice with the order swapped. A called skill with no description in the
 * catalog (a built-in, or a name that does not exist) is 'unknown' and never accepted. Returns { verdicts: key -> 'yes' | 'no' | 'unknown'
 * | 'unjudged', stats }. An answer that does not parse counts as 'no'; a pair the budget cannot cover is 'unjudged'.
 */
export async function judgeEquivalence({ query, spend, pairs, describe, cwd, log = () => {} }) {
  const verdicts = new Map();
  const stats = { pairs: pairs.length, accepted: 0, rejected: 0, unknown: 0, unjudged: 0 };
  const known = [];
  for (const p of pairs) {
    if (describe(p.gold) && describe(p.called)) known.push(p);
    else { verdicts.set(p.key, 'unknown'); stats.unknown++; }
  }
  const est = () => Math.max(0.03, spend.calls ? spend.spent / spend.calls : 0.03);
  for (const batch of chunked(known, 10)) {
    if (!spend.fits(est() * 2)) {
      for (const p of batch) { verdicts.set(p.key, 'unjudged'); stats.unjudged++; }
      continue;
    }
    const run = async (swap) => {
      const prompt = batch.map((p, i) => {
        const g = `${p.gold}: ${oneLine(describe(p.gold), 300)}`;
        const c = `${p.called}: ${oneLine(describe(p.called), 300)}`;
        return `Item ${i + 1}\nRequest: ${p.prompt}\nSkill A: ${swap ? c : g}\nSkill B: ${swap ? g : c}`;
      }).join('\n\n');
      return parseEquivalence((await ask(query, spend, { model: JUDGE_MODEL, system: EQUIV_SYSTEM, prompt, cwd })).text);
    };
    const first = await run(false);
    const second = await run(true);
    batch.forEach((p, i) => {
      const yes = acceptEquivalent(first.get(i + 1), second.get(i + 1));
      verdicts.set(p.key, yes ? 'yes' : 'no');
      if (yes) stats.accepted++; else stats.rejected++;
    });
  }
  log(`equivalence: ${stats.pairs} pairs, ${stats.accepted} accepted, ${stats.rejected} rejected, ${stats.unknown} unknown, ${stats.unjudged} unjudged`);
  return { verdicts, stats };
}

/**
 * Where an arm's misses go at one size. A miss is a positive whose first Skill call did not name the gold skill. The four parts do not
 * overlap and add up to the misses. The last two counts overlay them: a search that never had the gold skill in its top five, and the gold
 * skill in the top five but not loaded.
 */
export function missSplit(records, size, arm) {
  const pos = records.filter((r) => r.size === size && r.arm === arm && r.kind === 'pos');
  const misses = pos.filter((r) => !r.hit);
  return {
    positives: pos.length, misses: misses.length,
    noCallNoSearch: misses.filter((r) => !r.called && !(r.searches > 0)).length,
    noCallSearched: misses.filter((r) => !r.called && r.searches > 0).length,
    acceptedAlternative: misses.filter((r) => r.called && r.accepted).length,
    wrongSkill: misses.filter((r) => r.called && !r.accepted).length,
    searchedGoldNotTop5: misses.filter((r) => r.searches > 0 && !r.goldInTop5).length,
    goldTop5NotLoaded: misses.filter((r) => r.goldInTop5).length,
  };
}

/** False loads (a Skill call) and false searches (armory_find used) on the negatives, per bucket and pooled (easy + hard; ambiguous is never pooled). */
export function negativeBuckets(records, size, baseName, armName) {
  const mine = records.filter((r) => r.size === size && r.kind === 'neg');
  const key = (r) => `${r.kind}${r.i}`;
  const of = (arm) => new Map(mine.filter((r) => r.arm === arm).map((r) => [key(r), r]));
  const B = of(baseName);
  const X = of(armName);
  const one = (bucket) => {
    const ks = [...B.keys()].filter((k) => X.has(k) && B.get(k).bucket === bucket);
    return {
      n: ks.length,
      loadsBase: ks.filter((k) => B.get(k).called).length, loadsArm: ks.filter((k) => X.get(k).called).length,
      searchesBase: ks.filter((k) => B.get(k).searches > 0).length, searchesArm: ks.filter((k) => X.get(k).searches > 0).length,
    };
  };
  const easy = one('easy');
  const hard = one('hard');
  const pooled = Object.fromEntries(Object.keys(easy).map((f) => [f, easy[f] + hard[f]]));
  return { easy, hard, ambiguous: one('ambiguous'), pooled };
}

/** One arm against the baseline at one size: accepted and strict gold side by side, plus the negatives. */
export function compareRound1(records, size, baseName, armName) {
  return {
    size, arm: armName,
    accepted: compareArms(records, size, baseName, armName, 'accepted'),
    strict: compareArms(records, size, baseName, armName, 'hit'),
    neg: negativeBuckets(records, size, baseName, armName),
  };
}

/** The round 1 tests on one row. Returns { pass, reasons }. */
export function round1RowChecks(row) {
  const r = ROUND1_RULE;
  const a = row?.accepted;
  if (!a || !a.pairs) return { pass: false, reasons: [`no positives at ${row?.size ?? '?'} skills`] };
  const reasons = [];
  if (row.size === r.bigSize) {
    if (!(a.diff >= r.minGoldDiff - 1e-9)) reasons.push(`accepted gold is ${a.diff === null ? 'n/a' : `${(a.diff * 100).toFixed(1)} points`} above C at ${r.bigSize}, need ${r.minGoldDiff * 100}`);
    if (!(a.mcnemarP < r.mcnemarAlpha && a.table.sOnly > a.table.aOnly)) reasons.push(`McNemar p ${a.mcnemarP} at ${r.bigSize} is not a significant gain`);
  }
  if (row.size === r.smallSize && a.goldBase - a.goldArm > r.maxItemsLowerAtSmall) reasons.push(`${a.goldBase - a.goldArm} items lower than C at ${r.smallSize}`);
  const p = row.neg.pooled;
  if (!p.n) reasons.push(`no negatives at ${row.size}`);
  else if (p.loadsArm - p.loadsBase > r.maxExtraFalseLoads) reasons.push(`${p.loadsArm - p.loadsBase} more false loads than C at ${row.size}, at most ${r.maxExtraFalseLoads}`);
  return { pass: reasons.length === 0, reasons };
}

/** rowsByArm: arm -> rows (compareRound1, one per size). An arm passes only with a passing row at 100 and at 25. */
export function decideRound1(rowsByArm) {
  const r = ROUND1_RULE;
  const arms = Object.entries(rowsByArm).map(([arm, rows]) => {
    const reasons = [];
    const sizes = [];
    for (const size of [r.bigSize, r.smallSize]) {
      const row = rows.find((x) => x.size === size);
      if (!row) { reasons.push(`no row at ${size} skills`); continue; }
      const c = round1RowChecks(row);
      sizes.push({ size, pass: c.pass });
      reasons.push(...c.reasons);
    }
    return { arm, pass: reasons.length === 0, reasons, sizes };
  });
  return { arms, passing: arms.filter((a) => a.pass).map((a) => a.arm) };
}

/** Report only: N (no hint) against C. Rows compare C (base) with N (arm): a significant loss for N means the hint helps. */
export function nVerdict(rows) {
  const helps = rows.some((row) => row.accepted.mcnemarP < ROUND1_RULE.mcnemarAlpha && row.accepted.table.aOnly > row.accepted.table.sOnly);
  return helps
    ? 'N against C: C (the shipped hint) is significantly better than no hint (p < 0.05) in accepted gold. The hint helps without the probe line.'
    : 'N against C: no significant difference in accepted gold. The hint has no measured gain without the probe line.';
}

/** Report only: CL against C. A significant gain for CL means the shipped short hint gives up part of what the long hint gains. */
export function clVerdict(rows) {
  const win = rows.some((row) => row.accepted.mcnemarP < ROUND1_RULE.mcnemarAlpha && row.accepted.table.sOnly > row.accepted.table.aOnly);
  return win
    ? 'CL against C: CL is significantly better than C (p < 0.05) in accepted gold. The shipped short hint loses gain.'
    : 'CL against C: CL is not significantly better than C in accepted gold. The shipped short hint keeps the gain.';
}

export function ruleTextRound1() {
  const r = ROUND1_RULE;
  return [
    'Pre-registered rule (written before any result):',
    `Each tested arm (H2, D, LH2) is compared with ${ROUND1_BASELINE} (the full listing plus armory_find plus the shipped hint) on the same prompts. Search hits show every skill as third-party (the id only), unless the arm says otherwise.`,
    'Accepted gold counts the first Skill call as right when it names the gold skill, or another skill that a blind Sonnet judge accepts in both orders. Strict gold is printed beside it; the rule uses accepted gold.',
    'An arm passes when all of these hold:',
    `1. at ${r.bigSize} skills its accepted gold is at least ${r.minGoldDiff * 100} points above ${ROUND1_BASELINE}, with McNemar p < ${r.mcnemarAlpha} (two-sided exact test on the paired positives, the gain on the arm's side);`,
    `2. it is not lower by more than one item at ${r.smallSize} skills: its accepted gold is at least ${ROUND1_BASELINE}'s minus ${r.maxItemsLowerAtSmall};`,
    `3. at both sizes its false loads (a Skill call on a negative) on the pooled negatives, easy and hard, are at most ${ROUND1_BASELINE} + ${r.maxExtraFalseLoads}. False searches are reported apart. The ambiguous bucket is reported apart and is not pooled.`,
    'CL against C: report only. If CL is significantly better than C (p < 0.05), the shipped short hint loses gain.',
    'N against C: report only. N is C with no hint. If C is significantly better than N (p < 0.05), the hint helps without the probe line; if not, the hint has no measured gain.',
  ].join('\n');
}

/**
 * A line about arm D's description path, or '' when D is not in the run. D that searched and never showed a description failed (its numbers
 * are those of C); D that never searched did not exercise the path, which proves nothing either way.
 */
export function armDCheck(armRows) {
  const d = armRows.find((a) => a.arm === 'D');
  if (!d) return '';
  if (d.searchCalled === 0) return 'Arm D did not search in this run, so its description path was not exercised.';
  if (d.describedHits === 0) return '**Check failed.** Arm D searched but showed no description in any search answer, so its numbers are those of C.';
  return '';
}

const sumBy = (records, arm, field) => records.filter((r) => r.arm === arm).reduce((a, r) => a + (r[field] ?? 0), 0);

export function renderSummaryRound1({ result, catalog, prompts, spend, cap, stopped, smoke }) {
  const out = [];
  const { rows, decision, arms, missSplit: splits, equivalence: eq, listing } = result;
  out.push('# Skill finder: accuracy round 1', '');
  if (smoke) out.push('**Smoke run.** It proves the path end to end. These numbers are not a result.', '');
  out.push('```', ruleTextRound1(), '```', '');
  out.push('## Catalog', `- source: ${catalog.source}`, `- skills fetched: ${catalog.counts.fetched}; skipped: ${catalog.counts.noDescription} without a description, ${catalog.counts.duplicate} duplicate names, ${catalog.counts.notFound} not found in the repo, ${catalog.counts.fetchError} fetch errors, ${catalog.counts.nonGithub} on non-GitHub sources`, '');
  const s = prompts.stats;
  out.push('## Prompts', `- positives: ${s.written} written, ${s.kept} kept by the judge`, `- easy negatives: ${s.negWritten} written, ${s.negKept} kept`,
    `- hard negatives: ${s.hardWritten} written; ${s.hardKept} kept (no skill applies); ${s.hardAmbiguous} ambiguous (own bucket); ${s.hardApplies} dropped (a skill applies); ${s.hardUnjudged} unjudged`,
    `- fixed pool at every size: up to ${ROUND1_EASY_NEGATIVES} easy, ${ROUND1_HARD_NEGATIVES} hard, ${ROUND1_AMBIGUOUS_MAX} ambiguous; models: written by haiku, judged by sonnet`, '');
  out.push('## Spend', `- $${round(spend.spent)} of the $${cap} cap over ${spend.calls} calls${stopped ? '; the run stopped at the cap, so later items did not run' : ''}`, '');
  out.push('## Equivalence re-score', `- distinct (request, called skill) pairs: ${eq.pairs}; accepted ${eq.accepted}, rejected ${eq.rejected}, called skill not in the catalog ${eq.unknown}, not judged ${eq.unjudged}`, '- a Sonnet judge, blind to the arm, run twice with the order swapped; a pair is accepted only if both runs say yes', '');
  out.push('## Arms', '', '| arm | calls | answered | skill called | search called | searches per call | strict gold hits | accepted gold hits | search lines with a description |', '|---|---|---|---|---|---|---|---|---|');
  for (const a of arms) out.push(`| ${a.arm} | ${a.calls} | ${a.answered} | ${a.skillCalled} | ${a.searchCalled} | ${a.searchesPerCall ?? 'n/a'} | ${a.goldHits} | ${a.acceptedHits} | ${a.describedHits} |`);
  out.push('');
  const dCheck = armDCheck(arms);
  if (dCheck) out.push(dCheck, '');
  if (!smoke) {
    const sizeNote = (r) => `${r.accepted.pairs} pos / ${r.neg.pooled.n} neg`;
    out.push('## Results against ' + ROUND1_BASELINE, '', '| arm | size | pairs | strict gold C | strict gold arm | accepted gold C | accepted gold arm | accepted arm minus C | C only / arm only | McNemar p | false loads pooled C | false loads pooled arm | false searches pooled C | false searches pooled arm | tokens saved | passes |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const arm of Object.keys(rows)) {
      for (const r of rows[arm]) {
        const a = r.accepted;
        const pass = decision.arms.find((d) => d.arm === arm)?.sizes.find((x) => x.size === r.size)?.pass;
        const searches = arm === 'LH2' ? ['n/a', 'n/a'] : [r.neg.pooled.searchesBase, r.neg.pooled.searchesArm];
        out.push(`| ${arm} | ${r.size} | ${sizeNote(r)} | ${pct(r.strict.rateBase)} | ${pct(r.strict.rateArm)} | ${pct(a.rateBase)} | ${pct(a.rateArm)} | ${a.diff === null ? 'n/a' : `${(a.diff * 100).toFixed(1)} pts`} | ${a.table.aOnly} / ${a.table.sOnly} | ${a.mcnemarP} | ${r.neg.pooled.loadsBase} | ${r.neg.pooled.loadsArm} | ${searches[0]} | ${searches[1]} | ${pct(a.tokenSaving)} | ${arm === 'CL' || arm === 'N' ? 'report only' : pass ? 'yes' : 'no'} |`);
      }
    }
    out.push('', '## Misses (accepted gold)', '', '| arm | size | positives | strict misses | no call, no search | no call, searched | accepted alternative | wrong skill | searched but gold not in top 5 | gold in top 5 but not loaded |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const m of splits) out.push(`| ${m.arm} | ${m.size} | ${m.positives} | ${m.misses} | ${m.noCallNoSearch} | ${m.noCallSearched} | ${m.acceptedAlternative} | ${m.wrongSkill} | ${m.searchedGoldNotTop5} | ${m.goldTop5NotLoaded} |`);
    out.push('', '## Hard negatives (false loads and false searches, of n)', '', '| arm | size | easy loads | easy searches | hard loads | hard searches | ambiguous loads (not pooled) | ambiguous searches |', '|---|---|---|---|---|---|---|---|');
    const cell = (b, f) => `${b[f]} of ${b.n}`;
    for (const size of result.sizes) {
      const any = Object.values(rows)[0]?.find((x) => x.size === size);
      if (any) {
        const b = any.neg;
        const base = (k) => ({ n: b[k].n, loads: b[k].loadsBase, searches: b[k].searchesBase });
        out.push(`| ${ROUND1_BASELINE} | ${size} | ${cell(base('easy'), 'loads')} | ${cell(base('easy'), 'searches')} | ${cell(base('hard'), 'loads')} | ${cell(base('hard'), 'searches')} | ${cell(base('ambiguous'), 'loads')} | ${cell(base('ambiguous'), 'searches')} |`);
      }
      for (const arm of Object.keys(rows)) {
        const r = rows[arm].find((x) => x.size === size);
        if (!r) continue;
        const a = (k) => ({ n: r.neg[k].n, loads: r.neg[k].loadsArm, searches: r.neg[k].searchesArm });
        const sr = arm === 'LH2';
        out.push(`| ${arm} | ${size} | ${cell(a('easy'), 'loads')} | ${sr ? 'n/a' : cell(a('easy'), 'searches')} | ${cell(a('hard'), 'loads')} | ${sr ? 'n/a' : cell(a('hard'), 'searches')} | ${cell(a('ambiguous'), 'loads')} | ${sr ? 'n/a' : cell(a('ambiguous'), 'searches')} |`);
      }
    }
    out.push('', '## Decision');
    for (const d of decision.arms) out.push(`- ${d.arm}: ${d.pass ? 'passes' : `does not pass (${d.reasons.join('; ')})`}`);
    out.push(decision.passing.length ? `Passing arms: ${decision.passing.join(', ')}.` : 'No arm passes the rule.');
    if (rows.CL) out.push('', clVerdict(rows.CL));
    if (rows.N) out.push('', nVerdict(rows.N));
  }
  out.push('', '## Listing', `- skills named in the init message of a run: ${listing.meanListed ?? 'n/a'} on average`);
  out.push(listing.describedObservable ? `- listed skills that carry a description: ${listing.meanDescribed} on average` : '- listed skills that carry a description: not observable. How it was checked: the SDK init message reports `skills` as a list of names (string[] in the SDK types) and the SDK does not report the system prompt or the skill listing Claude Code builds, so the count cannot be read from a run.');
  out.push('', '## Limits', "- The positives are written by a model from each skill's description, then graded; the judge saw only the closest skills by word overlap, not all of them.", "- The skills are all personal skills in a temp HOME; the model also sees Claude Code's own built-in skills in every arm.", '- Search hits use Legion\'s keyword ranker over the size\'s skills only. Hits show the id and "(third-party)" in every arm; arm D adds a sanitised description of up to 120 characters.', '- Input tokens are the sum over all turns of fresh, cache-read and cache-write tokens.', "- The negatives are synthetic. The owner's own no-skill prompts are not part of this run (the repository is public): a gap.", '- Arms carry only their hint, as Legion sends it (no probe line), so these numbers are not comparable with 11e to 11g.');
  return out.join('\n');
}

/** Marks the positives that called another skill as accepted when a blind Sonnet judge says that skill solves the request in both orders. Returns the judge's counts. */
async function applyEquivalence({ query, spend, records, items, catalog, work, log }) {
  const itemOf = new Map(items.map((it) => [`${it.size}|${it.kind}${it.i}`, it]));
  const descByName = new Map(catalog.skills.map((s) => [s.name, s.description]));
  const altKey = (rec) => {
    const it = itemOf.get(`${rec.size}|${rec.kind}${rec.i}`);
    return `${it.gold}\u0000${rec.calledName}\u0000${it.prompt}`;
  };
  const needsJudge = (rec) => rec.kind === 'pos' && rec.called && !rec.hit && rec.calledName;
  const pairs = new Map();
  for (const rec of records) {
    if (!needsJudge(rec)) continue;
    const it = itemOf.get(`${rec.size}|${rec.kind}${rec.i}`);
    const key = altKey(rec);
    if (!pairs.has(key)) pairs.set(key, { key, prompt: it.prompt, gold: it.gold, called: rec.calledName });
  }
  const { verdicts, stats: equivalence } = await judgeEquivalence({ query, spend, pairs: [...pairs.values()], describe: (n) => descByName.get(n), cwd: work, log });
  for (const rec of records) if (needsJudge(rec)) rec.accepted = verdicts.get(altKey(rec)) === 'yes';
  return equivalence;
}

/** Everything after the arms of a round 1 run: the equivalence re-score, the comparison, the splits, the frozen sets. */
async function finishRound1({ query, spend, records, items, arms, sizes, subsets, catalog, prompts, totalCap, stopped, isSmoke, common, work, log }) {
  const equivalence = await applyEquivalence({ query, spend, records, items, catalog, work, log });

  const names = arms.map((a) => a.name);
  const rows = {};
  for (const a of arms) if (a.name !== ROUND1_BASELINE) rows[a.name] = sizes.map((size) => compareRound1(records, size, ROUND1_BASELINE, a.name));
  // CL is report only, so it stays out of the rule.
  const decision = decideRound1(Object.fromEntries(Object.entries(rows).filter(([arm]) => arm !== 'CL' && arm !== 'N')));
  const splits = [];
  for (const name of names) for (const size of sizes) splits.push({ arm: name, size, ...missSplit(records, size, name) });
  const armRows = armStats(records, names).map((a) => ({ ...a, acceptedHits: records.filter((r) => r.arm === a.arm && r.accepted).length, describedHits: sumBy(records, a.arm, 'describedHits') }));
  const describedHits = Object.fromEntries(names.map((n) => [n, sumBy(records, n, 'describedHits')]));
  const listed = records.map((r) => r.listed).filter((v) => typeof v === 'number');
  const described = records.map((r) => r.listedDescribed).filter((v) => typeof v === 'number');
  const listing = {
    meanListed: listed.length ? Math.round(listed.reduce((a, b) => a + b, 0) / listed.length) : null,
    describedObservable: described.length > 0, meanDescribed: described.length ? Math.round(described.reduce((a, b) => a + b, 0) / described.length) : null,
  };
  const result = { ...common, smoke: isSmoke, rule: ROUND1_RULE, sizes, arms: armRows, rows, decision, missSplit: splits, equivalence, describedHits, listing };
  const summary = renderSummaryRound1({ result, catalog, prompts, spend, cap: totalCap, stopped, smoke: isSmoke });
  const first = sizes[0];
  const negs = (bucket) => items.filter((it) => it.kind === 'neg' && it.size === first && it.bucket === bucket).map((it) => it.prompt);
  const frozen = {
    version: 1, seed: SEED, sizes,
    catalog: Object.fromEntries(subsets.map((s) => [s.size, s.items.map((x) => x.name)])),
    positives: Object.fromEntries(sizes.map((size) => [size, items.filter((it) => it.kind === 'pos' && it.size === size).map((it) => ({ prompt: it.prompt, gold: it.gold }))])),
    negatives: { easy: negs('easy'), hard: negs('hard'), ambiguous: negs('ambiguous') },
  };
  return { summary, result, frozen };
}

// ---------- round 2: frozen sets, precision, the check, the report ----------

/** Reads the frozen file text. Throws BAD_FROZEN (a code, no text from the file) for anything but the round 1 shape. */
export function loadFrozen(text) {
  const bad = () => Object.assign(new Error('frozen file'), { code: 'BAD_FROZEN' });
  let f;
  try { f = JSON.parse(String(text)); } catch { throw bad(); }
  const strings = (x) => Array.isArray(x) && x.every((v) => typeof v === 'string');
  if (!f || f.version !== 1 || f.seed !== SEED || !Array.isArray(f.sizes) || !f.catalog || !f.positives || !f.negatives) throw bad();
  for (const size of f.sizes) {
    if (!strings(f.catalog[size])) throw bad();
    if (!Array.isArray(f.positives[size]) || !f.positives[size].every((p) => p && typeof p.prompt === 'string' && typeof p.gold === 'string')) throw bad();
  }
  for (const k of ['easy', 'hard', 'ambiguous']) if (!strings(f.negatives[k])) throw bad();
  return f;
}

/** The skills of each frozen size, picked by name from the fetched catalog in the frozen order. A name that is gone fails the job before any model call. */
export function selectFrozenSubsets(skills, frozen, sizes) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const missing = new Set();
  for (const size of sizes) for (const n of frozen.catalog[size] ?? []) if (!byName.has(n)) missing.add(n);
  if (missing.size) throw Object.assign(new Error(`${missing.size} frozen skills are not in the catalog`), { code: 'FROZEN_MISSING' });
  return sizes.map((size) => ({ size, items: frozen.catalog[size].map((n) => byName.get(n)) }));
}

/** Smoke run: one positive at one size and one easy negative. */
export function trimFrozen(frozen, size) {
  return { ...frozen, sizes: [size], catalog: { [size]: frozen.catalog[size] }, positives: { [size]: frozen.positives[size].slice(0, 1) }, negatives: { easy: frozen.negatives.easy.slice(0, 1), hard: [], ambiguous: [] } };
}

/**
 * Where an arm's loads were right. Right loads are accepted ones (the gold skill, or an alternative the judge accepts); strict counts the gold skill only.
 * Negatives: loads on the pooled easy + hard ones; ambiguous apart.
 */
export function precisionLine(records, size, arm) {
  const mine = records.filter((r) => r.size === size && r.arm === arm);
  const pos = mine.filter((r) => r.kind === 'pos');
  const loads = pos.filter((r) => r.called);
  const neg = mine.filter((r) => r.kind === 'neg');
  const pooled = neg.filter((r) => r.bucket === 'easy' || r.bucket === 'hard');
  const amb = neg.filter((r) => r.bucket === 'ambiguous');
  const rightLoads = loads.filter((r) => r.accepted).length;
  return {
    positives: pos.length, allLoads: loads.length, rightLoads, strictRight: loads.filter((r) => r.hit).length,
    precision: loads.length ? rightLoads / loads.length : null, acceptedRate: pos.length ? pos.filter((r) => r.accepted).length / pos.length : null,
    strictRate: pos.length ? pos.filter((r) => r.hit).length / pos.length : null,
    negLoads: pooled.filter((r) => r.called).length, negN: pooled.length, ambLoads: amb.filter((r) => r.called).length, ambN: amb.length,
  };
}

export function ruleTextRound2() {
  const r = ROUND2_RULE;
  return [
    'Pre-registered rule (written before any result):',
    `Each tested arm (M, SL and MSL) is compared with ${ROUND1_BASELINE} (the full listing plus armory_find plus the shipped hint) on the same frozen prompts from round 1, paired. Search hits show every skill as third-party (the id only). No arm has a probe line.`,
    "M is a middle hint. SL is C plus a per-turn note from a UserPromptSubmit hook: the top 5 skills of Legion's keyword ranking for the prompt, ids only, then a pick-one-or-none step. MSL is M plus the same note. H2 is round 1's strong hint: a reference point, report only.",
    'Accepted gold counts the first Skill call as right when it names the gold skill, or another skill that a blind Sonnet judge accepts in both orders. Strict gold is printed beside it; the rule uses accepted gold.',
    'An arm passes when all of these hold:',
    `1. at ${r.bigSize} skills its accepted gold is at least ${r.minGoldDiff * 100} points above ${ROUND1_BASELINE}, with McNemar p < ${r.mcnemarAlpha} (two-sided exact test on the paired positives, the gain on the arm's side);`,
    `2. at ${r.smallSize} skills its accepted gold is not lower than ${ROUND1_BASELINE}'s by more than one item;`,
    `3. at both sizes its false loads (a Skill call on a negative) on the pooled negatives, easy and hard, are at most ${ROUND1_BASELINE} + ${r.maxExtraFalseLoads}. The ambiguous bucket and false searches are reported apart.`,
    'Also printed, per arm and size, for the trade-off curve: right loads / all loads on positives (precision), and loads on negatives / negatives.',
  ].join('\n');
}

/** A line about the note path, or '' when no shortlist arm ran. The note reached the model only if the hook fired, built a note, and the stream shows it. */
export function shortlistCheck(armRows) {
  const rows = armRows.filter((a) => a.arm === 'SL' || a.arm === 'MSL');
  if (!rows.length) return '';
  const sum = (f) => rows.reduce((t, a) => t + (a[f] ?? 0), 0);
  const [fired, built, seen, events] = [sum('hookFired'), sum('notesBuilt'), sum('noteSeen'), sum('hookEvents')];
  if (fired === 0) return '**Check failed.** The prompt hook never fired in the shortlist arms, so SL and MSL ran as C and M.';
  if (built === 0) return `**Check failed.** The prompt hook fired ${fired} times but no note was built (no skill ranked for any prompt), so SL and MSL ran as C and M.`;
  if (seen === 0 && events === 0) return `The hook fired ${fired} times and returned ${built} notes, but the note was not shown in the message stream, so delivery is not proven by the stream.`;
  if (seen === 0) return `The hook fired ${fired} times and returned ${built} notes; the stream shows ${events} hook events but not the note text.`;
  return `The note reached the model: the hook fired ${fired} times, returned ${built} notes, and the message stream shows the note ${seen} times (${events} hook events).`;
}

export function renderSummaryRound2({ result, catalog, prompts, spend, cap, stopped, smoke }) {
  const out = [];
  const { rows, decision, arms, missSplit: splits, equivalence: eq, trade, sizes } = result;
  const f1 = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  out.push('# Skill finder: accuracy round 2', '');
  if (smoke) out.push('**Smoke run.** It proves the note path end to end. These numbers are not a result.', '');
  out.push('```', ruleTextRound2(), '```', '');
  out.push('## Catalog', `- source: ${catalog.source}`, `- skills fetched: ${catalog.counts.fetched}`, '');
  const s = prompts.stats;
  out.push('## Prompts', `- the frozen sets of round 1, not regenerated: positives ${Object.entries(s.positives).map(([k, v]) => `${v} at ${k} skills`).join(', ')}`, `- negatives: ${s.easy} easy, ${s.hard} hard, ${s.ambiguous} ambiguous (reported apart)`, '');
  out.push('## Spend', `- $${round(spend.spent)} of the $${cap} cap over ${spend.calls} calls${stopped ? '; the run stopped at the cap, so later items did not run' : ''}`, '');
  out.push('## Equivalence re-score', `- distinct (request, called skill) pairs: ${eq.pairs}; accepted ${eq.accepted}, rejected ${eq.rejected}, called skill not in the catalog ${eq.unknown}, not judged ${eq.unjudged}`, '- a Sonnet judge, blind to the arm, run twice with the order swapped; a pair is accepted only if both runs say yes', '');
  out.push('## Arms', '', '| arm | calls | answered | skill called | search called | searches per call | strict gold hits | accepted gold hits | hook fired | notes built | note seen in stream | hook events |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of arms) out.push(`| ${a.arm} | ${a.calls} | ${a.answered} | ${a.skillCalled} | ${a.searchCalled} | ${a.searchesPerCall ?? 'n/a'} | ${a.goldHits} | ${a.acceptedHits} | ${a.hookFired} | ${a.notesBuilt} | ${a.noteSeen} | ${a.hookEvents} |`);
  out.push('');
  const check = shortlistCheck(arms);
  if (check) out.push(check, '');
  if (!smoke) {
    out.push('## Results against ' + ROUND1_BASELINE, '', '| arm | size | pairs | accepted gold C | accepted gold arm | arm minus C | C only / arm only | McNemar p | false loads pooled C | false loads pooled arm | false searches pooled C | false searches pooled arm | passes |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const arm of Object.keys(rows)) {
      for (const r of rows[arm]) {
        const a = r.accepted;
        const pass = decision.arms.find((d) => d.arm === arm)?.sizes.find((x) => x.size === r.size)?.pass;
        out.push(`| ${arm} | ${r.size} | ${a.pairs} pos / ${r.neg.pooled.n} neg | ${f1(a.rateBase)} | ${f1(a.rateArm)} | ${a.diff === null ? 'n/a' : `${(a.diff * 100).toFixed(1)} pts`} | ${a.table.aOnly} / ${a.table.sOnly} | ${a.mcnemarP} | ${r.neg.pooled.loadsBase} | ${r.neg.pooled.loadsArm} | ${r.neg.pooled.searchesBase} | ${r.neg.pooled.searchesArm} | ${arm === 'H2' ? 'report only' : pass ? 'yes' : 'no'} |`);
      }
    }
    out.push('', '## Trade-off (C, M, SL, MSL and H2 on one table)', '', '| arm | size | positives | accepted gold | strict gold | right loads / all loads on positives | precision | loads on negatives / negatives | ambiguous loads / ambiguous |', '|---|---|---|---|---|---|---|---|---|');
    for (const t of trade) out.push(`| ${t.arm} | ${t.size} | ${t.positives} | ${f1(t.acceptedRate)} | ${f1(t.strictRate)} | ${t.rightLoads} / ${t.allLoads} | ${f1(t.precision)} | ${t.negLoads} / ${t.negN} | ${t.ambLoads} / ${t.ambN} |`);
    out.push('', '## Misses (accepted gold)', '', '| arm | size | positives | strict misses | no call, no search | no call, searched | accepted alternative | wrong skill | searched but gold not in top 5 | gold in top 5 but not loaded | gold in the note but not loaded |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const m of splits) out.push(`| ${m.arm} | ${m.size} | ${m.positives} | ${m.misses} | ${m.noCallNoSearch} | ${m.noCallSearched} | ${m.acceptedAlternative} | ${m.wrongSkill} | ${m.searchedGoldNotTop5} | ${m.goldTop5NotLoaded} | ${m.goldInNoteNotLoaded} |`);
    out.push('', '## Negatives (false loads and false searches, of n)', '', '| arm | size | easy loads | easy searches | hard loads | hard searches | ambiguous loads (not pooled) | ambiguous searches |', '|---|---|---|---|---|---|---|---|');
    const kinds = ['easy', 'hard', 'ambiguous'];
    for (const size of sizes) {
      const any = Object.values(rows)[0]?.find((x) => x.size === size);
      if (any) out.push(`| ${ROUND1_BASELINE} | ${size} | ${kinds.map((k) => `${any.neg[k].loadsBase} of ${any.neg[k].n} | ${any.neg[k].searchesBase} of ${any.neg[k].n}`).join(' | ')} |`);
      for (const arm of Object.keys(rows)) {
        const r = rows[arm].find((x) => x.size === size);
        if (r) out.push(`| ${arm} | ${size} | ${kinds.map((k) => `${r.neg[k].loadsArm} of ${r.neg[k].n} | ${r.neg[k].searchesArm} of ${r.neg[k].n}`).join(' | ')} |`);
      }
    }
    out.push('', '## Decision');
    for (const d of decision.arms) out.push(`- ${d.arm}: ${d.pass ? 'passes' : `does not pass (${d.reasons.join('; ')})`}`);
    out.push(decision.passing.length ? `Passing arms: ${decision.passing.join(', ')}.` : 'No arm passes the rule.', '- H2: report only, a reference point for the trade-off.');
  }
  out.push('', '## Limits', "- The positives are written by a model from each skill's description, then graded. The skills are all personal skills in a temp HOME; the model also sees Claude Code's own built-in skills in every arm.", "- The note ranks the prompt text with Legion's keyword ranker over the size's skills, with no score floor; a prompt that ranks nothing gets no note.", "- The negatives are synthetic. The owner's own no-skill prompts are not part of this run (the repository is public): a gap.", '- Input tokens are the sum over all turns of fresh, cache-read and cache-write tokens.', '- Arms carry only their hint (no probe line), as round 1; hits show the id and "(third-party)".');
  return out.join('\n');
}

/** Everything after the arms of a round 2 run. No frozen file is written: the sets are read, not made. */
async function finishRound2({ query, spend, records, items, arms, sizes, catalog, prompts, totalCap, stopped, isSmoke, common, work, log }) {
  const equivalence = await applyEquivalence({ query, spend, records, items, catalog, work, log });
  const names = arms.map((a) => a.name);
  const rows = {};
  if (!isSmoke) for (const a of arms) if (a.name !== ROUND1_BASELINE) rows[a.name] = sizes.map((size) => compareRound1(records, size, ROUND1_BASELINE, a.name));
  const decision = isSmoke ? { arms: [], passing: [] } : decideRound1(Object.fromEntries(Object.entries(rows).filter(([arm]) => ROUND2_TESTED.includes(arm))));
  const splits = [];
  for (const name of names) {
    for (const size of sizes) {
      const miss = records.filter((r) => r.size === size && r.arm === name && r.kind === 'pos' && !r.hit);
      splits.push({ arm: name, size, ...missSplit(records, size, name), goldInNoteNotLoaded: miss.filter((r) => r.goldInNote).length });
    }
  }
  const trade = [];
  if (!isSmoke) for (const size of sizes) for (const name of names) trade.push({ arm: name, size, ...precisionLine(records, size, name) });
  const armRows = armStats(records, names).map((a) => ({
    ...a, acceptedHits: records.filter((r) => r.arm === a.arm && r.accepted).length,
    hookFired: sumBy(records, a.arm, 'noteFired'), notesBuilt: sumBy(records, a.arm, 'noted'), noteSeen: sumBy(records, a.arm, 'noteSeen'), hookEvents: sumBy(records, a.arm, 'hookEvents'),
  }));
  const result = { ...common, smoke: isSmoke, rule: ROUND2_RULE, sizes, arms: armRows, rows, decision, missSplit: splits, trade, equivalence };
  const summary = renderSummaryRound2({ result, catalog, prompts, spend, cap: totalCap, stopped, smoke: isSmoke });
  return { summary, result };
}

// ---------- the whole run ----------

/** The arms' share of what is left after the prompts: the equivalence judge's reserve stays untouched, so accepted gold can always be scored. */
export function armBudget(spend, totalCap) {
  return makeSpend(Math.max(0, spend.left() - totalCap * JUDGE_RESERVE_SHARE), spend);
}

/** One planned set of items: the interleaved order (position 0 of every size, then 1 ...; positives and negatives alternate in a size). */
export function planItems(subsets, prompts, posCap, negCap, base, extra = {}) {
  const fz = extra.frozen ?? null;
  const posOrder = sample(prompts.positives, prompts.positives.length, SEED);
  const negOrder = sample(prompts.negatives, prompts.negatives.length, SEED + 1);
  // One fixed pool of negatives, the same at every size: the easy ones in their own order, with the hard and ambiguous ones (round 1) mixed in.
  // Frozen sets (round 2) keep their stored order and are never reshuffled.
  const easy = (fz ? fz.negatives.easy : negOrder).slice(0, negCap).map((prompt) => ({ prompt, bucket: 'easy' }));
  const hardL = (fz ? fz.negatives.hard : sample(extra.hard ?? [], (extra.hard ?? []).length, SEED + 2)).slice(0, ROUND1_HARD_NEGATIVES).map((prompt) => ({ prompt, bucket: 'hard' }));
  const ambL = (fz ? fz.negatives.ambiguous : sample(extra.amb ?? [], (extra.amb ?? []).length, SEED + 3)).slice(0, ROUND1_AMBIGUOUS_MAX).map((prompt) => ({ prompt, bucket: 'ambiguous' }));
  const pool = [];
  const span = Math.max(easy.length, hardL.length);
  for (let k = 0; k < span; k++) {
    if (easy[k]) pool.push(easy[k]);
    if (hardL[k]) pool.push(hardL[k]);
    if (k % 3 === 0 && ambL[k / 3]) pool.push(ambL[k / 3]);
  }
  for (let a = Math.ceil(span / 3); a < ambL.length; a++) pool.push(ambL[a]);
  const homes = new Map();
  const perSize = subsets.map((sub) => {
    homes.set(sub.size, writeHome(join(base, `home-${sub.size}`), sub.items));
    const names = new Set(sub.items.map((s) => s.name));
    return {
      size: sub.size,
      pos: (fz ? (fz.positives[sub.size] ?? []) : posOrder.filter((p) => names.has(p.gold))).slice(0, posCap).map((p, i) => ({ size: sub.size, i, kind: 'pos', prompt: p.prompt, gold: p.gold })),
      neg: pool.map((n, i) => ({ size: sub.size, i, kind: 'neg', prompt: n.prompt, gold: null, bucket: n.bucket })),
    };
  });
  const seqs = perSize.map((sz) => {
    // Round 1: positives and negatives spread evenly, so a run that stops at the cap holds the same share of both.
    if (extra.proportional) {
      const at = (list, k) => (k + 0.5) / list.length;
      return [...sz.pos.map((x, k) => ({ x, key: at(sz.pos, k) })), ...sz.neg.map((x, k) => ({ x, key: at(sz.neg, k) }))]
        .sort((a, b) => a.key - b.key || (a.x.kind === 'pos' ? -1 : 1)).map((e) => e.x);
    }
    const seq = [];
    for (let k = 0; k < Math.max(sz.pos.length, sz.neg.length); k++) { if (sz.pos[k]) seq.push(sz.pos[k]); if (sz.neg[k]) seq.push(sz.neg[k]); }
    return seq;
  });
  const items = [];
  for (let j = 0; j < Math.max(0, ...seqs.map((q) => q.length)); j++) for (const q of seqs) if (q[j]) items.push(q[j]);
  return { items, homes };
}

/** mode: 'smoke' | 'full-11e' | 'accuracy-11f' | 'followup-11g' | 'round1' | 'smoke-round1' | 'round2' | 'smoke-round2'. The old `smoke: true` still means the smoke mode. */
export async function runSweep({ query, fetch: fetchFn, token, smoke = false, mode = smoke ? 'smoke' : 'full-11e', cap, root, log = console.log, sleep, armory, frozen: frozenIn = null }) {
  if (!MODES.includes(mode)) throw Object.assign(new Error('mode'), { code: 'BAD_MODE' });
  const isR1 = mode === 'round1' || mode === 'smoke-round1';
  const isR2 = mode === 'round2' || mode === 'smoke-round2';
  const isSmoke = mode === 'smoke' || mode === 'smoke-round1' || mode === 'smoke-round2';
  // Round 2 reads the frozen round 1 sets; without them it cannot run, and it must not make new ones.
  if (isR2 && !frozenIn) throw Object.assign(new Error('frozen sets'), { code: 'NO_FROZEN' });
  const is11g = mode === 'followup-11g';
  const is11f = mode === 'accuracy-11f' || is11g || isR1 || isR2; // these use the multi-turn search arms, the 100/60 caps and concurrency 6
  const totalCap = cap ?? (isSmoke ? 0.1 : is11f ? ACCURACY_CAP_USD : CAP_USD);
  const base = mkdtempSync(join(root ?? tmpdir(), 'finder-sweep-'));
  try {
    const spend = makeSpend(totalCap);
    const prep = makeSpend(totalCap * (isSmoke ? 0.7 : PREP_SHARE), spend);
    const target = isSmoke && !isR2 ? 5 : CATALOG_TARGET; // round 2 picks its skills by name from the full catalog
    const catalog = await buildCatalog({ fetch: fetchFn, token, target, sleep, log });
    log(`catalog: ${catalog.skills.length} skills from ${catalog.source}`);
    if (catalog.skills.length < Math.min(target, 5)) throw Object.assign(new Error('catalog too small'), { code: 'CATALOG' });
    // The subsets nest over the whole 400, as in 11e, so a size holds the same skills as in that run.
    const fz = isR2 ? (isSmoke ? trimFrozen(frozenIn, frozenIn.sizes[0]) : frozenIn) : null;
    const sizes = isR2 ? fz.sizes : isSmoke ? [Math.min(5, catalog.skills.length)] : (isR1 ? ROUND1_SIZES : is11g ? FOLLOWUP_SIZES : is11f ? ACCURACY_SIZES : SIZES).filter((s) => s <= catalog.skills.length);
    // A catalog a little short of 400 still gets its own top size, so the largest size is never silently dropped.
    if (mode === 'full-11e' && catalog.skills.length > sizes[sizes.length - 1]) sizes.push(catalog.skills.length);
    // A catalog smaller than the smallest size cannot be measured; say so instead of running on nothing.
    if (sizes.length === 0) throw Object.assign(new Error('catalog too small'), { code: 'CATALOG' });
    const subsets = isR2 ? selectFrozenSubsets(catalog.skills, fz, sizes) : nestedSubsets(catalog.skills, sizes);
    const work = join(base, 'work');
    mkdirSync(work, { recursive: true });
    // Prompts are needed only for the skills of the largest size, since every smaller size sits inside it.
    const promptSkills = is11f ? subsets[subsets.length - 1].items : catalog.skills;
    const prompts = isR2 ? { positives: [], negatives: [], stats: { frozen: true, positives: Object.fromEntries(sizes.map((z) => [z, fz.positives[z].length])), easy: fz.negatives.easy.length, hard: fz.negatives.hard.length, ambiguous: fz.negatives.ambiguous.length, negKept: fz.negatives.easy.length } } : await makePrompts({ query, spend: prep, skills: promptSkills, perSkill: 2, negWanted: isSmoke ? 2 : NEGATIVES_WANTED, hard: isR1 && !isSmoke, cwd: work, log });
    // The smoke run asks one positive prompt, so each of its three arms makes exactly one call.
    const posCap = isSmoke && !isR2 ? 1 : is11f ? ACCURACY_POSITIVES : POSITIVES_PER_SIZE;
    const negCap = isSmoke && !isR2 ? 0 : is11f ? ACCURACY_NEGATIVES : NEGATIVES_PER_SIZE;
    const { items, homes } = planItems(subsets, prompts, posCap, negCap, base, isR2 ? { frozen: fz, proportional: true } : isR1 ? { hard: prompts.hard, amb: prompts.ambiguous, proportional: true } : {});
    log(`arms: ${items.length} items over sizes ${sizes.join(', ')}`);

    const arms = isR2 ? (isSmoke ? ARMS_SMOKE_ROUND2 : ARMS_ROUND2) : isR1 ? (isSmoke ? ARMS_SMOKE_ROUND1 : ARMS_ROUND1) : mode === 'full-11e' ? ARMS_11E : isSmoke ? ARMS_SMOKE : is11g ? ARMS_11G : ARMS_11F;
    const search = arms.some((a) => a.search) ? makeSearch(armory ?? await loadArmory(), subsets) : null;
    const armSpend = (isR1 || isR2) && !isSmoke ? armBudget(spend, totalCap) : spend;
    const { records, stopped } = await runArms({ query, spend: armSpend, items, homes, arms, search, concurrency: is11f ? ACCURACY_CONCURRENCY : PROBE_CONCURRENCY, workDir: work, log });
    const common = {
      seed: SEED, mode, cap: totalCap, spentUsd: round(spend.spent), calls: spend.calls, stoppedAtCap: stopped,
      armCalls: records.length, armAnswered: records.filter((r) => r.error === null).length,
      catalog: { source: catalog.source, ...catalog.counts }, prompts: prompts.stats,
    };
    if (isR2) return await finishRound2({ query, spend, records, items, arms, sizes, catalog, prompts, totalCap, stopped, isSmoke, common, work, log });
    if (isR1) return await finishRound1({ query, spend, records, items, arms, sizes, subsets, catalog, prompts, totalCap, stopped, isSmoke, common, work, log });
    if (mode === 'full-11e') {
      const rows = summarize(records, sizes);
      const decision = decideThreshold(rows);
      const summary = renderSummary({ rows, decision, catalog, prompts, spend, cap: totalCap, stopped, smoke: false });
      return { summary, result: { ...common, smoke: false, rule: THRESHOLD_RULE, sizes: rows, decision } };
    }
    const stats = armStats(records, arms.map((a) => a.name));
    const rows = {};
    for (const a of arms) if (a.name !== BASELINE_11F) rows[a.name] = sizes.map((size) => compareArms(records, size, BASELINE_11F, a.name));
    const decision = decideAccuracy(rows);
    const vsAfh = is11g ? sizes.map((size) => compareArms(records, size, 'AFH', 'SFH120')) : null;
    const summary = renderSummary11f({ rows, decision, catalog, prompts, spend, cap: totalCap, stopped, smoke: isSmoke, armStats: stats, mode, vsAfh });
    return { summary, result: { ...common, smoke: isSmoke, rule: ACCURACY_RULE, sizes, arms: stats, rows, decision, ...(vsAfh ? { vsAfh } : {}) } };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------- command line ----------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') opts.mode = 'smoke';
    else if (a === '--frozen-in' && argv[i + 1] !== undefined) opts.frozenIn = argv[++i];
    else if ((a === '--cap' || a === '--json' || a === '--mode' || a === '--mode-file' || a === '--frozen') && argv[i + 1] !== undefined) opts[a.slice(2).replace('-f', 'F')] = argv[++i];
    else throw new Error('usage: skill-finder-sweep.mjs [--mode name | --mode-file path | --smoke] [--cap usd] [--json file] [--frozen file] [--frozen-in file]');
  }
  return opts;
}

/** The mode a run uses: --mode, else the --mode-file text (a missing file gives the default), else the default. */
export function chooseMode(opts) {
  if (opts.mode) return parseSweepMode(opts.mode);
  if (opts.modeFile) return parseSweepMode(existsSync(opts.modeFile) ? readFileSync(opts.modeFile, 'utf8') : '');
  return DEFAULT_MODE;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mode = chooseMode(opts);
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const cap = opts.cap === undefined ? undefined : Number(opts.cap);
  if (cap !== undefined && !(cap > 0)) throw new Error('--cap must be a positive number');
  console.log(`mode: ${mode}`);
  // Round 2 reads the frozen round 1 sets (from the repo unless --frozen-in names another file); --frozen is where round 1 writes them.
  const frozenIn = mode === 'round2' || mode === 'smoke-round2'
    ? loadFrozen(readFileSync(resolve(opts.frozenIn ?? fileURLToPath(new URL('../eval/round1-frozen.json', import.meta.url))), 'utf8')) : null;
  const { summary, result, frozen } = await runSweep({ query, fetch: globalThis.fetch, token: process.env.GITHUB_TOKEN, mode, frozen: frozenIn, ...(cap ? { cap } : {}) });
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  // A run that measured nothing must not look green.
  if (result.armAnswered === 0) { process.stderr.write('skill-finder-sweep: no arm call was answered\n'); process.exitCode = 1; }
  else if (!result.smoke && result.prompts.negKept < MIN_NEGATIVES) { process.stderr.write(`skill-finder-sweep: only ${result.prompts.negKept} negatives kept, need ${MIN_NEGATIVES}\n`); process.exitCode = 1; }
  writeFileSync(resolve(opts.json ?? 'sweep-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  // The frozen prompt sets (round 1), written after the run's temp folder is gone. Prompts and gold ids only.
  if (frozen) writeFresh(resolve(opts.frozen ?? 'round1-frozen.json'), `${JSON.stringify(frozen, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    // Only the error code is printed, never a message: a message could quote text from a skill or a prompt.
    process.stderr.write(`skill-finder-sweep: failed (${err?.code ?? err?.name ?? 'error'})\n`);
    process.exitCode = 1;
  });
}
