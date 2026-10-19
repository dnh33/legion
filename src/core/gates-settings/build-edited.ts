/**
 * Which projects have a build or script file an agent changed since the owner last allowed a build or test command there (Task 27).
 * Smart asks for local build and test commands while a project is flagged. A project is flagged by either signal:
 *  - the token flag: a file tool or a shell command named a build file (set by the engine);
 *  - the fingerprint: the project's build files no longer match the baseline stored for it. This one needs no reading of command text, so
 *    quoting, `cd`, other spellings, a git pull or an editor are all caught.
 * Both are per project and survive a restart: `<dataDir>/gates/build-edited.json`, written atomically. The file tools cannot change that
 * folder (the PreToolUse hook denies them in every mode); a shell command that targets it gets a card in Ask, Accept edits and Smart;
 * Bypass can change anything.
 *
 * Fails closed: a file that exists but cannot be read flags every project. It is then stored as `{ v: 1, all: true, cleared: [...] }`:
 * the owner's allow in a project adds it to `cleared`, and a later build-file edit there removes it again. A write that fails is retried
 * on the next call; if it is lost across a restart the baseline on disk is the old one, so the fingerprint still flags the change.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isBuildFile } from '../../shared/build-files.js';

/** What the engine takes when a card opens: the owner's allow clears the flag only if nothing was edited while the card was open. */
export interface BuildSnapshot { gen: number; print?: string }
export interface BuildEdited {
  /** Flagged by the token flag, or (with `folder`) by a fingerprint that differs from the baseline. */
  has(projectId: string, folder?: string): boolean;
  /** `has` and the snapshot to hand to `clear`, from one fingerprint. */
  check(projectId: string, folder?: string): { flagged: boolean; snap: BuildSnapshot };
  /** First sight of a project: its current fingerprint becomes the baseline (trusted state). Cheap once a baseline exists. */
  ensureBaseline(projectId: string, folder: string): void;
  set(projectId: string): void;
  /**
   * The owner allowed the card the flag caused. With a snapshot: nothing changes if a build file was named or the fingerprint moved since
   * the card opened (the project stays flagged); else the flag goes and the snapshot's fingerprint is the new baseline.
   */
  clear(projectId: string, snap?: BuildSnapshot, folder?: string): void;
}
/** Test-only seam: how the file is written. */
export interface BuildEditedIo { write(file: string, data: string): void }

const realIo: BuildEditedIo = {
  write(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, file);
  },
};

const MAX_ENTRIES = 2000;
/**
 * A fingerprint of the project's build files: the build files directly in the folder (isBuildFile) and everything under `scripts/`
 * (symlinks and junctions are not followed). Nested package.json files in sub-folders are NOT included (stated limit; the token flag still
 * covers a file tool or a command that names one). Also covers 8.3 short names and any spelling of a root file. An unreadable folder is
 * the fixed print `unreadable`, which never equals the baseline of a readable one.
 */
export function buildFingerprint(folder: string): string {
  const lines: string[] = [];
  let more = false;
  const add = (rel: string, full: string): void => {
    if (lines.length >= MAX_ENTRIES) { more = true; return; }
    try { const st = lstatSync(full); lines.push(`${rel}|${st.size}|${st.mtimeMs}`); } catch { /* gone meanwhile: contributes nothing */ }
  };
  try {
    for (const e of readdirSync(folder, { withFileTypes: true })) if (e.isFile() && isBuildFile(e.name)) add(e.name, join(folder, e.name));
  } catch { return 'unreadable'; }
  const walk = (rel: string): void => {
    let entries;
    try { entries = readdirSync(join(folder, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r); else if (e.isFile()) add(r, join(folder, r));
      if (more) return;
    }
  };
  try { if (lstatSync(join(folder, 'scripts')).isDirectory()) walk('scripts'); } catch { /* no scripts folder */ }
  lines.sort();
  return createHash('sha256').update(lines.join('\n') + (more ? '\n+more' : '')).digest('hex');
}

const ids = (v: unknown): Set<string> | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? new Set(v as string[]) : undefined);
const printsOf = (v: unknown): Map<string, string> | undefined => {
  if (v === undefined) return new Map();
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const e = Object.entries(v as Record<string, unknown>);
  return e.every(([, x]) => typeof x === 'string') ? new Map(e as Array<[string, string]>) : undefined;
};

export function createBuildEdited(folder: string, io: BuildEditedIo = realIo): BuildEdited {
  const file = join(folder, 'build-edited.json');
  let all = false;
  let list = new Set<string>(); // the flagged projects, or (when `all`) the projects the owner has cleared since
  let prints = new Map<string, string>(); // the baseline fingerprint per project
  const gens = new Map<string, number>(); // bumped by every set(), memory only
  let dirty = false;
  const save = (): void => {
    // the flag in memory is what counts: a write that fails (disk full, a lock on the rename) must not turn into an error in a tool call; it is retried
    try {
      io.write(file, JSON.stringify({ v: 1, ...(all ? { all: true, cleared: [...list] } : { projects: [...list] }), prints: Object.fromEntries(prints) }));
      dirty = false;
    } catch { dirty = true; }
  };
  const retry = (): void => { if (dirty) save(); };
  if (existsSync(file)) {
    let ok = false;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.v === 1) {
        const l = raw.all === true ? ids(raw.cleared) : ids(raw.projects);
        const p = printsOf(raw.prints);
        if (l && p) { all = raw.all === true; list = l; prints = p; ok = true; }
      }
    } catch { /* unreadable: handled below */ }
    if (!ok) { all = true; list = new Set(); prints = new Map(); save(); }
  }
  const token = (id: string): boolean => (all ? !list.has(id) : list.has(id));
  /** Adds or removes one id from `list`; writes only when that changed something. */
  const change = (id: string, add: boolean): void => {
    if (add === list.has(id)) return;
    if (add) list.add(id); else list.delete(id);
    save();
  };
  const baseline = (id: string, dir: string): void => {
    if (prints.has(id)) return;
    const p = buildFingerprint(dir);
    if (p === 'unreadable') return;
    prints.set(id, p); save();
  };
  const check = (id: string, dir?: string): { flagged: boolean; snap: BuildSnapshot } => {
    retry();
    const gen = gens.get(id) ?? 0;
    if (!dir) return { flagged: token(id), snap: { gen } };
    baseline(id, dir);
    const print = buildFingerprint(dir);
    const base = prints.get(id);
    return { flagged: token(id) || (base !== undefined && print !== base), snap: { gen, print } };
  };
  return {
    has: (id, dir) => check(id, dir).flagged,
    check,
    ensureBaseline: (id, dir) => { retry(); baseline(id, dir); },
    set(id) { retry(); gens.set(id, (gens.get(id) ?? 0) + 1); change(id, !all); }, // all: a flagged project is one that is NOT in `cleared`
    clear(id, snap, dir) {
      retry();
      if (snap) {
        if (snap.gen !== (gens.get(id) ?? 0)) return; // a build file was named while the card was open
        if (snap.print !== undefined) {
          if (snap.print === 'unreadable' || (dir && buildFingerprint(dir) !== snap.print)) return; // changed while the card was open
          prints.set(id, snap.print);
        }
      }
      change(id, all);
      if (snap?.print !== undefined) save();
    },
  };
}
