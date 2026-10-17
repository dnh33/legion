#!/usr/bin/env node
/**
 * Skill finder eval. Two commands:
 *   build  reads Claude Code transcripts and writes the gold set (setA.jsonl, negatives.jsonl) into a private folder.
 *   score  runs the compiled finder over a set and prints recall, MRR, false notes and latency.
 * Prompts never reach stdout or stderr. Only counts, skill ids and timings are printed.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARMORY_DIST = join(REPO, 'dist', 'src', 'core', 'armory');
const NEGATIVE_CAP = 300;
const NEGATIVE_MIN_WORDS = 3;
const SAMPLE_SEED = 20261017;
const SUBSETS = ['named', 'implicit', 'subagent'];
const VALUE_FLAGS = new Set(['k', 'threshold', 'json', 'set', 'negatives', 'catalog', 'out', 'transcripts']);
const HARNESS_PREFIXES = [
  '<command-name>', '<command-message>', '<local-command', '<task-notification>', '<system-reminder>', 'Caveat: The messages below',
];
const USAGE = 'usage: skill-finder-eval.mjs build --transcripts <dir> --out <folder> | '
  + 'score --set <file> [--negatives <file>] --catalog <skills.json|legion> [--threshold strict|balanced|eager] [--k 1-5] [--json <file>]';

/** A problem with the inputs. Its message is fixed text that never holds a prompt. Exit code 1. */
class UsageError extends Error {}
/** A malformed command line (a flag with no value, an unknown flag or command). Exit code 2. */
class FlagError extends UsageError {}

// ---------- the private folder guard ----------

const DEFAULT_ROOT = join(REPO, 'claude', 'skill-finder-private');

/** The folder the build may write into. Tests point it elsewhere with SKILL_FINDER_PRIVATE_ROOT, but only inside the OS temp folder. */
function allowedRoot() {
  const env = process.env.SKILL_FINDER_PRIVATE_ROOT;
  if (env && isInside(realish(tmpdir()), realish(resolve(env)), true)) return resolve(env);
  return DEFAULT_ROOT;
}

/** Resolves symlinks in the part of the path that exists, so a link out of the folder is caught. */
function realish(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync.native(cur), ...tail);
}

const caseKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** True when target is root or below it (strict: below it only). Both must already be real paths. */
function isInside(root, target, strict = false) {
  const rel = relative(caseKey(root), caseKey(target));
  if (rel === '') return !strict;
  return !(isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`));
}

const samePath = (a, b) => caseKey(a) === caseKey(b);

/** Returns the resolved out folder if it is the private root or inside it. Refuses anything else, before any read. */
function guardOut(out) {
  const target = realish(resolve(out));
  if (!isInside(realish(allowedRoot()), target)) throw new UsageError(`refused: --out must be inside ${allowedRoot()}`);
  return target;
}

/** Writes a fresh file: an existing file or planted link at the path is removed first, and 'wx' refuses to follow anything that appears. */
function writeFresh(path, data) {
  try {
    unlinkSync(path);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  writeFileSync(path, data, { flag: 'wx' });
}

// ---------- transcript reading ----------

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile() && name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** A line that is not a JSON object gives null. The parser's own message can quote the line, so it is never read. */
function parseLine(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** The text of a user line, or null when it is not a prompt: a tool_result, empty after stripping reminders, or harness text. */
function userText(obj) {
  const content = obj.message?.content;
  let text;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((b) => b?.type === 'tool_result')) return null;
    text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  } else {
    return null;
  }
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (cleaned === '') return null;
  if (HARNESS_PREFIXES.some((p) => cleaned.startsWith(p))) return null;
  return cleaned;
}

/** The text of a real prompt, or null when the user line is not one (see notes: task 2, "Which user lines are real prompts"). */
function promptText(obj) {
  if (obj.type !== 'user' || obj.isSidechain === true) return null;
  if (obj.promptSource === 'system' || obj.turnOrigin === 'task_notification' || obj.turnOrigin === 'peer') return null;
  return userText(obj);
}

/** The text of a subagent's user line. The marker rules do not apply to sidechain lines; the tool_result and harness-text rules do. */
function sidechainText(obj) {
  if (obj.type !== 'user' || obj.isSidechain !== true) return null;
  return userText(obj);
}

/**
 * The skill ids of the Skill tool calls on one assistant line. Main-session calls and sidechain (subagent) calls are both kept.
 * A subagent transcript is its own file under `<session>/subagents/`, so a sidechain call pairs with the first sidechain user
 * text in the same file (subset `subagent`), not with the owner's prompt.
 */
function skillCalls(obj) {
  if (obj.type !== 'assistant') return [];
  const content = obj.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b?.type === 'tool_use' && b.name === 'Skill' && typeof b.input?.skill === 'string')
    .map((b) => b.input.skill);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shortName = (id) => id.slice(id.lastIndexOf(':') + 1);

/** The skill's short name as a whole word. Hyphens belong to the name, so a plain \b is wrong here. */
function namedIn(prompt, id) {
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(shortName(id))}(?![\\p{L}\\p{N}_-])`, 'iu').test(prompt);
}

/** The user typed the skill as a slash command (full id or short name). Such a pair is not a model choice, so it is dropped. */
function typedDrop(prompt, id) {
  return new RegExp(`^/(${escapeRe(id)}|${escapeRe(shortName(id))})(?=\\s|$)`, 'iu').test(prompt);
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded Fisher-Yates shuffle, then the first n. The same input and seed always give the same list. */
function sample(list, n, seed) {
  const arr = list.slice();
  const rnd = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

// ---------- build ----------

function build(opts) {
  if (typeof opts.out !== 'string') throw new UsageError('build needs --out <folder inside the private folder>');
  const out = guardOut(opts.out);
  const transcripts = typeof opts.transcripts === 'string' ? opts.transcripts : join(homedir(), '.claude', 'projects');
  if (!existsSync(transcripts)) throw new UsageError('transcripts folder not found');

  const files = walk(transcripts);
  const stats = { files: files.length, lines: 0, prompts: 0, skillCalls: 0, typedDrops: 0, unpairedSubagent: 0 };
  const pairs = new Map();
  const negatives = new Set();
  const positivePrompts = new Set();

  for (const file of files) {
    let current = null; // the last real prompt: { text, called }
    let sideFirst = null; // the first sidechain user text in this file (one file = one subagent conversation)
    const close = () => {
      if (current && !current.called) negatives.add(current.text);
    };
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (raw.trim() === '') continue;
      stats.lines++;
      const obj = parseLine(raw);
      if (!obj) continue;
      const text = promptText(obj);
      if (text !== null) {
        close();
        current = { text, called: false };
        stats.prompts++;
        continue;
      }
      if (sideFirst === null) sideFirst = sidechainText(obj);
      for (const skill of skillCalls(obj)) {
        stats.skillCalls++;
        if (obj.isSidechain === true) {
          if (sideFirst === null) {
            stats.unpairedSubagent++;
            continue;
          }
          const sideKey = JSON.stringify([sideFirst, skill]);
          if (!pairs.has(sideKey)) pairs.set(sideKey, { prompt: sideFirst, skill, subset: 'subagent' });
          positivePrompts.add(sideFirst);
          continue;
        }
        if (!current) continue;
        current.called = true;
        if (typedDrop(current.text, skill)) {
          stats.typedDrops++;
          continue;
        }
        const key = JSON.stringify([current.text, skill]);
        if (!pairs.has(key)) {
          pairs.set(key, { prompt: current.text, skill, subset: namedIn(current.text, skill) ? 'named' : 'implicit' });
        }
        positivePrompts.add(current.text);
      }
    }
    close();
  }

  const setA = [...pairs.values()];
  const candidates = [...negatives]
    .filter((t) => !positivePrompts.has(t) && t.split(/\s+/).length >= NEGATIVE_MIN_WORDS)
    .sort();
  const negativeSet = sample(candidates, NEGATIVE_CAP, SAMPLE_SEED).sort();
  const count = (subset) => setA.filter((r) => r.subset === subset).length;

  mkdirSync(out, { recursive: true });
  writeFresh(join(out, 'setA.jsonl'), setA.map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFresh(join(out, 'negatives.jsonl'), negativeSet.map((prompt) => `${JSON.stringify({ prompt })}\n`).join(''));

  console.log(`build: ${stats.files} transcript files, ${stats.lines} lines`);
  console.log(`real prompts: ${stats.prompts}; Skill calls: ${stats.skillCalls}; typed drops: ${stats.typedDrops}; subagent calls with no prompt: ${stats.unpairedSubagent}`);
  console.log(`set A: ${setA.length} cases (${count('named')} named, ${count('implicit')} implicit, ${count('subagent')} subagent)`);
  console.log(`negatives: ${negativeSet.length} written (${candidates.length} candidates, cap ${NEGATIVE_CAP}, at least ${NEGATIVE_MIN_WORDS} words)`);
  console.log(`written to ${out}`);
}

// ---------- score ----------

const round = (x) => Math.round(x * 10000) / 10000;
const mean = (xs) => (xs.length === 0 ? null : round(xs.reduce((s, x) => s + x, 0) / xs.length));

/** The pool: every skill the finder could ever suggest. State is not part of the rule (a skill can be switched on later). */
const inPool = (e) => !e.offReason && !e.unsafeReason;

function readJsonl(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new UsageError(`${label} file cannot be read`);
  }
  const rows = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      throw new UsageError(`${label} line ${i + 1} is not valid JSON`);
    }
    if (!v || typeof v.prompt !== 'string') throw new UsageError(`${label} line ${i + 1} has no prompt`);
    rows.push(v);
  });
  return rows;
}

const countBy = (xs, key) => {
  const out = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

/**
 * Loads the pool for a catalog. `legion` reads the owner's catalog (read only); anything else is a skills.json file.
 * Returns the finder docs of the whole pool plus the pool size, how many are on, and the source breakdown.
 */
async function loadCatalog(spec, dist) {
  let entries;
  let source;
  let toDoc;
  if (spec === 'legion') {
    const { buildCatalog } = await dist('catalog.js');
    const { docFromEntry } = await dist('finder/doc.js');
    const { armoryFilePath } = await dist('store.js');
    const dataDir = process.env.LEGION_HOME || join(homedir(), '.legion');
    // buildCatalog writes a fresh armory.json when none exists. The eval must never write, so with no file it gets an empty one in memory.
    const file = existsSync(armoryFilePath(dataDir)) ? undefined : { version: 1, migrations: [], skills: {}, ccNoticeSeen: true };
    entries = buildCatalog({ dataDir, inheritClaudeCode: true, file });
    source = 'legion';
    toDoc = (e) => docFromEntry(e);
  } else {
    let raw;
    try {
      raw = JSON.parse(readFileSync(spec, 'utf8'));
    } catch {
      throw new UsageError('catalog file is missing or not valid JSON');
    }
    if (!Array.isArray(raw)) throw new UsageError('catalog file must hold a JSON array of skills');
    const { THIRD_PARTY } = await dist('catalog.js');
    entries = raw.map((e, i) => {
      if (!e || typeof e.id !== 'string') throw new UsageError(`catalog entry ${i + 1} has no id`);
      return e;
    });
    source = basename(spec);
    toDoc = (e) => {
      const src = e.source ?? 'yours';
      return {
        id: e.id,
        name: e.name ?? shortName(e.id),
        description: e.description ?? '',
        whenToUse: e.when_to_use ?? '',
        headings: e.headings ?? '',
        source: src,
        thirdParty: THIRD_PARTY.has(src),
      };
    };
  }
  const pool = entries.filter(inPool);
  return {
    source,
    docs: pool.map(toDoc),
    pool: { size: pool.length, on: pool.filter((e) => (e.state ?? 'on') === 'on').length, bySource: countBy(pool, (e) => e.source ?? 'yours') },
  };
}

function metrics(rows, k) {
  const n = rows.length;
  const frac = (f) => (n === 0 ? null : round(rows.filter(f).length / n));
  return {
    cases: n,
    recall1: frac((r) => r.pos === 0),
    recall3: frac((r) => r.pos >= 0 && r.pos < 3),
    recall5: frac((r) => r.pos >= 0),
    mrr5: mean(rows.map((r) => (r.pos >= 0 ? 1 / (r.pos + 1) : 0))),
    recallAtK: frac((r) => r.pos >= 0 && r.pos < k),
  };
}

/** Metrics for a set of rows, plus one block per subset. */
function withSubsets(rows, k) {
  const out = metrics(rows, k);
  for (const s of SUBSETS) out[s] = metrics(rows.filter((r) => r.subset === s), k);
  return out;
}

/** Refuses a --json target that would overwrite an input or land in the private folder. Runs before any scoring. */
function guardJson(opts) {
  const target = realish(resolve(opts.json));
  const inputs = [opts.set, opts.negatives].filter((p) => typeof p === 'string').map((p) => realish(resolve(p)));
  if (inputs.some((p) => samePath(p, target)) || isInside(realish(allowedRoot()), target)) {
    throw new UsageError('refused: --json must not be the set file, the negatives file or a path inside the private folder');
  }
  return target;
}

async function score(opts) {
  const dist = (rel) => import(pathToFileURL(join(ARMORY_DIST, rel)).href);
  if (!existsSync(join(ARMORY_DIST, 'finder', 'rank.js'))) throw new UsageError('dist is missing: run npm run build:ts first');
  if (typeof opts.set !== 'string') throw new UsageError('score needs --set <file>');
  if (typeof opts.catalog !== 'string') throw new UsageError('score needs --catalog <skills.json|legion>');
  const jsonTarget = typeof opts.json === 'string' ? guardJson(opts) : null;
  const thresholdName = typeof opts.threshold === 'string' ? opts.threshold : 'balanced';
  const { THRESHOLDS, DEFAULT_K, DEADLINE_MS } = await dist('finder/defaults.js');
  if (!Object.hasOwn(THRESHOLDS, thresholdName)) throw new UsageError('--threshold must be strict, balanced or eager');
  const k = opts.k === undefined ? DEFAULT_K : Number(opts.k);
  if (!Number.isInteger(k) || k < 1 || k > 5) throw new UsageError('--k must be a whole number from 1 to 5');
  const minScore = THRESHOLDS[thresholdName];

  const { rank } = await dist('finder/rank.js');
  const { buildIndex } = await dist('finder/bm25.js');
  const { resolveName } = await dist('catalog.js');
  const catalog = await loadCatalog(opts.catalog, dist);
  const ix = buildIndex(catalog.docs);

  const cases = readJsonl(opts.set, 'set');
  for (const c of cases) if (typeof c.skill !== 'string') throw new UsageError('set row has no skill');
  const negatives = typeof opts.negatives === 'string' ? readJsonl(opts.negatives, 'negatives') : null;

  const latencies = [];
  const timed = (prompt) => {
    const t0 = performance.now();
    const res = rank(ix, prompt, { k: 5, minScore, deadlineMs: DEADLINE_MS });
    latencies.push(performance.now() - t0);
    return res;
  };

  // A gold id resolves against the pool: a bare name maps to `plugin:name`. If several match, a hit on any of them counts.
  let timeouts = 0;
  const rows = cases.map((c) => {
    const { results, timedOut } = timed(c.prompt);
    if (timedOut) timeouts++;
    const ids = new Set(resolveName(catalog.docs, c.skill).hits.map((h) => h.id));
    return { skill: c.skill, subset: c.subset ?? 'all', resolved: ids.size > 0, pos: results.findIndex((r) => ids.has(r.id)) };
  });
  const covered = rows.filter((r) => r.resolved);
  const unresolved = [...new Set(rows.filter((r) => !r.resolved).map((r) => r.skill))].sort();

  const setCovered = { ...withSubsets(covered, k), timeouts };
  const setAll = withSubsets(rows, k);
  const perSkill = [...new Set(rows.map((r) => r.skill))].sort().map((skill) => {
    const mine = rows.filter((r) => r.skill === skill);
    return { skill, resolved: mine[0].resolved, cases: mine.length, recallAtK: metrics(mine, k).recallAtK };
  });

  let negReport = null;
  if (negatives) {
    let falseNotes = 0;
    let negTimeouts = 0;
    for (const n of negatives) {
      const { results, timedOut } = timed(n.prompt);
      if (timedOut) negTimeouts++;
      if (results.length > 0) falseNotes++;
    }
    negReport = {
      count: negatives.length,
      falseNotes,
      falseNoteRate: negatives.length === 0 ? null : round(falseNotes / negatives.length),
      timeouts: negTimeouts,
    };
  }

  const sorted = latencies.slice().sort((a, b) => a - b);
  const p95 = sorted.length === 0 ? null : round(sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]);
  const report = {
    catalog: { source: catalog.source, skills: catalog.docs.length, on: catalog.pool.on, bySource: catalog.pool.bySource },
    threshold: thresholdName,
    minScore,
    k,
    set: setCovered,
    setAll,
    unresolved,
    negatives: negReport,
    latency: { samples: sorted.length, p95Ms: p95 },
    perSkill,
  };

  const f = (x) => (x === null ? 'n/a' : x.toFixed(3));
  const line = (m) => `recall@1 ${f(m.recall1)}  recall@3 ${f(m.recall3)}  recall@5 ${f(m.recall5)}  MRR@5 ${f(m.mrr5)}`;
  const sources = Object.entries(catalog.pool.bySource).map(([s, n]) => `${s} ${n}`).join(', ');
  console.log(`score: catalog ${catalog.source}, pool ${catalog.docs.length} skills (${catalog.pool.on} on), threshold ${thresholdName} (floor ${minScore}), k ${k}`);
  console.log(`pool sources: ${sources === '' ? 'none' : sources}`);
  console.log(`set: ${rows.length} cases (all), ${covered.length} covered, ${unresolved.length} unresolved gold ids, ${timeouts} timeouts`);
  console.log(`  covered: ${line(setCovered)}`);
  console.log(`  all:     ${line(setAll)}`);
  for (const s of SUBSETS) {
    console.log(`  ${s}: covered ${setCovered[s].cases} of ${setAll[s].cases}; recall@5 covered ${f(setCovered[s].recall5)}, all ${f(setAll[s].recall5)}`);
  }
  if (unresolved.length > 0) console.log(`unresolved gold ids: ${unresolved.join(', ')}`);
  if (negReport) {
    console.log(`negatives: ${negReport.count}, false notes ${negReport.falseNotes} (rate ${f(negReport.falseNoteRate)}), ${negReport.timeouts} timeouts`);
  } else {
    console.log('negatives: none given (false-note rate not measured)');
  }
  console.log(`latency: p95 ${p95 === null ? 'n/a' : `${p95} ms`} over ${sorted.length} queries`);
  console.log(`per skill (recall@${k}):`);
  for (const s of perSkill) console.log(`  ${s.skill}  ${s.cases}  ${f(s.recallAtK)}${s.resolved ? '' : '  (unresolved)'}`);

  if (jsonTarget) {
    mkdirSync(dirname(jsonTarget), { recursive: true });
    writeFresh(jsonTarget, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`json written to ${jsonTarget}`);
  }
}

// ---------- command line ----------

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new FlagError(USAGE);
    const key = a.slice(2);
    if (!VALUE_FLAGS.has(key)) throw new FlagError(`unknown flag --${key}\n${USAGE}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) throw new FlagError(`flag --${key} needs a value\n${USAGE}`);
    opts[key] = next;
    i++;
  }
  return { cmd, opts };
}

try {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (cmd === 'build') build(opts);
  else if (cmd === 'score') await score(opts);
  else throw new FlagError(USAGE);
} catch (err) {
  // Only our own fixed messages are printed. Anything else prints its error code, never its message.
  const msg = err instanceof UsageError ? err.message : `failed (${err?.code ?? 'error'})`;
  process.stderr.write(`skill-finder-eval: ${msg}\n`);
  process.exitCode = err instanceof FlagError ? 2 : 1;
}
