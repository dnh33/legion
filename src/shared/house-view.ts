/**
 * What Settings → Doctrine shows, as pure functions over the one answer of GET /api/house.
 *
 * Shared (like bsv-view.ts) so the screen and the tests use the same grouping, order, labels and counts. Nothing here
 * calls the core or touches the DOM. The core decides what is on (`on`) and what is locked; this module only arranges it.
 */

export type HouseTrust = 'shipped' | 'adopted' | 'untrusted';
export type HouseCategory = 'core' | 'skills' | 'decisions' | 'built' | 'history' | 'facts' | 'yours';

/** One file of GET /api/house. */
export interface HouseFileView {
  path: string;
  bytes: number;
  trust: HouseTrust;
  category: HouseCategory;
  title: string;
  /** Whether agents are served this file right now. A reference file of a skill follows its skill. */
  on: boolean;
  locked: boolean;
  /** Skills only: the folder under skills/, e.g. `verify-debug`. */
  group?: string | null;
  /** Skills only: the SKILL.md this file belongs to, or null for skills/README.md and skills/SOURCES.md. */
  skill?: string | null;
  /** Only on a SKILL.md. */
  description?: string;
}

/** `title` is the themed name, `hint` the plain words shown beside it, always (no guessing what a name means). */
export interface GroupInfo { category: HouseCategory; title: string; hint: string; blurb: string }

/** The owner's order. */
export const GROUPS: readonly GroupInfo[] = [
  { category: 'core', title: 'Core tenets', hint: 'always on', blurb: 'Every agent reads these first. They stay on, and you cannot switch them off.' },
  { category: 'skills', title: 'Drills', hint: 'skills agents can use · off by default', blurb: 'Step-by-step ways of working. An agent opens one only when its job calls for it.' },
  { category: 'built', title: 'Foundations', hint: 'how Legion is built · on by default', blurb: 'Architecture, testing and versioning notes.' },
  { category: 'decisions', title: 'Decrees', hint: 'decisions on record · on by default', blurb: 'Why Legion works the way it does, one record per decision.' },
  { category: 'history', title: 'Chronicle', hint: 'release history · on by default', blurb: 'Release notes and the session log.' },
  { category: 'facts', title: 'Lore', hint: 'facts and data · on by default', blurb: 'Reference facts about the project.' },
  { category: 'yours', title: 'Your orders', hint: 'files you added · on by default', blurb: 'Files you added. Agents read them as material until you approve them.' },
];

/** The hint without its "· on by default" tail: the words a search should match on. */
const plainHint = (info: GroupInfo): string => info.hint.split(' · ')[0]!;

export const LOCK_REASON = 'A core rule. Every agent reads it first, so it stays on and cannot be switched off.';
export const SKILLS_BANNER = 'Skills from Legion are off until you turn them on. Each skill changes how agents work.';

/** Friendly names and one-line summaries for the skill folders Legion ships. Anything else gets its own name. */
const SKILL_GROUPS: Record<string, { title: string; summary: string }> = {
  'verify-debug': { title: 'Verify and debug', summary: 'Find the cause before fixing, and check before saying done.' },
  'ci-github': { title: 'CI and GitHub', summary: 'Fix failing checks and tighten GitHub Actions.' },
  review: { title: 'Review', summary: 'Ask for a code review and handle the feedback.' },
};
const SKILL_GROUP_ORDER = ['verify-debug', 'ci-github', 'review'];

const titleCase = (s: string): string => s.replace(/[-_]+/g, ' ').trim().replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));

export function skillGroupTitle(group: string): string {
  return SKILL_GROUPS[group.toLowerCase()]?.title ?? (titleCase(group) || 'Other');
}
/** The disclosure button's accessible name: the group and its count, with the summary left to aria-describedby. */
export const skillGroupLabel = (sg: Pick<SkillGroupView, 'title' | 'countLine'>, forced = false): string =>
  `${sg.title}, ${sg.countLine}${forced ? ', showing matches' : ''}`;

/** Words that are not title-cased by the plain rule. Keys are lower case. */
const ACRONYMS: Record<string, string> = { ci: 'CI', cd: 'CD', github: 'GitHub', pr: 'PR', api: 'API', mcp: 'MCP', ui: 'UI', ai: 'AI', json: 'JSON', sha: 'SHA' };

/** "fix-red-ci" -> "Fix red CI", "harden-github-actions" -> "Harden GitHub actions". Only the first word is capitalised. */
export function humaniseSkillName(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.map((w, i) => ACRONYMS[w.toLowerCase()] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
    // "GitHub Actions" is a product name, so both words keep their capitals.
    .replace(/\bGitHub actions\b/g, 'GitHub Actions');
}

/** Ends a message with a full stop unless it already ends in one of . ! ? … so it can be followed by another sentence. */
export function endSentence(message: string): string {
  const m = String(message ?? '').trim();
  if (!m) return 'Something went wrong.';
  return /[.!?…]["')\]”’]*$/.test(m) ? m : `${m}.`;
}

/** A title as plain words: backticks, emphasis marks and link syntax removed. */
export function cleanTitle(raw: string): string {
  return String(raw ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "ADR 0004 — x", "0011 — x" and a bare title all become "ADR 0004: x" (the number from the title, else the file name). */
function adrTitle(path: string, title: string): string {
  const num = /(?:^|\/)(\d{4})-[^/]*$/.exec(path)?.[1];
  const m = /^(?:ADR\s*)?(\d{3,4})\s*[—–:-]\s*(.*)$/i.exec(title);
  if (m) return `ADR ${m[1]!.padStart(4, '0')}: ${m[2]}`;
  return num ? `ADR ${num}: ${title}` : title;
}

/** "AGENTS.md — Agent rules" -> "Agent rules": the file name is already shown as the path, so the title does not repeat it. */
function stripFileName(path: string, title: string): string {
  const name = path.split('/').pop() ?? path;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rest = title.replace(new RegExp(`^${esc}\\s*[—–:-]\\s*`, 'i'), '');
  if (!rest || rest === title) return title;
  // "AGENTS.md — working on Legion" leaves a lower-case fragment; as a title on its own it starts with a capital.
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** The mono path line is dropped when the title already is the path (a row would otherwise say the same thing twice). */
export const pathIsRedundant = (path: string, label: string): boolean => label.trim().toLowerCase() === path.trim().toLowerCase();

/** What a file row and its search call the file: plain words, and decisions always as "ADR NNNN: title". */
export function displayTitle(f: Pick<HouseFileView, 'path' | 'title'> & { category?: HouseCategory }): string {
  if (/\/SKILL\.md$/i.test(f.path)) return skillDisplayTitle(f);
  const t = stripFileName(f.path, cleanTitle(f.title));
  return (f.category === 'decisions' || /^docs\/adr\//i.test(f.path)) ? adrTitle(f.path, t) : t;
}

/** The dialog drops a first `# Title` line that only repeats the dialog's own title. */
export function dropLeadingTitle(body: string, title: string): string {
  const m = /^\s*#[ \t]+([^\n]*)\n?/.exec(body);
  if (!m) return body;
  const norm = (x: string): string => cleanTitle(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(m[1]!) === norm(title) ? body.slice(m[0].length).replace(/^\s+/, '') : body;
}

/** The folder name of a SKILL.md path: `skills/ci-github/fix-red-ci/SKILL.md` -> `fix-red-ci`. */
const skillFolder = (path: string): string => path.split('/').slice(-2, -1)[0] ?? path;

/** What a skill row and its dialog call the skill: a readable form of the folder name, not the raw slug. */
export const skillDisplayTitle = (f: Pick<HouseFileView, 'path' | 'title'>): string =>
  /\/SKILL\.md$/i.test(f.path) ? humaniseSkillName(skillFolder(f.path) || f.title) : cleanTitle(f.title);

export interface SkillText {
  /** The text after the frontmatter. The whole text when there is no frontmatter. */
  body: string;
  /** Header facts from the frontmatter, each empty when absent. */
  name: string;
  licence: string;
  source: string;
  /** First 7 characters of the pinned commit. */
  commit: string;
}

/** Splits a skill's text into the frontmatter facts the dialog shows as one line, and the markdown body it renders. */
export function parseSkillText(text: string): SkillText {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { body: text, name: '', licence: '', source: '', commit: '' };
  const fm = m[1]!;
  const unquote = (v: string): string => v.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  // A top-level `key: value` line.
  const top = (k: string): string => unquote(new RegExp(String.raw`^${k}:[ \t]*(.*)$`, 'm').exec(fm)?.[1] ?? '');
  // A value inside the one-line `metadata: { source: "...", commit: ... }` map (or a nested block): quoted or bare.
  const meta = (k: string): string => unquote(new RegExp(String.raw`\b${k}:[ \t]*("[^"]*"|'[^']*'|[^,}\s]+)`).exec(fm)?.[1] ?? '');
  const commit = meta('commit');
  const source = meta('source');
  return {
    body: text.slice(m[0].length).replace(/^\s+/, ''),
    name: top('name'),
    licence: top('license') || top('licence'),
    source: /^https?:\/\//i.test(source) ? source : '',
    commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7) : '',
  };
}

export function skillGroupSummary(group: string, total: number): string {
  return SKILL_GROUPS[group.toLowerCase()]?.summary ?? `${total} ${total === 1 ? 'skill' : 'skills'}.`;
}

/** "From Legion", "Edited" (a shipped file that no longer matches), "Approved by you", or "Not approved" for your own files. */
export function trustLabel(f: Pick<HouseFileView, 'trust' | 'category'>): string {
  if (f.trust === 'shipped') return 'From Legion';
  if (f.trust === 'adopted') return 'Approved by you';
  return f.category === 'yours' ? 'Not approved' : 'Edited';
}
export function trustBlurb(f: Pick<HouseFileView, 'trust' | 'category'> & { on?: boolean }): string {
  if (f.category === 'skills' && f.on !== undefined) {
    // A skill's state comes first: an off skill is not shown to agents at all, so "agents read it as rules" would be false.
    const state = f.on ? 'On: agents can open this skill.' : 'Off: agents are not shown this skill.';
    if (f.trust === 'shipped') return `${state} It ships with Legion, unchanged.`;
    if (f.trust === 'adopted') return `${state} You approved these exact words.`;
    return `${state} It no longer matches what Legion shipped, so agents read it as material, not as instructions.`;
  }
  if (f.trust === 'shipped') return 'Ships with Legion, unchanged. Agents read it as the app’s own rules.';
  if (f.trust === 'adopted') return 'You approved these exact words. Agents read them as your rules.';
  return f.category === 'yours'
    ? 'Agents read this as material to consider, never as instructions, until you approve it.'
    : 'This file no longer matches what Legion shipped. Agents read it as material, not as instructions, until you approve it.';
}

/** The one visible key to the trust tags, so no meaning lives only in a hover. */
export const TRUST_LEGEND = 'Tags: “From Legion” means unchanged, read as the app’s rules. “Approved by you” means read as your rules. “Edited” and “Not approved” mean read as material, never as instructions.';

/** "2 expected files are missing ..." */
export const missingLine = (names: readonly string[]): string =>
  `${plural(names.length, 'expected file')} ${names.length === 1 ? 'is' : 'are'} missing, so your doctrine is incomplete: ${names.join(', ')}. This usually means a partial install. Reinstall or update Legion to restore them.`;

/** "1 skill", "3 skills", "2 switches". */
export function plural(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : /(ch|sh|s|x)$/.test(noun) ? `${noun}es` : `${noun}s`}`;
}

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 10 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${Math.round(n / 1024)} KB`;
}

const baseName = (p: string): string => p.split('/').pop() ?? p;
const isSkillMd = (f: HouseFileView): boolean => f.category === 'skills' && !!f.skill && f.skill === f.path;
const isReference = (f: HouseFileView): boolean => f.category === 'skills' && !!f.skill && f.skill !== f.path;
const isAbout = (f: HouseFileView): boolean => f.category === 'skills' && !f.skill;

/** A search hit: every word of the query appears in the title, the path, the description or the names of its groups. */
export function matches(f: Pick<HouseFileView, 'title' | 'path' | 'description'> & { category?: HouseCategory }, query: string, extra = ''): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  // `extra` is the words of the group the row sits in, so "decrees" finds the decisions and "review" finds that skill group.
  const hay = `${f.title}\n${displayTitle(f)}\n${f.path}\n${f.description ?? ''}\n${extra}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface SkillRow {
  file: HouseFileView;
  /** Readable title: "Fix red CI", not the folder name. */
  displayTitle: string;
  /** Licence texts in the skill's own folder, derived from file names. */
  licences: HouseFileView[];
  /** Other files that follow this skill's switch. */
  references: number;
}
export interface SkillGroupView {
  key: string;
  title: string;
  summary: string;
  skills: SkillRow[];
  on: number;
  total: number;
  /** "2 of 4 on". */
  countLine: string;
}
export interface GroupView {
  info: GroupInfo;
  /** Rows with a switch (or a lock). For skills, empty: see `skillGroups`. */
  rows: HouseFileView[];
  skillGroups: SkillGroupView[];
  /** skills/README.md and skills/SOURCES.md, shown as links. */
  about: HouseFileView[];
  /** Number of things the heading counts: files, or skills. */
  count: number;
  countLine: string;
  locked: boolean;
}

export const LICENCE_RE = /^licen[cs]e/i;

/** The licence's short name from its own text ("MIT", "Apache-2.0"), or "" when it is not one of the common ones. */
export function licenceNameFromText(text: string): string {
  const head = String(text ?? '').slice(0, 4000);
  if (/apache license/i.test(head) && /version\s*2\.0/i.test(head)) return 'Apache-2.0';
  if (/\bmit license\b/i.test(head) || /permission is hereby granted, free of charge/i.test(head)) return 'MIT';
  if (/redistribution and use in source and binary forms/i.test(head)) return 'BSD';
  if (/\bisc license\b/i.test(head)) return 'ISC';
  if (/mozilla public license/i.test(head)) return 'MPL-2.0';
  if (/this is free and unencumbered software/i.test(head)) return 'Unlicense';
  return '';
}

/**
 * Button and dialog names for the licences of one skill: "Licence (MIT)". Two licences never share a name: a repeated
 * or unknown one gets its number ("Licence (MIT) 2", "Licence 1"). A lone licence of unknown kind is just "Licence".
 */
export function licenceLabels(names: readonly string[]): string[] {
  if (names.length === 1) return [names[0] ? `Licence (${names[0]})` : 'Licence'];
  return names.map((n, i) => {
    const unique = !!n && names.filter((x) => x === n).length === 1;
    return unique ? `Licence (${n})` : n ? `Licence (${n}) ${i + 1}` : `Licence ${i + 1}`;
  });
}

/** Words a skill row answers to in search for its licences: the word in both spellings, the file names, the known names. */
const licenceWords = (licences: readonly HouseFileView[], names: Readonly<Record<string, string>>): string =>
  licences.length ? `licence license ${licences.map((l) => `${baseName(l.path)} ${names[l.path] ?? ''}`).join(' ')}` : '';

/** How many rows the screen lists (reference files fold into their skill, about-files are links). */
export const listedCount = (files: readonly HouseFileView[]): number => files.filter((f) => !isReference(f) && !isAbout(f)).length;

/** The search box shows once the list is long enough that scanning it by eye is slow. */
export const SEARCH_THRESHOLD = 12;
export const showSearch = (files: readonly HouseFileView[]): boolean => listedCount(files) > SEARCH_THRESHOLD;

/**
 * Groups, in the owner's order, with empty groups hidden. With a query, only matching rows stay and a group with no
 * match is hidden. Count lines always describe the whole group, not the filtered part.
 */
export function buildView(files: readonly HouseFileView[], query = '', licenceNames: Readonly<Record<string, string>> = {}): GroupView[] {
  const q = query.trim();
  const out: GroupView[] = [];
  for (const info of GROUPS) {
    const inCat = files.filter((f) => f.category === info.category);
    if (!inCat.length) continue;
    if (info.category === 'skills') {
      const mds = inCat.filter(isSkillMd);
      const about = inCat.filter(isAbout);
      const byGroup = new Map<string, HouseFileView[]>();
      for (const f of mds) {
        const g = (f.group ?? '').trim() || 'other';
        byGroup.set(g, [...(byGroup.get(g) ?? []), f]);
      }
      const keys = [...byGroup.keys()].sort((a, b) => {
        const ia = SKILL_GROUP_ORDER.indexOf(a.toLowerCase());
        const ib = SKILL_GROUP_ORDER.indexOf(b.toLowerCase());
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
      });
      const skillGroups: SkillGroupView[] = [];
      for (const key of keys) {
        const all = byGroup.get(key)!;
        const gwords = `${info.title} ${plainHint(info)} ${skillGroupTitle(key)} ${skillGroupSummary(key, all.length)}`;
        const licencesOf = (f: HouseFileView): HouseFileView[] => inCat.filter((r) => isReference(r) && r.skill === f.path && LICENCE_RE.test(baseName(r.path)));
        const shown = all.filter((f) => matches(f, q, `${gwords} ${licenceWords(licencesOf(f), licenceNames)}`));
        if (!shown.length) continue;
        const on = all.filter((f) => f.on).length;
        skillGroups.push({
          key,
          title: skillGroupTitle(key),
          summary: skillGroupSummary(key, all.length),
          skills: shown.map((file) => ({
            file,
            displayTitle: skillDisplayTitle(file),
            licences: licencesOf(file),
            references: inCat.filter((r) => isReference(r) && r.skill === file.path && !LICENCE_RE.test(baseName(r.path))).length,
          })),
          on,
          total: all.length,
          countLine: `${on} of ${all.length} on`,
        });
      }
      if (q && !skillGroups.length) continue;
      const total = mds.length;
      const on = mds.filter((f) => f.on).length;
      out.push({
        info, rows: [], skillGroups, about: q ? [] : about, count: total, locked: false,
        countLine: total ? `${total} ${total === 1 ? 'skill' : 'skills'}, ${on} on` : 'none shipped',
      });
      continue;
    }
    const rows = inCat.filter((f) => matches(f, q, `${info.title} ${plainHint(info)}`));
    if (!rows.length) continue;
    out.push({
      info, rows, skillGroups: [], about: [], count: inCat.length, locked: info.category === 'core',
      countLine: `${inCat.length} ${inCat.length === 1 ? 'file' : 'files'}`,
    });
  }
  return out;
}

/** How many rows a filtered view lists: files, plus skills. */
export const matchCount = (groups: readonly GroupView[]): number => groups.reduce((n, g) => n + g.rows.length + g.skillGroups.reduce((m, sg) => m + sg.skills.length, 0), 0);

/** Whether Skills has nothing to list: no SKILL.md shipped. */
export const noSkillsShipped = (files: readonly HouseFileView[]): boolean => !files.some(isSkillMd);

/** Files whose switch a reset of this scope would flip: skills that are on, other rules that are off. */
export function wouldReset(files: readonly HouseFileView[], scope: { category: HouseCategory } | { group: string }): HouseFileView[] {
  if ('group' in scope) {
    const g = scope.group.toLowerCase();
    return files.filter((f) => isSkillMd(f) && (f.group ?? 'other').toLowerCase() === g && f.on);
  }
  const c = scope.category;
  if (c === 'core') return [];
  if (c === 'skills') return files.filter((f) => isSkillMd(f) && f.on);
  return files.filter((f) => f.category === c && !f.on && !f.locked);
}

/** The same list with one switch changed, and the reference files of a skill following it. Never mutates. */
export function withSwitch(files: readonly HouseFileView[], path: string, on: boolean): HouseFileView[] {
  const key = path.toLowerCase();
  return files.map((f) => (f.path.toLowerCase() === key || (f.skill && f.skill.toLowerCase() === key) ? { ...f, on } : f));
}

/** Home/End/Up/Down between disclosure headers. Returns the index to focus, or null for any other key. */
export function nextHeader(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** What the viewer remembers: which skill groups are open. Anything unreadable means "all collapsed". */
export function parseOpenGroups(raw: string | null | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (val === true) out[k] = true;
    return out;
  } catch {
    return {};
  }
}


type BulkScope = { category: HouseCategory } | { group: string };
/** Whether a bulk scope turns skills off (Drills and its sub-groups) rather than putting other files back on. */
export const isSkillScope = (scope: BulkScope): boolean => 'group' in scope || scope.category === 'skills';
/** The button's words: what it will do, by number ("Turn off 2", "Turn 2 back on"). */
export const bulkLabel = (scope: BulkScope, n: number): string => (isSkillScope(scope) ? `Turn off ${n}` : `Turn ${n} back on`);
/** The button's accessible name: the visible words, then which group it acts on, so two buttons never share a name. */
export const bulkName = (scope: BulkScope, n: number, groupTitle: string): string =>
  isSkillScope(scope) ? `Turn off ${plural(n, 'skill')} in ${groupTitle}` : `Turn ${n} back on in ${groupTitle}`;
/** The result, shown next to Undo and announced. */
export const bulkDone = (scope: BulkScope, n: number): string => (isSkillScope(scope) ? `Turned off ${plural(n, 'skill')}.` : `Turned ${plural(n, 'file')} back on.`);
export const bulkUndone = (scope: BulkScope, n: number): string => (isSkillScope(scope) ? `Turned ${plural(n, 'skill')} back on.` : `Turned ${plural(n, 'file')} off again.`);
/** Why the button is not offered when there is nothing to do. Skills say nothing: the header already reads "0 of 4 on". */
export const bulkNothing = (scope: BulkScope): string => (isSkillScope(scope) ? '' : 'Already at the defaults.');
