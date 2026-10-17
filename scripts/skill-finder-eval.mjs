#!/usr/bin/env node
/**
 * Skill finder eval. Two commands:
 *   build  reads Claude Code transcripts and writes the gold set (setA.jsonl, negatives.jsonl) into a private folder.
 *   score  runs the compiled finder over a set and prints recall, MRR, false notes and latency.
 * Prompts never reach stdout or stderr. Only counts, skill ids and timings are printed.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
const VALUE_FLAGS = new Set([
  'k', 'threshold', 'json', 'set', 'negatives', 'catalog', 'out', 'transcripts', 'ranker', 'pool', 'weight', 'floor', 'min-score', 'margin', 'sample',
]);
/** Flags that stand alone. */
const SWITCH_FLAGS = new Set(['sweep', 'rerank']);
const HARNESS_PREFIXES = [
  '<command-name>', '<command-message>', '<local-command', '<task-notification>', '<system-reminder>', 'Caveat: The messages below',
];
const USAGE = 'usage: skill-finder-eval.mjs build --transcripts <dir> --out <folder> | '
  + 'score --set <file[,file]> [--negatives <file>] --catalog <skills.json|legion|sdk> [--pool all|on] [--ranker keyword|local] [--threshold strict|balanced|eager]\n'
  + '  [--min-score n] [--weight 0-1] [--floor cosine] [--k 1-5] [--sweep] [--rerank --sample n [--margin m]] [--json <file>]';

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
const SUBSET_ORDER = ['named', 'implicit', 'subagent', 'longtail', 'ambiguous', 'long'];
/** The longest ranked list kept per prompt for the sweeps. The note shows at most 5, so the floors cannot reach deeper than this in practice. */
const KEEP_RANKED = 60;
/** The pre-registered bars for a default (task 11 notes, stage 2). */
const BARS = { falseNote: 0.15, precision: 0.5 };
const KEYWORD_GRID = [0.4, 0.6, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12, 15, 20];
const FUSED_GRID = Array.from({ length: 19 }, (_, i) => round(0.3 + i * 0.05));
const WEIGHT_GRID = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const FLOOR_GRID = [0, ...Array.from({ length: 21 }, (_, i) => round(0.7 + i * 0.01))];
const MARGIN_GRID = [0.05, 0.1, 0.15, 0.2, 0.3, 1];

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
 * Loads the pool for a catalog. `legion` reads the owner's catalog from the disk (read only); `sdk` asks Claude Code for its skill
 * list (no model turn, no cost) the way the Armory does, then builds the catalog with the owner's switches; anything else is a skills.json file.
 * Returns the finder docs of the whole pool, the ids that count as switched on, the pool size and the source breakdown.
 */
async function loadCatalog(spec, dist) {
  let entries;
  let source;
  let toDoc;
  if (spec === 'legion' || spec === 'sdk') {
    const { buildCatalog } = await dist('catalog.js');
    const { docFromEntry } = await dist('finder/doc.js');
    const { armoryFilePath } = await dist('store.js');
    const dataDir = process.env.LEGION_HOME || join(homedir(), '.legion');
    // buildCatalog writes a fresh armory.json when none exists. The eval must never write, so with no file it gets an empty one in memory.
    const file = existsSync(armoryFilePath(dataDir)) ? undefined : { version: 1, migrations: [], skills: {}, ccNoticeSeen: true };
    let claudeSkills;
    if (spec === 'sdk') {
      const { sdkHandshake } = await dist('handshake.js');
      const { discoverFromSdk, claudeHomeDir } = await dist('discover.js');
      const snap = await sdkHandshake({ inheritClaudeCode: true });
      if (snap.modelMessages !== 0) throw new UsageError('the skill listing started a model turn');
      claudeSkills = discoverFromSdk(claudeHomeDir(), snap);
    }
    entries = buildCatalog({ dataDir, inheritClaudeCode: true, ...(file ? { file } : {}), ...(claudeSkills ? { claudeSkills } : {}) });
    source = spec;
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
  const on = new Set(pool.filter((e) => (e.state ?? 'on') === 'on').map((e) => e.id));
  return {
    source,
    docs: pool.map(toDoc),
    on,
    pool: { size: pool.length, on: on.size, bySource: countBy(pool, (e) => e.source ?? 'yours') },
  };
}

// ---------- the numbers ----------

/** One evaluated row: where the first gold skill sits in what the note would show, and how many skills the note lists. */
function evalRow(row, list, filt, k) {
  const kept = [];
  for (const r of list) {
    if (r.score < filt.minScore) break; // lists are sorted by score, so nothing after this passes either
    if (r.cosine !== undefined && r.cosine < filt.floor) continue;
    kept.push(r);
    if (kept.length >= 5) break;
  }
  const pos = row.gold ? kept.findIndex((r) => row.gold.has(r.id)) : -1;
  return { ...row, pos, shown: Math.min(k, kept.length), ids: kept.slice(0, k).map((r) => r.id) };
}

function metrics(ev, k) {
  const n = ev.length;
  const frac = (f) => (n === 0 ? null : round(ev.filter(f).length / n));
  const noted = ev.filter((r) => r.shown > 0);
  const hits = noted.filter((r) => r.pos >= 0 && r.pos < k).length;
  return {
    cases: n,
    recall1: frac((r) => r.pos === 0),
    recall3: frac((r) => r.pos >= 0 && r.pos < 3),
    recall5: frac((r) => r.pos >= 0),
    mrr5: mean(ev.map((r) => (r.pos >= 0 ? 1 / (r.pos + 1) : 0))),
    recallAtK: frac((r) => r.pos >= 0 && r.pos < k),
    noteRate: frac((r) => r.shown > 0),
    notePrecision: noted.length === 0 ? null : round(hits / noted.length),
  };
}

/** Metrics for a set of rows, plus one block per subset the rows hold (the three Set A subsets are always there). */
function withSubsets(ev, k) {
  const out = metrics(ev, k);
  const present = new Set(ev.map((r) => r.subset));
  for (const s of SUBSET_ORDER) if (present.has(s) || SUBSETS.includes(s)) out[s] = metrics(ev.filter((r) => r.subset === s), k);
  return out;
}

/** The numbers the default is picked on: recall@3 per set (the mean of the sets), note precision over all sets together, false-note rate. */
function pointStats(sets, negPrompts, lists, filt, k) {
  const perSet = sets.map((s) => {
    const ev = s.covered.map((row) => evalRow(row, lists.get(row.prompt), filt, k));
    const noted = ev.filter((r) => r.shown > 0);
    return { name: s.name, n: ev.length, hit3: ev.filter((r) => r.pos >= 0 && r.pos < 3).length, noted: noted.length, notedHit: noted.filter((r) => r.pos >= 0 && r.pos < k).length };
  });
  const noted = perSet.reduce((a, s) => a + s.noted, 0);
  const notedHit = perSet.reduce((a, s) => a + s.notedHit, 0);
  const falseNotes = negPrompts.filter((p) => evalRow({}, lists.get(p), filt, k).shown > 0).length;
  const recalls = perSet.map((s) => (s.n === 0 ? 0 : s.hit3 / s.n));
  return {
    recall: round(recalls.reduce((a, b) => a + b, 0) / Math.max(1, recalls.length)),
    perSetRecall3: Object.fromEntries(perSet.map((s, i) => [s.name, round(recalls[i])])),
    precision: noted === 0 ? null : round(notedHit / noted),
    noteRate: round(noted / Math.max(1, perSet.reduce((a, s) => a + s.n, 0))),
    falseNoteRate: negPrompts.length === 0 ? null : round(falseNotes / negPrompts.length),
  };
}

const meetsBars = (p) => p.falseNoteRate !== null && p.precision !== null && p.falseNoteRate <= BARS.falseNote && p.precision >= BARS.precision;
/** The pre-registered order: most recall, then fewer false notes, then more precision, then the stricter floors. */
const byRule = (a, b) => b.recall - a.recall || a.falseNoteRate - b.falseNoteRate || b.precision - a.precision || b.minScore - a.minScore || b.floor - a.floor;

// ---------- rankers ----------

const p95Of = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length === 0 ? null : round(s[Math.max(0, Math.ceil(0.95 * s.length) - 1)]);
};

/** True while a process with this id is running. Only ever asked about a pid this script's own model handle reported. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Runs `fn` with the real local model: the pinned download into a TEMP data dir (the whole path a user takes, with the approval answered yes),
 * and the dir is deleted at the end. Nothing is written under ~/.legion.
 */
async function withLocalModel(dist, fn) {
  const { createFinderModel } = await dist('finder/model.js');
  const dataDir = mkdtempSync(join(tmpdir(), 'finder-eval-model-'));
  const model = createFinderModel({ dataDir }, { approve: async () => true });
  let helperPid = null;
  try {
    const got = await model.get();
    if (!got.ok) throw new UsageError(`the local model download failed: ${(got.steps.at(-1)?.detail ?? 'no detail').slice(0, 160)}`);
    const emb = model.embedder();
    if (!emb) throw new UsageError('the local model is not ready after the download');
    return await fn(emb, dataDir, (pid) => { helperPid = pid; }, model);
  } finally {
    helperPid = model.helper()?.pid() ?? helperPid;
    model.dispose();
    await new Promise((r) => setTimeout(r, 500));
    const stopped = helperPid ? !alive(helperPid) : null;
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`local model: helper pid ${helperPid ?? 'none'} stopped ${stopped}; temp data dir deleted ${!existsSync(dataDir)}`);
  }
}

/** Refuses a --json target that would overwrite an input or land in the private folder. Runs before any scoring. */
function guardJson(opts) {
  const target = realish(resolve(opts.json));
  const inputs = [...String(opts.set ?? '').split(','), opts.negatives].filter((p) => typeof p === 'string' && p !== '').map((p) => realish(resolve(p)));
  if (inputs.some((p) => samePath(p, target)) || isInside(realish(allowedRoot()), target)) {
    throw new UsageError('refused: --json must not be the set file, the negatives file or a path inside the private folder');
  }
  return target;
}

// ---------- the score command ----------

async function score(opts) {
  const dist = (rel) => import(pathToFileURL(join(ARMORY_DIST, rel)).href);
  if (!existsSync(join(ARMORY_DIST, 'finder', 'rank.js'))) throw new UsageError('dist is missing: run npm run build:ts first');
  if (typeof opts.set !== 'string') throw new UsageError('score needs --set <file>');
  if (typeof opts.catalog !== 'string') throw new UsageError('score needs --catalog <skills.json|legion|sdk>');
  const jsonTarget = typeof opts.json === 'string' ? guardJson(opts) : null;
  const rankerName = typeof opts.ranker === 'string' ? opts.ranker : 'keyword';
  if (!['keyword', 'local', 'provider'].includes(rankerName)) throw new UsageError('--ranker must be keyword, local or provider');
  if (rankerName === 'provider') throw new UsageError('--ranker provider needs a configured embedding provider and its key; the eval never reads keys');
  const poolName = typeof opts.pool === 'string' ? opts.pool : 'all';
  if (!['all', 'on'].includes(poolName)) throw new UsageError('--pool must be all or on');
  const fused = rankerName === 'local';
  const D = await dist('finder/defaults.js');
  const { THRESHOLDS, FUSED_THRESHOLDS, DEFAULT_K } = D;
  const thresholdName = typeof opts.threshold === 'string' ? opts.threshold : 'balanced';
  if (!Object.hasOwn(THRESHOLDS, thresholdName)) throw new UsageError('--threshold must be strict, balanced or eager');
  const k = opts.k === undefined ? DEFAULT_K : Number(opts.k);
  if (!Number.isInteger(k) || k < 1 || k > 5) throw new UsageError('--k must be a whole number from 1 to 5');
  const num = (name, dflt) => {
    if (opts[name] === undefined) return dflt;
    const v = Number(opts[name]);
    if (!Number.isFinite(v)) throw new UsageError(`--${name} must be a number`);
    return v;
  };
  const minScore = num('min-score', (fused ? FUSED_THRESHOLDS : THRESHOLDS)[thresholdName]);
  const weight = num('weight', D.FUSION_WEIGHT);
  const floor = num('floor', D.RAW_COSINE_FLOOR);
  const margin = num('margin', D.RERANK_MARGIN);
  const sampleN = opts.sample === undefined ? 0 : Math.floor(num('sample', 0));
  if (opts.rerank !== undefined && sampleN < 1) throw new UsageError('--rerank needs --sample <n per set>');

  const { rank, rankFused } = await dist('finder/rank.js');
  const { buildIndex } = await dist('finder/bm25.js');
  const { resolveName } = await dist('catalog.js');
  const catalog = await loadCatalog(opts.catalog, dist);
  const ix = buildIndex(catalog.docs);
  // The agent's set: the index holds every skill (so the word statistics are the catalog's), the ranking sees only the switched-on ones.
  const candDocs = poolName === 'on' ? catalog.docs.filter((d) => catalog.on.has(d.id)) : catalog.docs;
  const candIds = new Set(candDocs.map((d) => d.id));
  const sub = { ...ix, docs: ix.docs.filter((d) => candIds.has(d.id)) };
  const docById = new Map(catalog.docs.map((d) => [d.id, d]));

  const setFiles = opts.set.split(',').filter(Boolean);
  const sets = setFiles.map((file, i) => {
    const rows = readJsonl(file, 'set');
    for (const c of rows) if (typeof c.skill !== 'string') throw new UsageError('set row has no skill');
    const name = setFiles.length === 1 ? 'set' : basename(file).replace(/\.jsonl$/, '') || `set${i + 1}`;
    const all = rows.map((c) => {
      const main = resolveName(candDocs, c.skill).hits.map((h) => h.id);
      const gold = new Set(main);
      if (typeof c.alt === 'string') for (const h of resolveName(candDocs, c.alt).hits) gold.add(h.id);
      return { prompt: c.prompt, skill: c.skill, subset: c.subset ?? 'all', gold, resolved: main.length > 0 };
    });
    return { name, all, covered: all.filter((r) => r.resolved) };
  });
  const negatives = typeof opts.negatives === 'string' ? readJsonl(opts.negatives, 'negatives').map((n) => n.prompt) : [];

  // Every distinct prompt is ranked once. The full list (to KEEP_RANKED) is kept, so a floor or a threshold is applied afterwards;
  // that gives the same top results as running the ranker with the floor, which the check at the end proves on the chosen point.
  const prompts = [...new Set([...sets.flatMap((s) => s.all.map((r) => r.prompt)), ...negatives])];
  const rankTimes = [];
  const embedTimes = [];
  let timeouts = 0;
  const listsAt = (w, qvs, vecs) => {
    const lists = new Map();
    for (const p of prompts) {
      const t0 = performance.now();
      let res;
      if (!fused) res = rank(sub, p, { k: 1000, maxK: 1000, minScore: 0, deadlineMs: 1e9 });
      else res = rankFused(sub, p, qvs.get(p), vecs, { k: 1000, maxK: 1000, minScore: 0, cosineFloor: -1, weight: w, deadlineMs: 1e9 }) ?? rank(sub, p, { k: 1000, maxK: 1000, minScore: 0, deadlineMs: 1e9 });
      rankTimes.push(performance.now() - t0);
      if (res.timedOut) timeouts++;
      lists.set(p, res.results.slice(0, KEEP_RANKED));
    }
    return lists;
  };

  const main = async (emb, dataDir) => {
    let qvs;
    let vecs;
    if (fused) {
      const { createVectorCache, passageVectors } = await dist('finder/embed.js');
      vecs = await passageVectors(emb, createVectorCache(dataDir), candDocs, AbortSignal.timeout(300_000), candDocs.length + 1);
      if (vecs.size < candDocs.filter((d) => d.name || d.description).length) throw new UsageError('not every skill got a vector');
      qvs = new Map();
      for (const p of prompts) {
        const t0 = performance.now();
        const [qv] = await emb.embed([p], AbortSignal.timeout(60_000), 'query');
        embedTimes.push(performance.now() - t0);
        qvs.set(p, qv);
      }
    }
    const lists = listsAt(weight, qvs, vecs);
    const filt = { minScore, floor: fused ? floor : -1 };
    const evalSet = (rows) => rows.map((row) => evalRow(row, lists.get(row.prompt), filt, k));
    const setReports = sets.map((s) => {
      const cov = evalSet(s.covered);
      // "all": a case whose gold id is not in the pool counts as a miss.
      const everything = s.all.map((row) => (row.resolved ? evalRow(row, lists.get(row.prompt), filt, k) : { ...row, pos: -1, shown: 0, ids: [] }));
      return {
        name: s.name, covered: { ...withSubsets(cov, k), timeouts }, all: withSubsets(everything, k), coveredCount: cov.length, total: s.all.length,
        unresolved: [...new Set(s.all.filter((r) => !r.resolved).map((r) => r.skill))].sort(),
        perSkill: [...new Set(s.all.map((r) => r.skill))].sort().map((skill) => {
          const mine = s.all.filter((r) => r.skill === skill);
          return { skill, resolved: mine[0].resolved, cases: mine.length, recallAtK: metrics(evalSet(mine.filter((r) => r.resolved)), k).recallAtK };
        }),
      };
    });
    let negReport = null;
    if (negatives.length) {
      const falseNotes = negatives.filter((p) => evalRow({}, lists.get(p), filt, k).shown > 0).length;
      negReport = { count: negatives.length, falseNotes, falseNoteRate: round(falseNotes / negatives.length), timeouts: 0 };
    }
    const stats = pointStats(sets, negatives, lists, filt, k);
    const report = {
      catalog: { source: catalog.source, skills: catalog.docs.length, on: catalog.pool.on, bySource: catalog.pool.bySource, ranked: candDocs.length },
      ranker: rankerName, pool: poolName, threshold: thresholdName, minScore, floor: fused ? floor : null, weight: fused ? weight : null, k,
      set: setReports[0].covered, setAll: setReports[0].all, unresolved: setReports[0].unresolved, negatives: negReport,
      sets: Object.fromEntries(setReports.map((s) => [s.name, { covered: s.covered, all: s.all, coveredCount: s.coveredCount, total: s.total, unresolved: s.unresolved }])),
      decisionStats: stats, meetsBars: meetsBars(stats),
      latency: { samples: rankTimes.length, p95Ms: p95Of(rankTimes), embedP95Ms: p95Of(embedTimes), embedOverBudget: embedTimes.filter((t) => t > D.EMBED_QUERY_BUDGET_MS).length },
      perSkill: setReports[0].perSkill,
    };

    const f = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(3));
    const line = (m) => `recall@1 ${f(m.recall1)}  recall@3 ${f(m.recall3)}  recall@5 ${f(m.recall5)}  MRR@5 ${f(m.mrr5)}  note rate ${f(m.noteRate)}  note precision ${f(m.notePrecision)}`;
    const sources = Object.entries(catalog.pool.bySource).map(([s, n]) => `${s} ${n}`).join(', ');
    console.log(`score: catalog ${catalog.source}, pool ${poolName} (${candDocs.length} ranked of ${catalog.docs.length}; ${catalog.pool.on} on), ranker ${rankerName}, min score ${minScore}${fused ? `, weight ${weight}, cosine floor ${floor}` : ''}, k ${k}`);
    console.log(`pool sources: ${sources === '' ? 'none' : sources}`);
    for (const s of setReports) {
      console.log(`${s.name}: ${s.total} cases (all), ${s.coveredCount} covered, ${s.unresolved.length} unresolved gold ids, ${timeouts} timeouts`);
      console.log(`  covered: ${line(s.covered)}`);
      console.log(`  all:     ${line(s.all)}`);
      for (const sb of SUBSET_ORDER) {
        if (s.covered[sb] && s.all[sb].cases > 0) {
          console.log(`  ${sb}: covered ${s.covered[sb].cases} of ${s.all[sb].cases}; recall@3 ${f(s.covered[sb].recall3)}; recall@5 covered ${f(s.covered[sb].recall5)}, all ${f(s.all[sb].recall5)}; precision ${f(s.covered[sb].notePrecision)}`);
        }
      }
      if (s.unresolved.length > 0) console.log(`unresolved gold ids: ${s.unresolved.join(', ')}`);
    }
    if (negReport) console.log(`negatives: ${negReport.count}, false notes ${negReport.falseNotes} (rate ${f(negReport.falseNoteRate)}), ${negReport.timeouts} timeouts`);
    else console.log('negatives: none given (false-note rate not measured)');
    console.log(`decision stats: recall@3 mean of sets ${f(stats.recall)}, precision ${f(stats.precision)}, false-note ${f(stats.falseNoteRate)}; bars ${meetsBars(stats) ? 'met' : 'NOT met'}`);
    console.log(`latency: p95 ${report.latency.p95Ms} ms over ${rankTimes.length} queries${fused ? `; embed p95 ${report.latency.embedP95Ms} ms, ${report.latency.embedOverBudget} over ${D.EMBED_QUERY_BUDGET_MS} ms` : ''}`);

    if (opts.sweep !== undefined) {
      const sweep = [];
      if (!fused) {
        for (const t of KEYWORD_GRID) sweep.push({ minScore: t, floor: -1, weight: null, ...pointStats(sets, negatives, lists, { minScore: t, floor: -1 }, k) });
      } else {
        for (const w of WEIGHT_GRID) {
          const lw = w === weight ? lists : listsAt(w, qvs, vecs);
          for (const fl of FLOOR_GRID) for (const t of FUSED_GRID) sweep.push({ minScore: t, floor: fl, weight: w, ...pointStats(sets, negatives, lw, { minScore: t, floor: fl }, k) });
        }
      }
      const feasible = sweep.filter(meetsBars).sort(byRule);
      report.sweep = { points: sweep.length, feasible: feasible.length, best: feasible[0] ?? null, all: sweep };
      const show = (p) => `min ${p.minScore}${p.weight === null ? '' : ` w ${p.weight} floor ${p.floor}`}: recall@3 ${f(p.recall)} (${Object.entries(p.perSetRecall3).map(([n, v]) => `${n} ${f(v)}`).join(', ')}) precision ${f(p.precision)} false-note ${f(p.falseNoteRate)} note rate ${f(p.noteRate)}`;
      console.log(`sweep: ${sweep.length} points, ${feasible.length} meet the bars (false-note <= ${BARS.falseNote}, precision >= ${BARS.precision})`);
      if (!fused) {
        for (const p of sweep) console.log(`  ${show(p)}${meetsBars(p) ? '  *' : ''}`);
      } else {
        for (const w of WEIGHT_GRID) {
          const b = feasible.find((p) => p.weight === w);
          console.log(`  best feasible at weight ${w}: ${b ? show(b) : 'none'}`);
        }
        console.log('  top 10 feasible:');
        for (const p of feasible.slice(0, 10)) console.log(`    ${show(p)}`);
        if (feasible.length === 0) {
          console.log('  nothing meets both bars. Lowest false-note rate with precision >= 0.5, then best recall at false-note <= 0.30:');
          for (const p of sweep.filter((x) => x.precision !== null && x.precision >= BARS.precision).sort((a, b) => a.falseNoteRate - b.falseNoteRate || b.recall - a.recall).slice(0, 5)) console.log(`    ${show(p)}`);
          for (const p of sweep.filter((x) => x.falseNoteRate !== null && x.falseNoteRate <= 0.3).sort((a, b) => b.recall - a.recall).slice(0, 5)) console.log(`    ${show(p)}`);
        }
      }
      const best = feasible[0];
      if (best) {
        // Check on the real ranker: run it with the floor and threshold in its own options and compare with the post-filtered result.
        const lw = !fused ? lists : listsAt(best.weight, qvs, vecs);
        let same = 0;
        for (const p of prompts) {
          const real = !fused
            ? rank(sub, p, { k, maxK: k, minScore: best.minScore, deadlineMs: 1e9 }).results
            : (rankFused(sub, p, qvs.get(p), vecs, { k, maxK: k, minScore: best.minScore, cosineFloor: best.floor, weight: best.weight, deadlineMs: 1e9 }) ?? { results: [] }).results;
          const viaFilter = evalRow({}, lw.get(p), { minScore: best.minScore, floor: fused ? best.floor : -1 }, k).ids;
          if (real.length === viaFilter.length && real.every((r, i) => r.id === viaFilter[i])) same++;
        }
        report.sweep.checked = { prompts: prompts.length, identical: same };
        console.log(`check on the real ranker at the best point: ${same} of ${prompts.length} prompts give the same skills`);
      }
    }

    if (opts.rerank !== undefined) await rerankPass({ sets, negatives, lists, filt, k, fused, sampleN, margin, docById, dist, report, D });

    return report;
  };

  const t0 = performance.now();
  const report = fused ? await withLocalModel(dist, (emb, dataDir) => main(emb, dataDir)) : await main(undefined, undefined);
  report.elapsedS = round((performance.now() - t0) / 1000);

  if (jsonTarget) {
    mkdirSync(dirname(jsonTarget), { recursive: true });
    writeFresh(jsonTarget, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`json written to ${jsonTarget}`);
  }
}

// ---------- the rerank pass ----------

/**
 * Asks the real warm rerank session about a seeded sample of the cases that have two or more candidates, then reports the metrics for
 * each margin offline (the margin only decides which cases the model sees). The session enforces its own $1 cap through its spend file.
 */
async function rerankPass(c) {
  const { RerankSession, isCloseMatch, rerankScores } = await c.dist('finder/rerank.js');
  const { RERANK_CANDIDATES, RERANK_DEADLINE_MS } = c.D;
  const rowsBySet = c.sets.map((s) => ({ name: s.name, rows: sample(s.covered, c.sampleN, SAMPLE_SEED) }));
  const negPick = sample(c.negatives, c.sampleN, SAMPLE_SEED);
  const dataDir = mkdtempSync(join(tmpdir(), 'finder-eval-rerank-'));
  const logs = [];
  const session = new RerankSession({
    dataDir, launch: () => ({ env: { ...process.env } }), log: (m) => logs.push(m),
    deadlineMs: 20_000, warmMs: 40_000, recycleAfter: 1_000_000, idleMs: 600_000, hardMs: 60_000,
  });
  const wideOf = (list) => {
    const kept = [];
    for (const r of list) {
      if (r.score < c.filt.minScore) break;
      if (r.cosine !== undefined && r.cosine < c.filt.floor) continue;
      kept.push(r);
      if (kept.length >= RERANK_CANDIDATES) break;
    }
    return kept;
  };
  const closeOf = (wide, margin) => {
    const best = c.fused ? 0 : Math.max(0, ...wide.map((r) => r.bm25));
    return isCloseMatch(rerankScores(wide, c.fused, best), margin);
  };
  const asked = new Map(); // prompt -> { ids, ms }
  const stats = { asked: 0, answered: 0, kept: 0, empty: 0, waitedForWarm: 0, overDeadline: 0 };
  const ask = async (prompt) => {
    if (asked.has(prompt)) return;
    const wide = wideOf(c.lists.get(prompt));
    if (wide.length < 2) return;
    const req = { text: prompt, candidates: wide.map((r) => ({ id: r.id, description: c.docById.get(r.id)?.description ?? '' })), k: c.k, monthlyUsd: 1 };
    let ids;
    let ms = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const t0 = performance.now();
      ids = await session.pick(req);
      ms = performance.now() - t0;
      if (ids !== undefined || session.state() === 'ready') break;
      // The first call only starts the session. Wait until it has answered its warm-up, then ask again.
      stats.waitedForWarm++;
      const w0 = performance.now();
      while (session.state() !== 'ready' && session.state() !== 'none' && performance.now() - w0 < 60_000) await new Promise((r) => setTimeout(r, 50));
      if (session.state() !== 'ready') break;
    }
    stats.asked++;
    if (ids === undefined) stats.kept++;
    else {
      stats.answered++;
      if (ids.length === 0) stats.empty++;
    }
    if (ms > RERANK_DEADLINE_MS) stats.overDeadline++;
    asked.set(prompt, { ids, ms });
  };
  const spend = () => {
    try {
      return Object.values(JSON.parse(readFileSync(join(dataDir, 'skill-finder', 'spend.json'), 'utf8'))).reduce((a, b) => a + b, 0);
    } catch {
      return 0;
    }
  };
  try {
    for (const p of [...rowsBySet.flatMap((s) => s.rows.map((r) => r.prompt)), ...negPick]) {
      if (spend() >= 0.95) {
        console.log('rerank: stopped at the cost cap');
        break;
      }
      await ask(p);
    }
  } finally {
    session.dispose();
    await new Promise((r) => setTimeout(r, 500));
  }
  const cost = round(spend());
  rmSync(dataDir, { recursive: true, force: true });

  // A margin M: the model sees a case only when the top scores are within M; its answer counts only if it came inside the shipped deadline.
  const chosenFor = (prompt, margin, withModel) => {
    const wide = wideOf(c.lists.get(prompt));
    let chosen = wide.slice(0, c.k);
    if (withModel && wide.length >= 2 && closeOf(wide, margin)) {
      const a = asked.get(prompt);
      if (a && a.ids !== undefined && a.ms <= RERANK_DEADLINE_MS) chosen = a.ids.map((id) => wide.find((r) => r.id === id)).filter(Boolean);
    }
    return chosen;
  };
  const rowStats = (margin, withModel) => {
    const per = rowsBySet.map((s) => {
      const ev = s.rows.map((row) => {
        const chosen = chosenFor(row.prompt, margin, withModel);
        return { pos: chosen.findIndex((r) => row.gold.has(r.id)), shown: chosen.length };
      });
      const noted = ev.filter((e) => e.shown > 0);
      return { name: s.name, n: ev.length, hit3: ev.filter((e) => e.pos >= 0 && e.pos < 3).length, noted: noted.length, notedHit: noted.filter((e) => e.pos >= 0).length };
    });
    const noted = per.reduce((a, s) => a + s.noted, 0);
    const notedHit = per.reduce((a, s) => a + s.notedHit, 0);
    const falseNotes = negPick.filter((p) => chosenFor(p, margin, withModel).length > 0).length;
    return {
      margin: withModel ? margin : null,
      recall3: Object.fromEntries(per.map((s) => [s.name, round(s.hit3 / Math.max(1, s.n))])),
      precision: noted === 0 ? null : round(notedHit / noted),
      falseNoteRate: negPick.length === 0 ? null : round(falseNotes / negPick.length),
      modelSeen: [...asked.keys()].filter((p) => closeOf(wideOf(c.lists.get(p)), margin)).length,
    };
  };
  const base = rowStats(0, false);
  const byMargin = MARGIN_GRID.map((m) => rowStats(m, true));
  const times = [...asked.values()].map((a) => a.ms).filter((t) => t > 0);
  c.report.rerank = {
    sample: { perSet: Object.fromEntries(rowsBySet.map((s) => [s.name, s.rows.length])), negatives: negPick.length }, asked: stats, costUsd: cost,
    latencyMs: { p50: times.length ? round(times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)]) : null, p95: p95Of(times) },
    withoutRerank: base, byMargin, logLines: [...new Set(logs)],
  };
  const f = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(3));
  const show = (r) => `recall@3 ${Object.entries(r.recall3).map(([n, v]) => `${n} ${f(v)}`).join(', ')}; precision ${f(r.precision)}; false-note ${f(r.falseNoteRate)}${r.margin === null ? '' : `; model sees ${r.modelSeen}`}`;
  console.log(`rerank: sample ${JSON.stringify(c.report.rerank.sample.perSet)} + ${negPick.length} negatives; asked ${stats.asked} (answered ${stats.answered}, order kept ${stats.kept}, said none fit ${stats.empty}, over ${RERANK_DEADLINE_MS} ms ${stats.overDeadline}); cost $${cost}`);
  console.log(`  latency per answer: p50 ${c.report.rerank.latencyMs.p50} ms, p95 ${c.report.rerank.latencyMs.p95} ms`);
  console.log(`  no rerank:    ${show(base)}`);
  for (const r of byMargin) console.log(`  margin ${String(r.margin).padEnd(4)}:  ${show(r)}`);
  if (c.report.rerank.logLines.length) console.log(`  session notes: ${c.report.rerank.logLines.join('; ')}`);
}

// ---------- command line ----------

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new FlagError(USAGE);
    const key = a.slice(2);
    if (SWITCH_FLAGS.has(key)) {
      opts[key] = true;
      continue;
    }
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
