/**
 * The house rules index: what ships to `~/.legion/context/`, how it is laid out, and how it is read.
 *
 * An agent's working directory is `~/.legion/workspaces/<agentId>`, never this repository, so nothing in the repo is
 * ever in an agent's context. This module is the seam that changes that: the repo's context layer is copied into the
 * Legion data directory and served to every agent through the in-process `legion_house` tools.
 *
 * Everything here is Legion's own text, so it is trusted and needs no untrusted wrapper — the reverse of the KG's
 * rule. What an agent *fetches* is a different matter: a file the user dropped into the context folder, or a note
 * carrying an `untrusted` source, is data and is wrapped. See `wrap.ts`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ADOPTED_NAME, MANIFEST_NAME, readAdopted, readManifest, serveFile, trustKind } from './trust.js';
import type { TrustKind } from './trust.js';
import { categoryOf, isOn, readSwitches } from './switches.js';
import type { SwitchState } from './switches.js';

export const HOUSE_SERVER_NAME = 'legion_house';

/** Where the context layer lives inside the Legion data directory. */
export const CONTEXT_DIRNAME = 'context';

/** Files copied out of the repository into the data directory. Everything else is left behind. */
export const SHIPPED_FILES = [
  'AGENTS.md',
  'CONTEXT.md',
  'docs/SESSION-LOG.md',
  'docs/VERSIONING.md',
  'docs/RELEASE-NOTES.md',
  'docs/ARCHITECTURE.md',
  'docs/TESTING.md',
  'docs/adr/README.md',
] as const;

/** Directories copied whole, because the ADRs are useless without their neighbours. */
export const SHIPPED_DIRS = ['docs/adr', 'context', 'skills'] as const;

/**
 * The owner's switches decide what an agent sees (see ./switches.ts). Skills never come through house_list, house_read
 * or house_recall at all: they are served only by house_skills / house_skill (./skills.ts), which check their own
 * switch, so a skill that is off can never be read by guessing its path.
 */
export const isServed = (rel: string, state: SwitchState): boolean => categoryOf(rel) !== 'skills' && isOn(rel, state);

/**
 * The path as the file system names it, relative to the layer, or null when that cannot be worked out. Null means
 * refuse: falling back to the request's own spelling would compare a switch against a name that is not the file's.
 *
 * Needed because a request is only checked LEXICALLY by `resolveInside`, and Windows and macOS reach one file by many
 * spellings (`agents.md`, `SkillsGNskill.md`, 8.3 short names). Comparing a switch against the spelling in the
 * request would let a differently-cased path read a file the owner switched off. `realpath.native` returns the real
 * name, so the comparison is against what the file is, not what it was called.
 */
export function canonicalRel(root: string, abs: string): string | null {
  try {
    const real = relative(realpathSync.native(root), realpathSync.native(abs));
    if (real && !real.startsWith('..') && !/^[a-zA-Z]:/.test(real)) return normalisePath(real);
  } catch { /* cannot be resolved: refuse, see above */ }
  return null;
}

/**
 * Deliberately NOT shipped: `claude/skills`.
 *
 * It was listed here until 2026-10-04 and no packaged install ever received it, because CODE_SET does not carry the
 * repository root (see sync.ts). Adding it back would ship the owner's personal workflow skills to every user, which
 * `scripts/export-public.mjs` already forbids for the public repo ("claude/skills/** excluded wholesale"). Those skills
 * belong to whoever wrote them; a user's own skills are their own files in their own context folder. If shippable skills
 * are wanted later they need a public path of their own, not this one. That path now exists: the top-level `skills/`
 * folder (Legion's own vendored skills, listed in SHIPPED_DIRS), served only through house_skills / house_skill and OFF
 * until the owner switches each one on.
 */

/** Cap on one returned file, so a large document cannot crowd out the run's real context. */
export const HOUSE_LIMITS = {
  /** Characters per house_read result. */
  toolResultChars: 20_000,
  /** Characters per house_recall outline entry. */
  snippetChars: 220,
  /** Entries returned by house_recall. */
  recallEntries: 8,
  /** Bytes at which a file is refused rather than truncated: silently cutting a rule in half is worse than saying no. */
  maxFileBytes: 512_000,
  /**
   * Total bytes one search may read. `maxFileBytes` is per file and bounded nothing: a directory of 200 large files
   * passed it and recall read all of them on every call. This is the whole-search ceiling, and it is a budget, not a
   * ranking input — the same files in a different order would otherwise read differently.
   */
  maxSearchBytes: 4_000_000,
  /** Files one search will read, so a wide directory cannot spend the budget on file count alone. */
  maxSearchFiles: 200,
  /** Directory depth walked from the context root. The layer is the docs, the ADRs, the facts and Legion's shipped skills, not a mirror. */
  maxDepth: 6,
} as const;

/** The recall cap as a plain number: `HOUSE_LIMITS` is `as const`, so its members are literal types. */
export const RECALL_LIMIT = HOUSE_LIMITS.recallEntries;

export interface ContextFile {
  /** Path relative to the context root, always with forward slashes. */
  path: string;
  bytes: number;
}

export interface ContextListing {
  files: ContextFile[];
  /** Files that were expected but are absent, so a missing layer is visible rather than silently empty. */
  missing: string[];
}

/** Normalises a repo- or data-dir-relative path to the forward-slash form used as the file's identity. */
export const normalisePath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/**
 * Rejects anything that tries to leave the context root.
 *
 * The tools take a path from a model's output, so `../../.legion/state.json` and an absolute Windows path are both
 * live attempts. Resolving and re-checking the prefix is the only check that holds for symlinks and drive letters too.
 */
export function resolveInside(root: string, requested: string): string | null {
  // A Windows agent writes `docs\adr\x.md`. On POSIX a backslash is a filename character, so without this `..\state.json`
  // named a file inside the root instead of an escape, and a nested backslash path did not resolve at all.
  const raw = String(requested ?? '').trim().replace(/\\/g, '/');
  // No house file name holds a colon. On Windows a colon after the name opens an NTFS stream of the same file
  // (`ARCHITECTURE.md::$DATA`), a spelling the switch check should never have to recognise. Drive letters are refused too.
  if (!raw || raw.includes('\0') || raw.includes(':')) return null;
  const target = join(root, raw);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..' + sep) || rel === '..' || resolveOutside(rel)) return null;
  return target;
}

/** `relative()` returning an absolute path means the target was on another drive (Windows) or at the root. */
const resolveOutside = (rel: string): boolean => /^[a-zA-Z]:/.test(rel) || rel.startsWith(sep);

/**
 * Lists the context layer. Sorted, so the same folder always reads the same way.
 *
 * By default this is what an AGENT may see: files the owner switched off and every skill file are left out. The owner's
 * own screen and the sync pass `{ all: true }` for the whole layer.
 */
export function listContext(root: string, opts: { all?: boolean } = {}): ContextListing {
  const files: ContextFile[] = [];
  const missing: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > HOUSE_LIMITS.maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      // The trust manifests are bookkeeping, not content. Counting them made an EMPTY layer look populated (the shipped
      // manifest is written on every sync), which defeated the "no files -> hand out no tools" guard in index.ts and
      // offered the agent a readable file that exists only to be excluded from trust decisions.
      if (name === MANIFEST_NAME || name === ADOPTED_NAME) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile()) files.push({ path: normalisePath(relative(root, full)), bytes: st.size });
    }
  };
  walk(root, 0);
  if (!opts.all) {
    const state = readSwitches(root);
    const served = files.filter((f) => isServed(f.path, state));
    files.length = 0;
    files.push(...served);
  }
  if (!existsSync(root)) return { files, missing: [...SHIPPED_FILES] };
  for (const want of SHIPPED_FILES) {
    const abs = resolveInside(root, want);
    if (!abs || !existsSync(abs)) missing.push(want);
  }
  // A promised directory that is not there is as much a gap as a missing file: an agent told to read `docs/adr/` finds
  // nothing there and reports the layer as empty.
  for (const want of SHIPPED_DIRS) {
    const abs = resolveInside(root, want);
    if (!abs || !existsSync(abs)) missing.push(want);
  }
  return { files, missing };
}

export type ReadOutcome =
  | {
      ok: true;
      path: string;
      text: string;
      /** True when the file was over the read cap and only its head was returned. */
      clipped: boolean;
      /** True when the bytes are the app's own or the owner's approved ones. False means the file needs an approval. */
      trusted: boolean;
      /** Which of the three trust states applies, so the caller can say something more useful than a boolean. */
      kind: TrustKind;
    }
  | { ok: false; reason: 'outside' | 'absent' | 'too-large'; message: string };

/**
 * Reads one file from the context root.
 *
 * A file over `maxFileBytes` is refused rather than truncated: a rule cut in half is read as a whole rule and then
 * obeyed wrongly, which the untrusted wrapper cannot catch because a shipped rule reads as trusted.
 *
 * Content that is no longer the app's own words is wrapped on the way out (see ./trust.ts). That is the whole point of
 * the module: an agent editing this repo can edit `AGENTS.md`, and its own text must not return as the owner's rules.
 */
export function readContextFile(root: string, requested: string, opts: { ignoreSwitches?: boolean } = {}): ReadOutcome {
  const abs = resolveInside(root, requested);
  if (!abs) {
    return { ok: false, reason: 'outside', message: 'That path is outside the Doctrine folder. Use house_list to see what is there.' };
  }
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, reason: 'absent', message: `No such file in the Doctrine folder: ${normalisePath(requested)}. Call house_list for the list.` };
  }
  if (!st.isFile()) {
    return { ok: false, reason: 'absent', message: 'That is a folder, not a file. Call house_list.' };
  }
  if (st.size > HOUSE_LIMITS.maxFileBytes) {
    return { ok: false, reason: 'too-large', message: `That file is ${st.size} bytes, over the ${HOUSE_LIMITS.maxFileBytes} cap. Read the relevant part with your own file tools instead.` };
  }
  const rel = canonicalRel(root, abs);
  // A file the owner switched off, and any skill file, answers exactly as an absent one does: the message must not tell an
  // agent that a rule exists and is being withheld. A path whose real name cannot be worked out is refused the same way.
  if (rel === null || (!opts.ignoreSwitches && !isServed(rel, readSwitches(root)))) {
    return { ok: false, reason: 'absent', message: `No such file in the Doctrine folder: ${normalisePath(requested)}. Call house_list for the list.` };
  }
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'absent', message: `Could not read that file: ${err instanceof Error ? err.message : String(err)}` };
  }
  const served = serveFile(root, rel, text);
  text = served.text;
  const clipped = text.length > HOUSE_LIMITS.toolResultChars;
  return { ok: true, path: rel, text: clipped ? text.slice(0, HOUSE_LIMITS.toolResultChars) : text, clipped, trusted: served.trusted, kind: served.kind };
}

export interface RecallHit {
  path: string;
  /** Heading or first non-empty line the hit sits under, so the hit is identifiable without the file. */
  title: string;
  snippet: string;
  score: number;
  /** False when the file is neither the app's own bytes nor the owner's approved ones. The snippet is then served wrapped. */
  trusted: boolean;
  /** Which of the three trust states applies to the file this hit came from. */
  kind: TrustKind;
}

export const headingOf = (line: string): string => {
  const h = /^(#{1,6})\s+(.*)$/.exec(line);
  return h ? h[2].trim() : '';
};

/**
 * Lexical recall over the context layer, BM25-flavoured like the KG so the two tools feel the same to a bot.
 *
 * Deliberately not the KG: this searches the owner's own text, and its ranking does not carry the recency factor that
 * made two Library comparisons disagree. What is in the house does not go stale by being old.
 */
export function recallContext(root: string, query: string, limit: number = RECALL_LIMIT): RecallHit[] {
  const terms = tokenise(query);
  if (!terms.length) return [];
  const files = listContext(root).files.filter((f) => f.path.endsWith('.md') && f.bytes <= HOUSE_LIMITS.maxFileBytes);
  // Spend a fixed budget, largest files first so one big document cannot crowd out the rest of the layer. Files are
  // taken in path order for a tie so the same layer always yields the same search.
  const budgeted: ContextFile[] = [];
  let spent = 0;
  for (const f of [...files].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))) {
    if (budgeted.length >= HOUSE_LIMITS.maxSearchFiles) break;
    if (spent + f.bytes > HOUSE_LIMITS.maxSearchBytes) continue;
    spent += f.bytes;
    budgeted.push(f);
  }
  const docs = budgeted.map((f) => {
    const abs = resolveInside(root, f.path);
    if (!abs) return null;
    let lines: string[];
    try {
      lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    } catch {
      return null;
    }
    const hay = lines.map((l) => l.toLowerCase());
    return { path: f.path, lines, hay, tf: countTerms(hay, terms), len: hay.join('\n').length };
  }).filter((d): d is { path: string; lines: string[]; hay: string[]; tf: number[]; len: number } => !!d);

  const manifest = readManifest(root);
  const adopted = readAdopted(root);
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
  const k1 = 1.2;
  const b = 0.75;
  const n = docs.length;
  // Document frequency per term, computed once. Recomputing it inside the scoring loop made this O(terms x docs x docs)
  // for the same answer.
  const df = terms.map((_, i) => docs.filter((o) => o.tf[i] > 0).length);
  const hits: RecallHit[] = [];
  for (const d of docs) {
    let score = 0;
    d.tf.forEach((f, i) => {
      if (!f) return;
      const nDf = df[i]!;
      if (!nDf) return;
      const idf = Math.log(1 + (n - nDf + 0.5) / (nDf + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / (avg || 1)))));
    });
    if (score <= 0) continue;
    const idx = firstHitLine(d.hay, terms);
    if (idx < 0) continue;
    const line = d.lines[idx].trim().slice(0, HOUSE_LIMITS.snippetChars);
    let title = '';
    for (let i = idx; i >= 0; i--) {
      const h = headingOf(d.lines[i]);
      if (h) { title = h; break; }
    }
    const kind = trustKind(root, d.path, manifest, adopted);
    const trusted = kind !== 'untrusted';
    // Wrapped per hit rather than per file: the wrapper costs two lines, and a search that returned the app's own text
    // unlabelled next to an agent's edit would be exactly the confusion this module exists to prevent.
    const snippet = trusted ? line : `[UNTRUSTED SOURCE — edited or added since install: ${d.path}] ${line}`;
    hits.push({ path: d.path, title: title || d.lines[idx].trim().slice(0, 60), snippet, score, trusted, kind });
  }
  return hits.sort((a, b2) => b2.score - a.score || a.path.localeCompare(b2.path)).slice(0, limit);
}

const tokenise = (q: string): string[] =>
  [...new Set(String(q ?? '').toLowerCase().split(/[^a-z0-9_.-]+/).filter((t) => t.length > 1))];

const countTerms = (hay: string[], terms: string[]): number[] => {
  const counts = new Array(terms.length).fill(0) as number[];
  for (const line of hay) for (let i = 0; i < terms.length; i++) if (line.includes(terms[i])) counts[i]++;
  return counts;
};

const firstHitLine = (hay: string[], terms: string[]): number => {
  for (let i = 0; i < hay.length; i++) if (terms.some((t) => hay[i].includes(t))) return i;
  return -1;
};

/** Every path the layer is expected to hold, for the installer and for the missing-file report. */
export const expectedPaths = (): string[] => [
  ...SHIPPED_FILES,
  ...SHIPPED_DIRS.map((d) => `${d}/`),
];