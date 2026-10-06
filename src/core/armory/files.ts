/**
 * Writing and importing SKILL.md files for the Armory. Pure text work: nothing here touches the disk or the network.
 *
 * What Legion refuses to carry over from a skill it did not write, and why. Claude Code does not call canUseTool for a
 * Skill load, so anything a SKILL.md can switch on runs without an approval card:
 * - `allowed-tools`, `disallowed-tools`: pre-approve or remove tools for the turn. Stripped.
 * - `hooks`: registers hooks for the rest of the session. Stripped.
 * - `context`, `agent`, `background`, `shell`: run the skill in a forked sub-agent or pick its shell. Stripped.
 * - an inline bang-backtick command and a fenced bang block in the body: Claude Code runs them before the model sees
 *   the text. Refused outright.
 * Only `.md` files are kept; Legion never runs a script. (Source: https://code.claude.com/docs/en/skills)
 */
import { parseFrontmatter } from '../house/skills.js';
import { SKILL_NAME_RE } from '../../shared/skill-ids.js';

export const ARMORY_LIMITS = {
  maxFiles: 200,
  maxTotalBytes: 1_000_000,
  maxFileBytes: 512_000,
  maxDescription: 500,
  maxWhenToUse: 500,
  maxBody: 200_000,
} as const;

/** Frontmatter keys an imported skill never keeps. */
export const STRIPPED_KEYS = ['allowed-tools', 'disallowed-tools', 'hooks', 'context', 'agent', 'background', 'shell'] as const;

export class ArmoryInputError extends Error {
  constructor(message: string, public readonly status = 400, /** What was already set aside when the import was refused, so a review can still show it. */ public readonly dropped: { path: string; reason: string }[] = []) {
    super(message); this.name = 'ArmoryInputError';
  }
}

/** One hidden or direction-changing character kind found in a file: what, where and how many times. */
export interface HiddenChar { file: string; codepoint: string; count: number }

// Zero-width and direction marks (U+200B..U+200F), bidi embeddings and overrides (U+202A..U+202E), bidi isolates (U+2066..U+2069),
// the byte order mark (U+FEFF) and the soft hyphen (U+00AD). They can make text read differently to a person than to a model.
const HIDDEN_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g;

/**
 * The one hidden-text detector, shared by the import review and the catalog. A BOM at the very start of a file is a normal file marker
 * and is not counted. Nothing is stripped: the caller shows what was found.
 */
export function findHiddenChars(file: string, text: string): HiddenChar[] {
  const counts = new Map<string, number>();
  for (const m of String(text ?? '').matchAll(HIDDEN_RE)) {
    if (m[0] === '\uFEFF' && m.index === 0) continue;
    const cp = 'U+' + m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    counts.set(cp, (counts.get(cp) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([codepoint, count]) => ({ file, codepoint, count }));
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The text of a SKILL.md Legion writes for the owner. The description is a folded block, so any character is safe in it. */
export function buildSkillMd(p: { name: string; description: string; whenToUse?: string; body: string }): string {
  if (!SKILL_NAME_RE.test(p.name)) throw new ArmoryInputError('name must be 1 to 64 characters: lower case letters, digits and hyphens.');
  const desc = flat(p.description ?? '');
  if (!desc) throw new ArmoryInputError('description is required: it is the line an agent reads to decide whether to load the skill.');
  if (desc.length > ARMORY_LIMITS.maxDescription) throw new ArmoryInputError(`description is over ${ARMORY_LIMITS.maxDescription} characters.`);
  const when = flat(p.whenToUse ?? '');
  if (when.length > ARMORY_LIMITS.maxWhenToUse) throw new ArmoryInputError(`whenToUse is over ${ARMORY_LIMITS.maxWhenToUse} characters.`);
  const body = String(p.body ?? '');
  if (!body.trim()) throw new ArmoryInputError('body is required.');
  if (body.length > ARMORY_LIMITS.maxBody) throw new ArmoryInputError(`body is over ${ARMORY_LIMITS.maxBody} characters.`);
  const line = when ? `${desc} Use when: ${when}` : desc;
  return `---\nname: ${p.name}\ndescription: >-\n  ${line}\n---\n\n${body.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
}

/** True when the text holds Claude Code's shell preprocessing: an inline bang-backtick command or a fenced bang block. */
export function hasShellPreprocessing(text: string): boolean {
  // The fenced form is Claude Code's own regex (not anchored to a line start: ```! may follow any text). The inline form and the tilde
  // fence are kept broader than the CLI on purpose: a false positive only blocks an import, a false negative runs a command.
  return CLI_FENCED_BANG.test(text) || /(^|[\s(>*_-])!`/.test(text) || /^[ \t]*~{3,}[ \t]*!/m.test(text);
}
const CLI_FENCED_BANG = /```!\s*\n?[\s\S]*?\n?```/;

const TOP_KEY = /^([A-Za-z_][\w-]*):/;
const FM_BLOCK = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;

/** Removes the named top-level keys from a frontmatter block, with their indented, list and blank continuation lines. */
export function stripFrontmatterKeys(text: string, keys: readonly string[]): { text: string; removed: string[] } {
  const m = FM_BLOCK.exec(text);
  if (!m) return { text, removed: [] };
  const drop = new Set(keys.map((k) => k.toLowerCase()));
  const removed: string[] = [];
  const out: string[] = [];
  let skipping = false;
  for (const line of m[2].split(/\r?\n/)) {
    const k = TOP_KEY.exec(line);
    if (k) {
      skipping = drop.has(k[1].toLowerCase());
      if (skipping && !removed.includes(k[1])) removed.push(k[1]);
    }
    if (!skipping) out.push(line);
  }
  return { text: text.slice(0, m.index) + m[1] + out.join('\n') + m[3] + text.slice(m.index + m[0].length), removed };
}

/** The frontmatter keys an imported or delivered skill keeps. Everything else is dropped and reported (an allowlist, never a denylist). */
export const ALLOWED_KEYS = ['name', 'description', 'when_to_use', 'argument-hint', 'disable-model-invocation', 'user-invocable', 'license', 'metadata'] as const;
const BOOL_KEYS = new Set(['disable-model-invocation', 'user-invocable']);

export interface SanitizedSkill {
  ok: true;
  /** The SKILL.md Legion delivers: a header regenerated from the allowlist, then the body unchanged. */
  text: string;
  name: string;
  description: string;
  manualOnly: boolean;
  /** Keys of the original header that were not kept (or could not be kept), for the review. */
  dropped: string[];
  body: string;
}
export interface RefusedSkill { ok: false; reason: string }

const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*)|[ \t]*)$/;
const FM_OPEN = /^﻿?---[ \t]*\r?\n/;
const YAML_SPECIAL = /^[[{&*!|>%@`]/;

function unquote(v: string): string | null {
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) return null;
    try { const r: unknown = JSON.parse(v); return typeof r === 'string' ? r : null; } catch { return null; }
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) return null;
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v.replace(/\s+#.*$/, '').trim();
}

/**
 * Reads a SKILL.md header with a strict parser (no YAML library is a dependency of Legion). It accepts only `key: value` lines at
 * column 0 whose key is a bare word, with a plain or quoted one-line value, a `>` / `|` block scalar, or an indented continuation.
 * Anything else (a quoted key, a space before the colon, a tab, a duplicate key, a flow or anchor line, a stray line) REFUSES the
 * whole header, because a parser that reads it differently from Claude Code could hide a key from this review.
 * Then it keeps only ALLOWED_KEYS and writes the header again from them.
 */
export function sanitizeSkillMd(raw: string, set?: { name?: string }): SanitizedSkill | RefusedSkill {
  const text = raw.replace(/^﻿/, '');
  const open = FM_OPEN.exec(text);
  if (!open) return { ok: false, reason: 'There is no frontmatter: the file must start with a --- line, the header, and a closing --- line.' };
  const rest = text.slice(open[0].length);
  const close = /(^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!close) return { ok: false, reason: 'The frontmatter has no closing --- line.' };
  const head = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  const lines = head.length ? head.split(/\r?\n/) : [];
  const entries: { key: string; value: string; block: string[] }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (/^[ \t]*\t/.test(line)) return { ok: false, reason: 'The frontmatter uses a tab to indent, which Legion cannot read safely.' };
    const m = KEY_LINE.exec(line);
    if (!m) return { ok: false, reason: `The frontmatter line ${JSON.stringify(line.slice(0, 60))} is not a plain "key: value" line (quoted keys, a space before the colon, lists and flow syntax are not accepted).` };
    const key = m[1]!;
    if (seen.has(key)) return { ok: false, reason: `The frontmatter has the key ${key} twice.` };
    seen.add(key);
    const block: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1]!.trim() === '' || /^ +\S/.test(lines[i + 1]!))) block.push(lines[++i]!);
    entries.push({ key, value: (m[2] ?? '').trim(), block });
  }
  const dropped: string[] = [];
  const out: Record<string, string | boolean | Record<string, string>> = {};
  for (const e of entries) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(e.key)) { dropped.push(e.key); continue; }
    if (e.key === 'metadata') {
      const md: Record<string, string> = {};
      let good = e.value === '' && e.block.some((l) => l.trim());
      for (const l of e.block) {
        if (!l.trim()) continue;
        const kv = /^ +([A-Za-z][\w.-]*):[ \t]+(.*)$/.exec(l);
        const v = kv ? unquote(kv[2]!.trim()) : null;
        if (!kv || v === null || YAML_SPECIAL.test(v)) { good = false; break; }
        md[kv[1]!] = v;
      }
      if (good) out.metadata = md; else dropped.push('metadata');
      continue;
    }
    let v: string;
    if (/^[>|][+-]?$/.test(e.value)) {
      v = e.block.map((l) => l.trim()).join(e.value.startsWith('>') ? ' ' : '\n').replace(/\s+$/, '');
    } else if (e.value === '') {
      if (e.block.some((l) => l.trim())) return { ok: false, reason: `The key ${e.key} holds a nested block, which only metadata may.` };
      v = '';
    } else {
      const u = unquote(e.value);
      if (u === null || (YAML_SPECIAL.test(u) && !/^["']/.test(e.value))) return { ok: false, reason: `The value of ${e.key} uses YAML syntax Legion does not accept (a flow list or map, an anchor or a tag).` };
      v = [u, ...e.block.map((l) => l.trim())].filter((x) => x !== '').join(' ');
    }
    if (BOOL_KEYS.has(e.key)) {
      const b = v.trim().toLowerCase();
      if (b !== 'true' && b !== 'false') { dropped.push(e.key); continue; }
      out[e.key] = b === 'true';
    } else {
      out[e.key] = flat(v);
    }
  }
  const description = typeof out.description === 'string' ? out.description : '';
  const name = typeof out.name === 'string' ? out.name : '';
  if (set?.name !== undefined) out.name = set.name;
  return { ok: true, text: renderHeader(out) + (body.startsWith('\n') || body === '' ? body : '\n' + body), name, description, manualOnly: out['disable-model-invocation'] === true, dropped, body };
}

/** Writes the header: JSON strings are valid YAML, and a run of dashes is split so it cannot close the header early in any reader. */
function renderHeader(o: Record<string, string | boolean | Record<string, string>>): string {
  // a plain value where one is safe (it reads best and the screen shows it), a JSON string (valid YAML) for anything else
  const q = (raw: string): string => {
    const s = raw.replace(/-{3,}/g, (d) => d.split('').join(' '));
    const plain = /^[A-Za-z0-9][^\n"\\`{}[\]&*!|>%@#]*$/.test(s) && !/: |:$|\s$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !/^[\d.+-]+$/.test(s);
    return plain ? s : JSON.stringify(s);
  };
  const lines: string[] = [];
  for (const k of ALLOWED_KEYS) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v === 'boolean') lines.push(`${k}: ${v}`);
    else if (typeof v === 'string') lines.push(`${k}: ${q(v)}`);
    else lines.push(`${k}:`, ...Object.entries(v).map(([a, b]) => `  ${a}: ${q(b)}`));
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

/** A relative path from a request, forward slashes, or null when it could leave the folder or is not plain. */
export function cleanRelPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const raw = p.replace(/\\/g, '/').trim();
  if (!raw || raw.includes('\0') || raw.includes(':') || raw.startsWith('/')) return null;
  const parts = raw.split('/').filter((x) => x !== '' && x !== '.');
  if (!parts.length || parts.some((x) => x === '..')) return null;
  return parts.join('/');
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

export interface PreparedImport {
  name: string;
  /** The frontmatter description (what an agent reads to decide whether to load the skill). */
  description: string;
  /** Path under the skill folder -> text. SKILL.md is always present. */
  files: Record<string, string>;
  dropped: { path: string; reason: string }[];
  stripped: string[];
  /** Hidden or direction-changing characters in the kept .md files. Reported, never stripped. */
  hiddenChars: HiddenChar[];
}

/** What a dry run answers: the review of an import, with nothing written. `ok: false` carries the refusal in plain words. */
export interface ImportReview {
  ok: boolean;
  refusal: string;
  name: string;
  /** The Armory id the skill would get (set by the route, which owns the id rule). */
  id: string;
  description: string;
  /** Paths under the skill folder that would be written, sorted. */
  kept: string[];
  dropped: { path: string; reason: string }[];
  /** Frontmatter keys that would be removed. */
  stripped: string[];
  /** The SKILL.md as it would be written (stripped keys gone), for the rendered preview. */
  skillText: string;
  /** Hidden or direction-changing characters in the kept .md files (SKILL.md and references). Reported, never stripped. */
  hiddenChars: HiddenChar[];
}

/**
 * Validates what the UI read from disk and turns it into the one skill folder Legion will write. Throws ArmoryInputError.
 * A list entry is `{path, text}`, or `{path, size, text: null}` for a file the screen chose not to read (not a .md file, or too big):
 * such an entry is never written, it is listed as dropped, so the screen need not send bytes that would be thrown away.
 */
export function prepareImport(input: unknown): PreparedImport {
  const list = input && typeof input === 'object' ? (input as { files?: unknown }).files : undefined;
  if (!Array.isArray(list) || !list.length) throw new ArmoryInputError('files is required: a list of {path, text}.');
  if (list.length > ARMORY_LIMITS.maxFiles) throw new ArmoryInputError(`That is ${list.length} files; the limit is ${ARMORY_LIMITS.maxFiles}.`);
  let total = 0;
  const entries: { path: string; text: string | null; size: number }[] = [];
  for (const f of list) {
    const o = f && typeof f === 'object' ? f as { path?: unknown; text?: unknown; size?: unknown } : {};
    const path = cleanRelPath(o.path);
    if (!path) throw new ArmoryInputError(`Refused the path ${JSON.stringify(typeof o.path === 'string' ? o.path.slice(0, 80) : o.path)}: a skill file must have a plain relative path.`);
    if (o.text === null && typeof o.size === 'number' && Number.isFinite(o.size) && o.size >= 0) {
      entries.push({ path, text: null, size: o.size });
      continue;
    }
    if (typeof o.text !== 'string') throw new ArmoryInputError(`${path}: text must be a string.`);
    const size = Buffer.byteLength(o.text, 'utf8');
    total += size;
    if (total > ARMORY_LIMITS.maxTotalBytes) throw new ArmoryInputError(`The files are over ${ARMORY_LIMITS.maxTotalBytes} bytes in total.`);
    entries.push({ path, text: o.text, size });
  }
  const skillMds = entries.filter((e) => /(^|\/)SKILL\.md$/i.test(e.path));
  if (skillMds.length !== 1) throw new ArmoryInputError(skillMds.length ? 'More than one SKILL.md was given. Import one skill at a time.' : 'There is no SKILL.md in what was given.');
  const skillPath = skillMds[0].path;
  const dir = skillPath.includes('/') ? skillPath.slice(0, skillPath.lastIndexOf('/')) : '';
  const dropped: PreparedImport['dropped'] = [];
  const files: Record<string, string> = {};
  for (const e of entries) {
    if (dir && !e.path.startsWith(dir + '/')) { dropped.push({ path: e.path, reason: 'outside the skill folder' }); continue; }
    const rel = dir ? e.path.slice(dir.length + 1) : e.path;
    if (!/\.md$/i.test(rel)) { dropped.push({ path: e.path, reason: 'not a .md file (Legion never runs scripts)' }); continue; }
    if (e.size > ARMORY_LIMITS.maxFileBytes) { dropped.push({ path: e.path, reason: `over ${ARMORY_LIMITS.maxFileBytes} bytes` }); continue; }
    if (e.text === null) { dropped.push({ path: e.path, reason: 'not sent' }); continue; }
    files[/^SKILL\.md$/i.test(rel) ? 'SKILL.md' : rel] = e.text;
  }
  const raw = files['SKILL.md'];
  if (raw === undefined) throw new ArmoryInputError(dropped.some((d) => d.path === skillPath && d.reason === 'not sent') ? 'SKILL.md was not sent.' : 'SKILL.md is over the size limit.', 400, dropped);
  const first = sanitizeSkillMd(raw);
  if (!first.ok) {
    if (/^There is no frontmatter/.test(first.reason)) throw new ArmoryInputError('SKILL.md needs a description in its frontmatter (the lines between --- at the top).', 400, dropped);
    throw new ArmoryInputError(`SKILL.md was refused: ${first.reason}`, 400, dropped);
  }
  if (!first.description.trim()) throw new ArmoryInputError('SKILL.md needs a description in its frontmatter (the lines between --- at the top).', 400, dropped);
  if (hasShellPreprocessing(raw)) {
    throw new ArmoryInputError('This skill runs shell commands while it loads (a bang-backtick command or a fenced bang block). Legion does not import skills that do that.', 400, dropped);
  }
  const folder = dir.split('/').pop() ?? '';
  const name = SKILL_NAME_RE.test(first.name) ? first.name : slug(folder) || slug(first.name);
  if (!SKILL_NAME_RE.test(name)) throw new ArmoryInputError('Could not make a skill name from this. The name must be lower case letters, digits and hyphens.', 400, dropped);
  // the folder name is the id, so the frontmatter name must not disagree with it
  const final = sanitizeSkillMd(raw, { name });
  if (!final.ok) throw new ArmoryInputError(`SKILL.md was refused: ${final.reason}`, 400, dropped);
  files['SKILL.md'] = final.text;
  const hiddenChars = Object.entries(files).flatMap(([path, text]) => findHiddenChars(path, path === 'SKILL.md' ? raw : text));
  return { name, description: flat(first.description), files, dropped, stripped: final.dropped, hiddenChars };
}

/** The dry run: the same checks as the import, as an answer instead of a throw. Writes nothing. */
export function reviewImport(input: unknown): ImportReview {
  try {
    const p = prepareImport(input);
    return { ok: true, refusal: '', name: p.name, id: '', description: p.description, kept: Object.keys(p.files).sort(), dropped: p.dropped, stripped: p.stripped, skillText: p.files['SKILL.md']!, hiddenChars: p.hiddenChars };
  } catch (e) {
    if (e instanceof ArmoryInputError) return { ok: false, refusal: e.message, name: '', id: '', description: '', kept: [], dropped: e.dropped, stripped: [], skillText: '', hiddenChars: [] };
    throw e;
  }
}
