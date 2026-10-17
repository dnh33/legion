#!/usr/bin/env node
/**
 * Catalog-size sweep for the short skill list. It runs on a GitHub runner, never on the owner's PC.
 *
 * It takes the most installed public skills (skills.sh leaderboard), keeps only each skill's name and description, writes them into
 * a temp HOME as personal skills, and asks real Claude Code (Haiku, one turn, only the Skill tool) which skill it would call. Arm A
 * has the full listing, arm S has the short list with the settings Legion passes. A hook records and denies every Skill call, so no
 * skill text loads. The logs are public: only counts and metrics are printed, never env, tokens, prompts or skill text.
 *
 * Three modes (a .sweep-mode file on the branch picks one; the default is accuracy-11f):
 *   smoke         5 skills, one short-list arm with the search tool, under $0.10. It proves the multi-turn path.
 *   full-11e      the catalog-size sweep above (arms A and S, one turn, Skill tool only).
 *   accuracy-11f  the short list as Legion ships it: with the search tool (armory_find, Legion's own server and ranking),
 *                 up to 4 turns, a hint and a longer description cut tested against the full list plus search.
 *
 * usage: skill-finder-sweep.mjs [--mode name] [--mode-file path] [--smoke] [--cap usd] [--json file]
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inputTokens, mcnemar, round, runSkillCall, sample, wilson } from './lib/finder-shared.mjs';

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
/** The one-line hint of the SFH arms, word for word. */
export const HINT = 'Your skill list shows short descriptions. If no listed skill clearly fits, call armory_find with what you want to do before answering.';

// ---------- modes and arms ----------

export const MODES = ['smoke', 'full-11e', 'accuracy-11f'];
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
/** The smoke run uses the arm with the most parts: short list, hint and search. */
export const ARMS_SMOKE = [ARMS_11F[2]];

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
export async function makePrompts({ query, spend, skills, perSkill = 2, negWanted = NEGATIVES_WANTED, cwd, log = () => {} }) {
  const stats = { written: 0, kept: 0, negWritten: 0, negKept: 0, badBatches: 0, stoppedForBudget: false };
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
  log(`prompts: ${stats.written} positives written, ${stats.kept} kept; ${stats.negWritten} negatives written, ${stats.negKept} kept; ${stats.badBatches} unparsed batches`);
  return { positives, negatives: negatives.slice(0, negWanted), stats };
}

// ---------- the arms ----------

/** Does a Skill call name the gold skill? Plugin prefixes and a leading slash are ignored. */
export const isGold = (called, gold) => called !== null && safeName(String(called).replace(/^\//, '').split(':').pop()) === safeName(gold);

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
      if (!spend.fits(arms.length * avg * 1.5 * concurrency)) { stopped = true; return; }
      const home = homes.get(it.size);
      const turn = idx % arms.length;
      for (const arm of [...arms.slice(turn), ...arms.slice(0, turn)]) {
        const searched = [];
        const useSearch = arm.search ? search : null;
        const find = useSearch?.forSize(it.size);
        const server = useSearch?.buildServer(async (q, limit) => {
          const hits = await find(q, limit);
          searched.push(hits.slice(0, 5).map((h) => h.id));
          return hits;
        });
        const rec = await runSkillCall(query, {
          model, prompt: it.prompt, cwd: workDir, append: arm.append,
          settings: arm.settings,
          ...(server ? { maxTurns: MAX_TURNS, mcpServers: { legion_armory: server }, allowedTools: [FIND_TOOL] } : {}),
          env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') },
        });
        spend.add(rec.cost);
        if (rec.cost > 0) costs.push(rec.cost);
        records.push({
          size: it.size, i: it.i, kind: it.kind, arm: arm.name, called: rec.called !== null, hit: it.kind === 'pos' && isGold(rec.called, it.gold),
          tokens: inputTokens(rec.tokens), cost: rec.cost, error: rec.error ?? null,
          searches: searched.length, goldInTop5: it.kind === 'pos' && searched.some((ids) => ids.some((id) => isGold(id, it.gold))),
        });
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
export function compareArms(records, size, baseName, armName) {
  const mine = records.filter((r) => r.size === size);
  const key = (r) => `${r.kind}${r.i}`;
  const of = (arm) => new Map(mine.filter((r) => r.arm === arm).map((r) => [key(r), r]));
  const B = of(baseName);
  const X = of(armName);
  const both = [...B.keys()].filter((k) => X.has(k));
  const pos = both.filter((k) => k.startsWith('pos'));
  const neg = both.filter((k) => k.startsWith('neg'));
  const table = { both: 0, aOnly: 0, sOnly: 0, neither: 0 };
  for (const k of pos) {
    const a = B.get(k).hit;
    const x = X.get(k).hit;
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
  const misses = pos.filter((k) => !X.get(k).hit).map((k) => X.get(k));
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
 * `subsets` is [{ size, items }]. Returns { forSize(size) -> find function, buildServer(find) -> server config }.
 */
export function makeSearch(mods, subsets) {
  const finders = new Map();
  const forSize = (size) => {
    if (!finders.has(size)) {
      const items = subsets.find((s) => s.size === size)?.items ?? [];
      const docs = items.map((s) => ({ id: s.name, name: s.name, description: s.description, whenToUse: '', headings: '', source: 'yours', thirdParty: false }));
      const ix = mods.buildIndex(docs);
      const byId = new Map(docs.map((d) => [d.id, d]));
      finders.set(size, (query, limit) => [...mods.scoreIndex(ix, query)]
        .map(([id, h]) => ({ id, score: h.score }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit)
        .map((h) => ({ ...h, thirdParty: false, description: mods.oneLine(byId.get(h.id).description).slice(0, FIND_DESCRIPTION_CHARS).trimEnd() })));
    }
    return finders.get(size);
  };
  return { forSize, buildServer: (find) => mods.buildFindServer(undefined, find) };
}

// ---------- the 11f rule and report ----------

export function ruleText11f() {
  const r = ACCURACY_RULE;
  return [
    'Pre-registered rule (written before any result):',
    `Each short arm (${ARMS_11F.slice(1).map((a) => a.name).join(', ')}) is compared with ${BASELINE_11F} (the full listing plus the search tool) at each size, on the same prompts.`,
    'An arm passes at a size when all four hold:',
    `1. its gold rate minus the gold rate of ${BASELINE_11F} is at least ${r.minGoldDiff}; a gold hit is the first Skill call naming the gold skill, and search calls before it do not matter;`,
    `2. McNemar on the paired positives shows no significant loss (two-sided exact test, alpha ${r.mcnemarAlpha});`,
    `3. false Skill calls on the paired negatives: McNemar shows no significant increase (alpha ${r.mcnemarAlpha}), AND the arm makes at most ${r.maxExtraFalseCalls} more false calls than ${BASELINE_11F} (of ${r.negativesPerSize} negatives per size). This replaces the 11e test of plus 1 point, which was finer than one call in ${r.negativesPerSize};`,
    `4. at least ${r.minTokenSaving * 100} percent fewer input tokens per prompt, counted over all turns (search adds turns).`,
    "An arm 'passes from N' when it passes at N and at every larger tested size. The best arm has the lowest N; a tie goes to the arm that saves the most tokens.",
  ].join('\n');
}

const SIZE_NOTE = (r) => `${r.pairs} pos / ${r.negatives} neg`;

export function renderSummary11f({ rows, decision, catalog, prompts, spend, cap, stopped, smoke, armStats }) {
  const out = [];
  out.push('# Skill finder: short list accuracy with the search tool', '');
  if (smoke) out.push('**Smoke run.** It proves the multi-turn path end to end. These numbers are not a result.', '');
  out.push('```', ruleText11f(), '```', '');
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
    out.push('', '## Search use and misses (counts)', '', '| arm | size | search-call rate | AF search-call rate | misses | misses with a search | misses where armory_find had the gold skill in its top 5 |', '|---|---|---|---|---|---|---|');
    for (const arm of Object.keys(rows)) for (const r of rows[arm]) out.push(`| ${arm} | ${r.size} | ${pct(r.searchRate)} | ${pct(r.searchRateBase)} | ${r.misses} | ${r.missesSearched} | ${r.missesGoldInTop5} |`);
    out.push('', '## Decision');
    for (const a of decision.arms) out.push(`- ${a.arm}: ${a.n === null ? 'passes from none of the tested sizes' : `passes from N = ${a.n} (mean saving from there ${pct(a.saving)})`}`);
    out.push(decision.best ? `Best arm: ${decision.best}.` : 'No arm passes at any tested size from which it keeps passing.');
  }
  out.push('', '## Limits', "- The positives are written by a model from each skill's description, then graded; the judge saw only the closest skills by word overlap, not all of them.", "- The skills are all personal skills in a temp HOME; the model also sees Claude Code's own built-in skills in every arm.", "- Search hits carry descriptions (every skill counts as the owner's own) and use Legion's keyword ranker over the size's skills only.", '- Input tokens are the sum over all turns of fresh, cache-read and cache-write tokens.');
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

// ---------- the whole run ----------

/** One planned set of items: the interleaved order (position 0 of every size, then 1 ...; positives and negatives alternate in a size). */
function planItems(subsets, prompts, posCap, negCap, base) {
  const posOrder = sample(prompts.positives, prompts.positives.length, SEED);
  const negOrder = sample(prompts.negatives, prompts.negatives.length, SEED + 1);
  const homes = new Map();
  const perSize = subsets.map((sub) => {
    homes.set(sub.size, writeHome(join(base, `home-${sub.size}`), sub.items));
    const names = new Set(sub.items.map((s) => s.name));
    return {
      size: sub.size,
      pos: posOrder.filter((p) => names.has(p.gold)).slice(0, posCap).map((p, i) => ({ size: sub.size, i, kind: 'pos', prompt: p.prompt, gold: p.gold })),
      neg: negOrder.slice(0, negCap).map((prompt, i) => ({ size: sub.size, i, kind: 'neg', prompt, gold: null })),
    };
  });
  const seqs = perSize.map((sz) => {
    const seq = [];
    for (let k = 0; k < Math.max(sz.pos.length, sz.neg.length); k++) { if (sz.pos[k]) seq.push(sz.pos[k]); if (sz.neg[k]) seq.push(sz.neg[k]); }
    return seq;
  });
  const items = [];
  for (let j = 0; j < Math.max(0, ...seqs.map((q) => q.length)); j++) for (const q of seqs) if (q[j]) items.push(q[j]);
  return { items, homes };
}

/** mode: 'smoke' | 'full-11e' | 'accuracy-11f'. The old `smoke: true` still means the smoke mode. */
export async function runSweep({ query, fetch: fetchFn, token, smoke = false, mode = smoke ? 'smoke' : 'full-11e', cap, root, log = console.log, sleep, armory }) {
  if (!MODES.includes(mode)) throw Object.assign(new Error('mode'), { code: 'BAD_MODE' });
  const isSmoke = mode === 'smoke';
  const is11f = mode === 'accuracy-11f';
  const totalCap = cap ?? (isSmoke ? 0.1 : is11f ? ACCURACY_CAP_USD : CAP_USD);
  const base = mkdtempSync(join(root ?? tmpdir(), 'finder-sweep-'));
  try {
    const spend = makeSpend(totalCap);
    const prep = makeSpend(totalCap * (isSmoke ? 0.7 : PREP_SHARE), spend);
    const target = isSmoke ? 5 : CATALOG_TARGET;
    const catalog = await buildCatalog({ fetch: fetchFn, token, target, sleep, log });
    log(`catalog: ${catalog.skills.length} skills from ${catalog.source}`);
    if (catalog.skills.length < Math.min(target, 5)) throw Object.assign(new Error('catalog too small'), { code: 'CATALOG' });
    // The subsets nest over the whole 400, as in 11e, so a size holds the same skills as in that run.
    const sizes = isSmoke ? [Math.min(5, catalog.skills.length)] : (is11f ? ACCURACY_SIZES : SIZES).filter((s) => s <= catalog.skills.length);
    // A catalog a little short of 400 still gets its own top size, so the largest size is never silently dropped.
    if (mode === 'full-11e' && catalog.skills.length > sizes[sizes.length - 1]) sizes.push(catalog.skills.length);
    // A catalog smaller than the smallest size cannot be measured; say so instead of running on nothing.
    if (sizes.length === 0) throw Object.assign(new Error('catalog too small'), { code: 'CATALOG' });
    const subsets = nestedSubsets(catalog.skills, sizes);
    const work = join(base, 'work');
    mkdirSync(work, { recursive: true });
    // Prompts are needed only for the skills of the largest size, since every smaller size sits inside it.
    const promptSkills = is11f ? subsets[subsets.length - 1].items : catalog.skills;
    const prompts = await makePrompts({ query, spend: prep, skills: promptSkills, perSkill: 2, negWanted: isSmoke ? 2 : NEGATIVES_WANTED, cwd: work, log });
    const posCap = isSmoke ? 2 : is11f ? ACCURACY_POSITIVES : POSITIVES_PER_SIZE;
    const negCap = isSmoke ? 2 : is11f ? ACCURACY_NEGATIVES : NEGATIVES_PER_SIZE;
    const { items, homes } = planItems(subsets, prompts, posCap, negCap, base);
    log(`arms: ${items.length} items over sizes ${sizes.join(', ')}`);

    const arms = mode === 'full-11e' ? ARMS_11E : isSmoke ? ARMS_SMOKE : ARMS_11F;
    const search = arms.some((a) => a.search) ? makeSearch(armory ?? await loadArmory(), subsets) : null;
    const { records, stopped } = await runArms({ query, spend, items, homes, arms, search, concurrency: is11f ? ACCURACY_CONCURRENCY : PROBE_CONCURRENCY, workDir: work, log });
    const common = {
      seed: SEED, mode, cap: totalCap, spentUsd: round(spend.spent), calls: spend.calls, stoppedAtCap: stopped,
      armCalls: records.length, armAnswered: records.filter((r) => r.error === null).length,
      catalog: { source: catalog.source, ...catalog.counts }, prompts: prompts.stats,
    };
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
    const summary = renderSummary11f({ rows, decision, catalog, prompts, spend, cap: totalCap, stopped, smoke: isSmoke, armStats: stats });
    return { summary, result: { ...common, smoke: isSmoke, rule: ACCURACY_RULE, sizes, arms: stats, rows, decision } };
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
    else if ((a === '--cap' || a === '--json' || a === '--mode' || a === '--mode-file') && argv[i + 1] !== undefined) opts[a.slice(2).replace('-f', 'F')] = argv[++i];
    else throw new Error('usage: skill-finder-sweep.mjs [--mode name | --mode-file path | --smoke] [--cap usd] [--json file]');
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
  const { summary, result } = await runSweep({ query, fetch: globalThis.fetch, token: process.env.GITHUB_TOKEN, mode, ...(cap ? { cap } : {}) });
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  // A run that measured nothing must not look green.
  if (result.armAnswered === 0) { process.stderr.write('skill-finder-sweep: no arm call was answered\n'); process.exitCode = 1; }
  else if (!result.smoke && result.prompts.negKept < MIN_NEGATIVES) { process.stderr.write(`skill-finder-sweep: only ${result.prompts.negKept} negatives kept, need ${MIN_NEGATIVES}\n`); process.exitCode = 1; }
  writeFileSync(resolve(opts.json ?? 'sweep-result.json'), `${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    // Only the error code is printed, never a message: a message could quote text from a skill or a prompt.
    process.stderr.write(`skill-finder-sweep: failed (${err?.code ?? err?.name ?? 'error'})\n`);
    process.exitCode = 1;
  });
}
