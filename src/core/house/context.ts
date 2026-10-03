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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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

/** Directories copied whole, because the ADRs and skills are useless without their neighbours. */
export const SHIPPED_DIRS = ['docs/adr', 'context', 'claude/skills'] as const;

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
} as const;

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
  const raw = String(requested ?? '').trim();
  if (!raw || raw.includes('\0')) return null;
  const target = join(root, raw);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..' + sep) || rel === '..' || resolveOutside(rel)) return null;
  return target;
}

/** `relative()` returning an absolute path means the target was on another drive (Windows) or at the root. */
const resolveOutside = (rel: string): boolean => /^[a-zA-Z]:/.test(rel) || rel.startsWith(sep);

/** Lists the context layer. Sorted, so the same folder always reads the same way. */
export function listContext(root: string): ContextListing {
  const files: ContextFile[] = [];
  const missing: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.push({ path: normalisePath(relative(root, full)), bytes: st.size });
    }
  };
  walk(root);
  if (!existsSync(root)) return { files, missing: [...SHIPPED_FILES] };
  for (const want of SHIPPED_FILES) {
    const abs = resolveInside(root, want);
    if (!abs || !existsSync(abs)) missing.push(want);
  }
  return { files, missing };
}

export interface ReadOutcome {
  ok: true;
  path: string;
  text: string;
  /** True when the file was over the read cap and only its head was returned. */
  clipped: boolean;
} | { ok: false; reason: 'outside' | 'absent' | 'too-large'; message: string };

/**
 * Reads one file from the context root.
 *
 * A file over `maxFileBytes` is refused rather than truncated: a rule cut in half is read as a whole rule and then
 * obeyed wrongly, which is the exact failure the untrusted wrapper cannot catch because this file is trusted.
 */
export function readContextFile(root: string, requested: string): ReadOutcome {
  const abs = resolveInside(root, requested);
  if (!abs) {
    return { ok: false, reason: 'outside', message: 'That path is outside the house context folder. Use house_list to see what is there.' };
  }
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, reason: 'absent', message: `No such file in the house context folder: ${normalisePath(requested)}. Call house_list for the list.` };
  }
  if (!st.isFile()) {
    return { ok: false, reason: 'absent', message: 'That is a folder, not a file. Call house_list.' };
  }
  if (st.size > HOUSE_LIMITS.maxFileBytes) {
    return { ok: false, reason: 'too-large', message: `That file is ${st.size} bytes, over the ${HOUSE_LIMITS.maxFileBytes} cap. Read the relevant part with your own file tools instead.` };
  }
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'absent', message: `Could not read that file: ${err instanceof Error ? err.message : String(err)}` };
  }
  const clipped = text.length > HOUSE_LIMITS.toolResultChars;
  return { ok: true, path: normalisePath(relative(root, abs)), text: clipped ? text.slice(0, HOUSE_LIMITS.toolResultChars) : text, clipped };
}

export interface RecallHit {
  path: string;
  /** Heading or first non-empty line the hit sits under, so the hit is identifiable without the file. */
  title: string;
  snippet: string;
  score: number;
}

const headingOf = (line: string): string => {
  const h = /^(#{1,6})\s+(.*)$/.exec(line);
  return h ? h[2].trim() : '';
};

/**
 * Lexical recall over the context layer, BM25-flavoured like the KG so the two tools feel the same to a bot.
 *
 * Deliberately not the KG: this searches the owner's own text, and its ranking does not carry the recency factor that
 * made two Library comparisons disagree. What is in the house does not go stale by being old.
 */
export function recallContext(root: string, query: string, limit = HOUSE_LIMITS.recallEntries): RecallHit[] {
  const terms = tokenise(query);
  if (!terms.length) return [];
  const files = listContext(root).files.filter((f) => f.path.endsWith('.md') && f.bytes <= HOUSE_LIMITS.maxFileBytes);
  const docs = files.map((f) => {
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

  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
  const k1 = 1.2;
  const b = 0.75;
  const n = docs.length;
  const hits: RecallHit[] = [];
  for (const d of docs) {
    let score = 0;
    d.tf.forEach((f, i) => {
      if (!f) return;
      const df = docs.filter((o) => o.tf[i] > 0).length;
      if (!df) return;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / (avg || 1)))));
    });
    if (score <= 0) continue;
    const idx = firstHitLine(d.hay, terms);
    if (idx < 0) continue;
    const snippet = d.lines[idx].trim().slice(0, HOUSE_LIMITS.snippetChars);
    let title = '';
    for (let i = idx; i >= 0; i--) {
      const h = headingOf(d.lines[i]);
      if (h) { title = h; break; }
    }
    hits.push({ path: d.path, title: title || d.lines[idx].trim().slice(0, 60), snippet, score });
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