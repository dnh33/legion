/**
 * Which house files an agent is allowed to see: the owner's on/off switches.
 *
 * A switch is a SERVING filter, not a deletion. `syncContext` still copies every shipped file; a switched-off file is
 * simply invisible to agents (not listed, not readable, never returned by recall), exactly as if it were absent. That
 * keeps a later sync, an upgrade and a re-enable all trivially safe: nothing was ever removed.
 *
 * Defaults, set by the owner on 2026-10-06:
 * - every rule is ON, except
 * - every skill, which is OFF. Skills from Legion are opinionated, so each user opts in to the ones they want.
 * - the core rules (AGENTS.md, CONTEXT.md) are LOCKED on. They are the index every agent reads first.
 *
 * ## Where the state lives
 *
 * `<dataDir>/.house-switches.json`: one level ABOVE the layer, next to `.adopted.json`, for the same reason as ADR 0011.
 * The layer is content agents read; the data directory is the app's own state, and the owner's choices are app state. It
 * is changed through admin routes only (see index.ts) and no tool writes it. As ADR 0011 says plainly about adoption,
 * this is defence in depth and not a wall: an agent that runs as the same OS user and knows the layout can write any
 * file under `~/.legion`. The damage a forged switch can do is bounded, because whatever it turns on is still served
 * through the trust model (shipped bytes trusted, anything else wrapped) and still taints the run.
 *
 * ## Matching is by real name, lower-cased
 *
 * Windows and macOS file systems are case-insensitive, so `skills/G/N/skill.md` reaches the same file as
 * `skills/g/n/SKILL.md`. Every comparison here goes through `keyOf`, and the read paths canonicalise the path against
 * the real file system first (see `canonicalRel` in context.ts), so a differently-cased request cannot slip past a
 * switch.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SWITCHES_NAME = '.house-switches.json';

/** Where the switch state lives: the data directory, one level above the layer. `root` is the layer. */
export const switchesPath = (root: string): string => join(dirname(root), SWITCHES_NAME);

export type HouseCategory = 'core' | 'skills' | 'decisions' | 'built' | 'history' | 'facts' | 'yours';

export const CATEGORIES: readonly HouseCategory[] = ['core', 'skills', 'decisions', 'built', 'history', 'facts', 'yours'];

export interface SwitchState {
  version: 1;
  /** Layer-relative paths of rules switched off. */
  off: string[];
  /** Layer-relative SKILL.md paths of skills switched on. */
  on: string[];
}

const norm = (p: string): string => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
/** The comparison form of a path: forward slashes, lower case. */
export const keyOf = (p: string): string => norm(p).toLowerCase();

const CORE = new Set(['agents.md', 'context.md']);
const BUILT = new Set(['docs/architecture.md', 'docs/testing.md', 'docs/versioning.md']);
const HISTORY = new Set(['docs/release-notes.md', 'docs/session-log.md']);

/** The group a file belongs to in the owner's screen. By path alone, so it never needs the file to exist. */
export function categoryOf(path: string): HouseCategory {
  const k = keyOf(path);
  if (CORE.has(k)) return 'core';
  if (k.startsWith('skills/')) return 'skills';
  if (k.startsWith('docs/adr/')) return 'decisions';
  if (BUILT.has(k)) return 'built';
  if (HISTORY.has(k)) return 'history';
  if (k.startsWith('context/')) return 'facts';
  return 'yours';
}

/** Locked-on files: the owner cannot switch them off, at the route or anywhere else. */
export const isLocked = (path: string): boolean => categoryOf(path) === 'core';

/** `skills/<group>/<name>/...`: a file that belongs to one skill folder. */
const SKILL_FILE = /^skills\/([^/]+)\/([^/]+)\/.+/i;

/** The `<group>` segment of a path under skills/, or undefined for anything else (also for `skills/x.md`). */
export function skillGroupOf(path: string): string | undefined {
  const p = norm(path);
  const m = /^skills\/([^/]+)\/.+/i.exec(p);
  return m ? m[1] : undefined;
}

/** The SKILL.md that the file belongs to (itself, or the SKILL.md of its folder), or undefined when it is in no skill. */
export function skillRootOf(path: string): string | undefined {
  const p = norm(path);
  const m = SKILL_FILE.exec(p);
  return m ? `skills/${m[1]}/${m[2]}/SKILL.md` : undefined;
}

/** A well-formed switch state, or the defaults. Never throws. */
export function readSwitches(root: string): SwitchState {
  const fresh = (): SwitchState => ({ version: 1, off: [], on: [] });
  try {
    const parsed: unknown = JSON.parse(readFileSync(switchesPath(root), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fresh();
    const o = parsed as Record<string, unknown>;
    if (o.version !== 1) return fresh();
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(norm) : []);
    return { version: 1, off: list(o.off), on: list(o.on) };
  } catch {
    return fresh();
  }
}

/** Atomic: a crash mid-write leaves the old file, never half a JSON document (which would silently reset every choice). */
export function writeSwitches(root: string, state: SwitchState): void {
  const target = switchesPath(root);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, off: state.off, on: state.on }, null, 2));
    renameSync(tmp, target);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* leave it */ }
    throw err;
  }
}

/**
 * Whether the owner has this file switched on right now.
 *
 * A skill is on only if it is in `on` (checked by the SKILL.md of its folder, so a reference file follows its skill).
 * Everything else is on unless it is in `off`. Locked files are always on, whatever the file says.
 */
export function isOn(path: string, state: SwitchState): boolean {
  if (isLocked(path)) return true;
  const k = keyOf(path);
  if (categoryOf(path) === 'skills') {
    const skill = skillRootOf(path);
    if (!skill) return false; // skills/SOURCES.md and friends belong to no skill, so there is nothing to switch on
    const sk = keyOf(skill);
    return state.on.some((p) => keyOf(p) === sk);
  }
  return !state.off.some((p) => keyOf(p) === k);
}

/** Records one switch. The path is already validated by the caller (exists, not locked-off). Returns the new state. */
export function setSwitch(root: string, path: string, on: boolean): SwitchState {
  const state = readSwitches(root);
  const p = norm(path);
  const k = keyOf(p);
  const without = (list: string[]): string[] => list.filter((x) => keyOf(x) !== k);
  if (categoryOf(p) === 'skills') {
    state.on = on ? [...without(state.on), p] : without(state.on);
  } else {
    state.off = on ? without(state.off) : [...without(state.off), p];
  }
  writeSwitches(root, state);
  return state;
}

/** Puts a category, or one skill group, back to its defaults. Returns how many entries it removed. */
export function resetSwitches(root: string, scope: { category?: HouseCategory; group?: string }): number {
  const state = readSwitches(root);
  const before = state.off.length + state.on.length;
  if (scope.group !== undefined) {
    const g = scope.group.toLowerCase();
    state.on = state.on.filter((p) => (skillGroupOf(p) ?? '').toLowerCase() !== g);
  } else if (scope.category) {
    const c = scope.category;
    state.off = state.off.filter((p) => categoryOf(p) !== c);
    if (c === 'skills') state.on = [];
  }
  const removed = before - (state.off.length + state.on.length);
  if (removed > 0) writeSwitches(root, state);
  return removed;
}
