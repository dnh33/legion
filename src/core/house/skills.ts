/**
 * Shipped skills, served to agents through `house_skills` and `house_skill` and nowhere else.
 *
 * A skill is a folder `skills/<group>/<name>/` holding a `SKILL.md` whose frontmatter has a `name` and a `description`
 * (the Agent Skills format). Legion vendors a handful, pinned and attributed in `skills/SOURCES.md`, and every one is OFF
 * until the owner switches it on (./switches.ts).
 *
 * What this module will not do:
 * - run anything. Legion never executes a skill's scripts; only `.md` files are read, and the sync does not even copy
 *   other file types. A skill is text an agent reads, not code Legion runs.
 * - grant anything. A skill is context like the rest of the house: it cannot widen an approval or authorise a spend.
 * - trust more than the bytes earn. Text is served through the same trust model as `house_read` (shipped and adopted
 *   bytes trusted, anything else wrapped). The one-line description in a LIST comes out of a file's own frontmatter, so
 *   for a skill whose bytes are no longer what Legion shipped the description is withheld from the list and the name is
 *   taken from the folder: an edited file does not get to write the first thing an agent reads about it unwrapped.
 */
import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { HOUSE_LIMITS, canonicalRel, listContext, normalisePath, resolveInside } from './context.js';
import { DESCRIPTION_CAP } from '../../shared/skill-ids.js';
import { isOn, keyOf, readSwitches, skillGroupOf, skillRootOf } from './switches.js';
import type { SwitchState } from './switches.js';
import { serveFile, trustKind } from './trust.js';
import type { TrustKind } from './trust.js';

export interface SkillInfo {
  /** The skill's name: from its frontmatter when the bytes are Legion's own, else the folder name. */
  name: string;
  /** The folder name under skills/<group>/. Always path-derived, never from the file's own text. */
  folder: string;
  group: string;
  /** One line. Empty for a skill whose bytes were edited (see the module comment). */
  description: string;
  /** Layer-relative path of the SKILL.md. */
  path: string;
  trust: TrustKind;
  enabled: boolean;
}

/** Top-level `key: value` pairs of a `---` frontmatter block. Handles quotes, `>` / `|` blocks and wrapped plain scalars. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  const indented = (l: string | undefined): boolean => l !== undefined && /^\s+\S/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const folded = v.startsWith('>');
      const parts: string[] = [];
      while (i + 1 < lines.length && (indented(lines[i + 1]) || lines[i + 1].trim() === '')) parts.push(lines[++i].trim());
      v = parts.join(folded ? ' ' : '\n').replace(/\s+$/, '');
    } else if (v === '') {
      // A nested map such as `metadata:`; its children are not top-level keys.
      while (i + 1 < lines.length && (indented(lines[i + 1]) || lines[i + 1].trim() === '')) i++;
    } else {
      while (indented(lines[i + 1])) v += ' ' + lines[++i].trim();
      const q = /^(["'])([\s\S]*)\1$/.exec(v);
      if (q) v = q[2];
    }
    out[kv[1]] = v;
  }
  return out;
}

const oneLine = (s: string, max = DESCRIPTION_CAP): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** Names shown to an agent in a sentence. A name with anything but plain characters is dropped, not escaped. */
const plainName = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._ -]{0,60}$/.test(s);

/** Every skill folder in the layer, whatever its switch says. The owner's screen and `listSkills` both build on this. */
export function allSkills(root: string, state: SwitchState = readSwitches(root)): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const f of listContext(root, { all: true }).files) {
    const rel = f.path;
    const m = /^skills\/([^/]+)\/([^/]+)\/SKILL\.md$/i.exec(rel);
    if (!m || f.bytes > HOUSE_LIMITS.maxFileBytes) continue;
    let fm: Record<string, string> = {};
    try {
      fm = parseFrontmatter(readFileSync(resolveInside(root, rel) ?? '', 'utf8'));
    } catch { /* unreadable: listed by folder name with no description */ }
    const trust = trustKind(root, rel);
    const own = trust !== 'untrusted';
    out.push({
      name: own && fm.name ? fm.name : m[2],
      folder: m[2],
      group: m[1],
      description: own ? oneLine(fm.description ?? '') : '',
      path: rel,
      trust,
      enabled: isOn(rel, state),
    });
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

/** Narrows the drills one agent sees (its own skills setting). Absent = every enabled drill. */
export type DrillFilter = (s: SkillInfo) => boolean;

/** The skills an agent may use right now: the enabled ones only, and only those its own setting lets through. */
export const listSkills = (root: string, allow?: DrillFilter): SkillInfo[] => allSkills(root).filter((s) => s.enabled && (!allow || allow(s)));

/** Names for the preamble line. Plain names only; nothing from a file's own text unless the bytes are Legion's own. */
export function enabledSkillNames(root: string, allow?: DrillFilter): string[] {
  return [...new Set(listSkills(root, allow).map((s) => s.name).filter(plainName))];
}

export type SkillOutcome =
  | { ok: true; path: string; text: string; clipped: boolean; trusted: boolean; kind: TrustKind }
  | { ok: false; message: string };

const NOT_AVAILABLE = (what: string): SkillOutcome => ({
  ok: false,
  message: `No enabled skill matches "${what}". Call house_skills for the skills you can use. A skill the owner has not switched on is not available.`,
});

/**
 * Loads one enabled skill. `nameOrPath` is a skill name, its folder name, the path of its SKILL.md, or the path of
 * another `.md` file inside an enabled skill's folder (a skill's own references).
 *
 * A skill that is off, a name nobody has and a path that goes nowhere all get the same answer, so an agent cannot probe
 * for skills the owner left off.
 */
export function readSkill(root: string, nameOrPath: string, allow?: DrillFilter): SkillOutcome {
  const asked = String(nameOrPath ?? '').trim();
  if (!asked) return NOT_AVAILABLE('');
  const state = readSwitches(root);
  const enabled = allSkills(root, state).filter((s) => s.enabled && (!allow || allow(s)));

  let rel: string | undefined;
  const looksLikePath = /[\\/]/.test(asked) || /\.md$/i.test(asked);
  if (looksLikePath) {
    const abs = resolveInside(root, asked);
    if (!abs) return NOT_AVAILABLE(asked);
    let real: string | null;
    try {
      if (!statSync(abs).isFile()) return NOT_AVAILABLE(asked);
      real = canonicalRel(root, abs);
    } catch {
      return NOT_AVAILABLE(asked);
    }
    if (real === null) return NOT_AVAILABLE(asked);
    const home = skillRootOf(real);
    if (!home || !/\.md$/i.test(real) || !enabled.some((s) => keyOf(s.path) === keyOf(home))) return NOT_AVAILABLE(asked);
    rel = real;
  } else {
    const k = asked.toLowerCase();
    const hits = enabled.filter((s) => s.name.toLowerCase() === k || s.folder.toLowerCase() === k);
    if (hits.length > 1) {
      return { ok: false, message: `More than one enabled skill is called "${asked}". Load it by path: ${hits.map((h) => h.path).join(', ')}.` };
    }
    rel = hits[0]?.path;
  }
  if (!rel) return NOT_AVAILABLE(asked);

  const abs = resolveInside(root, rel);
  if (!abs) return NOT_AVAILABLE(asked);
  try {
    if (statSync(abs).size > HOUSE_LIMITS.maxFileBytes) {
      return { ok: false, message: `That skill file is over the ${HOUSE_LIMITS.maxFileBytes} byte cap, so it is not served.` };
    }
  } catch {
    return NOT_AVAILABLE(asked);
  }
  let body: string;
  try {
    body = readFileSync(abs, 'utf8');
  } catch (err) {
    return { ok: false, message: `Could not read that skill: ${err instanceof Error ? err.message : String(err)}` };
  }
  const served = serveFile(root, rel, body);
  const clipped = served.text.length > HOUSE_LIMITS.toolResultChars;
  return {
    ok: true,
    path: rel,
    text: clipped ? served.text.slice(0, HOUSE_LIMITS.toolResultChars) : served.text,
    clipped,
    trusted: served.trusted,
    kind: served.kind,
  };
}

/** The group of a skill file for the owner's screen (re-exported so index.ts needs only this module for skills). */
export { skillGroupOf, skillRootOf };
