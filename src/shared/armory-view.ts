/**
 * What Settings → Armory shows, as pure functions over the answers of /api/armory and /api/armory/effective.
 *
 * Shared (like house-view.ts) so the screen and the tests use the same grouping, order, labels and counts. Nothing here calls the
 * core or touches the DOM. The core decides what a skill's state is; this module only arranges it.
 *
 * One part mirrors a rule that lives in the core, because the screen needs it before it can ask the core: `accessFor` and `draftSees`
 * mirror `access` (src/core/armory/catalog.ts), so the agent editor can count what an unsaved choice would give. test/armory-view.test.ts
 * runs both against the core code on the same fixtures. The import review is NOT mirrored: the core answers it (dryRun), so the
 * security rules (what is stripped, refused, dropped) live in one place.
 */
import { DESCRIPTION_CAP, SKILL_NAME_RE, agentSkillsAllow } from './skill-ids.js';

export type SkillSource = 'yours' | 'imported' | 'claude-personal' | 'claude-plugin' | 'claude-builtin';
/** Where a skill is grouped. Newer cores send it per skill; without it the group follows `source`. */
export type SkillGroupKind = SkillSource | 'claude-ai';
export type SkillState = 'on' | 'manual' | 'off';

/** One skill of GET /api/armory. */
export interface ArmorySkill {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  plugin: string | null;
  state: SkillState;
  stateIsDefault: boolean;
  agents: 'all' | string[];
  path: string | null;
  manualOnlyInFrontmatter: boolean;
  /** Which group the skill belongs in. Missing on an older core: the group then follows `source`. */
  groupKind?: SkillGroupKind;
  /** The /command Claude Code answers to. A string is used as is; null means it has none (its name has spaces); missing means "/<id>". */
  command?: string | null;
  /** Built-ins only: 'fit' is useful to a Legion agent, 'self' acts on Claude Code itself. */
  fit?: 'fit' | 'self' | 'other';
  /** Built-ins that act on Claude Code itself: kept off, cannot be turned on. */
  offReason?: string;
  /** The skill has a line Claude Code would run when the skill loads. Missing means false. */
  runsCommandsOnLoad?: boolean;
  /** The skill file or a reference holds hidden or direction-changing characters. Missing means false. */
  hiddenText?: boolean;
}

export interface ArmoryData {
  inherit: boolean;
  ccNoticeSeen: boolean;
  pluginRoot: string;
  /** Missing means false. */
  allowSkillShell?: boolean;
  skills: ArmorySkill[];
  /** When Claude Code was last asked what it loads (an ISO time), or null. Missing on an older core. */
  discoveredAt?: string | null;
  /** 'sdk': Claude Code answered. 'disk-fallback': its folders were read instead, so the list may miss skills. */
  discovery?: 'sdk' | 'disk-fallback';
  discoveryReason?: string | null;
  discoveryPlugins?: number;
}

export interface EffectiveEntry { id: string; name: string; description?: string; source?: string; path?: string }
export interface EffectiveView {
  agent: string;
  setting: 'inherit' | string[];
  drills: EffectiveEntry[];
  armory: EffectiveEntry[];
  claudeCode: EffectiveEntry[];
  counts: { drills: number; armory: number; claudeCode: number; total: number };
  warnAbove: number;
  overBudget: boolean;
}

/** One agent's entry of GET /api/armory/effective-all: the counts without the lists. */
export type EffectiveCounts = Pick<EffectiveView, 'agent' | 'setting' | 'counts' | 'warnAbove' | 'overBudget'>;

/** "1 skill", "3 skills". */
export const plural = (n: number, noun: string): string => `${n} ${n === 1 ? noun : /(ch|sh|s|x)$/.test(noun) ? `${noun}es` : `${noun}s`}`;

/** Ends a message with a full stop unless it already ends in . ! ? … so another sentence can follow it. */
export function endSentence(message: string): string {
  const m = String(message ?? '').trim();
  if (!m) return 'Something went wrong.';
  return /[.!?…]["')\]”’]*$/.test(m) ? m : `${m}.`;
}

/* ---- labels ---- */

export const SOURCE_LABEL: Record<SkillSource, string> = {
  yours: 'Yours',
  imported: 'Imported',
  'claude-personal': 'Your Claude Code',
  'claude-plugin': 'Claude Code plugin',
  'claude-builtin': 'Claude Code built-in',
};
/** The tag on a row: the plugin's name rides along, so a row found by search says where it lives. */
export const SYNCED_LABEL = 'Synced from claude.ai';
/** The kind a skill is grouped by: what the core says, else what `source` says. */
export const skillKind = (s: Pick<ArmorySkill, 'source' | 'groupKind'>): SkillGroupKind => s.groupKind ?? s.source;
export const sourceLabel = (s: Pick<ArmorySkill, 'source' | 'plugin'> & { groupKind?: SkillGroupKind }): string => {
  const k = skillKind(s);
  if (k === 'claude-ai') return SYNCED_LABEL;
  if (k === 'claude-plugin' && s.plugin) return `Claude Code plugin: ${s.plugin}`;
  return SOURCE_LABEL[k] ?? SOURCE_LABEL[s.source];
};

/** The `/command` a skill answers to in Claude Code: the core's own when it sends one, else "/<id>". */
export const commandOf = (s: Pick<ArmorySkill, 'id'> & { command?: string | null }): string =>
  typeof s.command === 'string' && s.command ? (s.command.startsWith('/') ? s.command : `/${s.command}`) : `/${s.id}`;
export const NO_COMMAND = 'No /command (name has spaces)';
export const NOT_IN_LEGION = 'not available in Legion';
/** What the row says about the /command: nothing typeable for a name with spaces, a muted one for a built-in Legion keeps off. */
export function commandView(s: Pick<ArmorySkill, 'id' | 'offReason'> & { command?: string | null }): { text: string; runnable: boolean; note: string } {
  if (s.command === null) return { text: NO_COMMAND, runnable: false, note: '' };
  if (s.offReason) return { text: commandOf(s), runnable: false, note: NOT_IN_LEGION };
  return { text: commandOf(s), runnable: true, note: '' };
}
/** The command a new skill of yours will answer to: Claude Code puts it behind the Armory's own prefix. */
export const YOURS_PREFIX = 'legion-armory';
export const newSkillCommand = (name: string): string => `/${YOURS_PREFIX}:${name.trim() || '<name>'}`;

/** Names more than one skill carries ("debug" built-in and "debug" from a plugin), lower case. */
const nameKey = (n: string): string => n.trim().toLowerCase();
export function duplicateNames(skills: readonly Pick<ArmorySkill, 'name'>[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const s of skills) { const k = nameKey(s.name); if (seen.has(k)) dup.add(k); else seen.add(k); }
  return dup;
}
const shortSource = (s: Pick<ArmorySkill, 'source' | 'plugin'> & { groupKind?: SkillGroupKind }): string => {
  const k = skillKind(s);
  return k === 'yours' ? 'yours' : k === 'imported' ? 'imported' : k === 'claude-personal' ? 'your Claude Code' : k === 'claude-ai' ? 'claude.ai' : k === 'claude-builtin' ? 'built-in' : s.plugin ?? 'plugin';
};
/** The name to say aloud: the plain name, or "debug (built-in)" when another skill has the same one. */
export const uniqueName = (s: Pick<ArmorySkill, 'name' | 'source' | 'plugin'> & { groupKind?: SkillGroupKind }, dups: ReadonlySet<string>): string =>
  dups.has(nameKey(s.name)) ? `${s.name} (${shortSource(s)})` : s.name;

export const STATE_OPTIONS: readonly { value: SkillState; label: string; hint: string }[] = [
  { value: 'on', label: 'Agents decide', hint: 'Agents see the description and open the skill when a task fits.' },
  { value: 'manual', label: 'Only when I ask', hint: 'Agents do not pick it up. It runs when you type its /command.' },
  { value: 'off', label: 'Off', hint: 'Hidden from agents, and Legion will not send its /command.' },
];
export const stateLabel = (s: SkillState): string => STATE_OPTIONS.find((o) => o.value === s)?.label ?? s;

/** Said in the live region after a change. */
export const stateDone = (name: string, s: SkillState): string =>
  s === 'on' ? `${name}: agents decide.` : s === 'manual' ? `${name}: only when you ask.` : `${name}: off.`;

export const RUNS_FLAG = 'Runs commands when loaded';
export const RUNS_WHY = 'This skill has a line that Claude Code runs on this computer the moment the skill loads, before the agent reads it.';
export const RUNS_BLOCKED = 'Blocked in Legion: the commands are not run.';
export const RUNS_ALLOWED = 'Allowed in Legion: the commands run when the skill loads.';
/** The one line under a flagged row, which depends on the Advanced switch. */
export const runsNote = (allowShell: boolean): string => `${RUNS_WHY} ${allowShell ? RUNS_ALLOWED : RUNS_BLOCKED}`;

export const NOTICE_TEXT = 'Choose which Claude Code skills your agents get. They are off until you turn them on.';
export const HEADER_TEXT = 'Skills your agents can pick up when a task calls for one. They are not rules: an agent reads one only when it needs it.';
export const SHELL_WARNING = 'A skill could run any command on this computer when it loads, without asking. Leave this off unless you trust every skill that is on.';
/** How the switch relates to the import refusal: one sentence, so neither reads as a contradiction of the other. */
export const SHELL_SCOPE = 'This only covers skills Claude Code already has. Adding a SKILL.md with such a line is still refused: Legion does not import skills that do that.';
/** The line shown for as long as the switch is on. */
export const SHELL_ON_LINE = 'On: skills can run commands when they load';
/** The step before the switch turns on: what changes, and how many skills it reaches. */
export function shellConfirm(withLine: number, withLineOn: number): string {
  const who = withLine
    ? `${plural(withLine, 'skill')} ${withLine === 1 ? 'has' : 'have'} such a line now${withLineOn ? `, ${withLineOn} of them on` : ', none of them on'}.`
    : 'No skill has such a line now.';
  return `Skills would run commands on this computer the moment they load, before an agent reads them, and nothing asks you first. ${who} Turn on anyway?`;
}
/** A description that hit the cap ends in "…" at nearly the cap (trimming a space before the mark can take a few characters), and the screen says so. A short one never counts. */
export const descriptionCut = (text: string): boolean => text.length >= DESCRIPTION_CAP - 20 && text.endsWith('…');
export const CUT_NOTE = `Shortened to ${DESCRIPTION_CAP} characters. Agents see this same shortened text, because every description goes into their prompt. Read the skill for the rest.`;
export const FILTER_NOTE = 'A skill the agent cannot see is hidden from its list. That is a context filter, not a lock.';

/* ---- search, filters, groups ---- */

export type ArmoryFilter = 'all' | 'yours' | 'imported' | 'claude';
export const FILTERS: readonly { id: ArmoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'yours', label: 'Yours' },
  { id: 'imported', label: 'Imported' },
  { id: 'claude', label: 'Claude Code' },
];
export const inFilter = (s: Pick<ArmorySkill, 'source'>, f: ArmoryFilter): boolean =>
  f === 'all' ? true : f === 'claude' ? s.source.startsWith('claude-') : s.source === f;

/** The second filter: what an agent does with the skill. "On" is "Agents decide". */
export type ArmoryStateFilter = 'all' | 'on' | 'manual';
export const STATE_FILTERS: readonly { id: ArmoryStateFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'on', label: 'On' },
  { id: 'manual', label: 'Only when I ask' },
];
export const inStateFilter = (s: Pick<ArmorySkill, 'state'>, f: ArmoryStateFilter): boolean => f === 'all' || s.state === f;

/** Every word of the query is in the name, id, description, plugin or source label. */
export function matches(s: ArmorySkill, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${s.name}\n${s.id}\n${s.description}\n${s.plugin ?? ''}\n${sourceLabel(s)}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** 0: the name or id is the query. 1: it starts with it. 2: it contains it. 3: only the description, plugin or source has it. */
export function matchRank(s: Pick<ArmorySkill, 'name' | 'id'>, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 3;
  const tail = s.id.includes(':') ? s.id.slice(s.id.lastIndexOf(':') + 1) : s.id;
  const names = [s.name, s.id, tail].map((x) => x.toLowerCase());
  if (names.some((n) => n === q)) return 0;
  if (names.some((n) => n.startsWith(q))) return 1;
  if (names.some((n) => n.includes(q))) return 2;
  return 3;
}

export type GroupKind = 'yours' | 'imported' | 'personal' | 'plugin' | 'claude-ai' | 'builtin';
export interface ArmoryGroup {
  key: string;
  kind: GroupKind;
  title: string;
  hint: string;
  /** What every row of the group is: a row repeats its source only when it differs from this. */
  tag: string;
  /** The rows to draw (after search). */
  skills: ArmorySkill[];
  /** Every skill of the group, whatever the search says: the counts describe these. */
  all: ArmorySkill[];
  on: number;
  manual: number;
  total: number;
  /** "3 of 12 on", with "only when asked" when some are. */
  countLine: string;
  /** Every Claude Code group (yours, plugins, claude.ai, built-ins) starts closed: there can be dozens of them. Yours and Imported start open. */
  collapsed: boolean;
}

/** The source tag a row carries: none when it is the same as the group's own, so a group of 300 does not say it 300 times. */
export const rowTag = (s: Pick<ArmorySkill, 'source' | 'plugin' | 'groupKind'>, g: Pick<ArmoryGroup, 'tag'>): string | null => {
  const t = sourceLabel(s);
  return t === g.tag ? null : t;
};

const byName = (a: ArmorySkill, b: ArmorySkill): number => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const FIT_ORDER: Record<string, number> = { fit: 0, other: 1, self: 2 };
/** Curated ones first, then the rest, then the ones that act on Claude Code itself (always off). */
const byBuiltin = (a: ArmorySkill, b: ArmorySkill): number =>
  (a.offReason ? 1 : 0) - (b.offReason ? 1 : 0) || (FIT_ORDER[a.fit ?? 'other'] ?? 1) - (FIT_ORDER[b.fit ?? 'other'] ?? 1) || byName(a, b);

export function countsOf(skills: readonly ArmorySkill[]): { total: number; on: number; manual: number; off: number } {
  const on = skills.filter((s) => s.state === 'on').length;
  const manual = skills.filter((s) => s.state === 'manual').length;
  return { total: skills.length, on, manual, off: skills.length - on - manual };
}
export function countLine(skills: readonly ArmorySkill[]): string {
  const c = countsOf(skills);
  return `${c.on} of ${c.total} on${c.manual ? `, ${c.manual} only when asked` : ''}`;
}

function group(kind: GroupKind, key: string, title: string, hint: string, all: ArmorySkill[], shown: ArmorySkill[], sort: (a: ArmorySkill, b: ArmorySkill) => number, collapsed: boolean): ArmoryGroup {
  const c = countsOf(all);
  return { key, kind, title, hint, tag: all[0] ? sourceLabel(all[0]) : title, skills: [...shown].sort(sort), all, on: c.on, manual: c.manual, total: c.total, countLine: countLine(all), collapsed };
}

/** The key of the group a skill is drawn in. */
export function groupKeyOf(s: Pick<ArmorySkill, 'source' | 'plugin' | 'groupKind'>): string {
  const k = skillKind(s);
  return k === 'yours' ? 'yours' : k === 'imported' ? 'imported' : k === 'claude-personal' ? 'personal' : k === 'claude-ai' ? 'claude-ai' : k === 'claude-builtin' ? 'builtin' : `plugin:${s.plugin ?? 'other'}`;
}

/**
 * Groups in the owner's order: Yours, Imported, Your Claude Code skills, one group per plugin (by name), Synced from claude.ai,
 * Claude Code built-ins. Empty groups are hidden. A search or a state filter keeps only matching rows and hides a group with none; a
 * search puts the exact name first, then names that start with it, then the rest, in the groups too. Counts describe the whole group.
 */
export function buildGroups(skills: readonly ArmorySkill[], filter: ArmoryFilter = 'all', query = '', stateFilter: ArmoryStateFilter = 'all'): ArmoryGroup[] {
  const q = query.trim();
  const pool = skills.filter((s) => inFilter(s, filter));
  const narrowed = !!q || stateFilter !== 'all';
  const out: ArmoryGroup[] = [];
  const best = new Map<ArmoryGroup, number>();
  const push = (kind: GroupKind, key: string, title: string, hint: string, all: ArmorySkill[], sort: (a: ArmorySkill, b: ArmorySkill) => number, collapsed: boolean): void => {
    if (!all.length) return;
    const shown = all.filter((s) => matches(s, q) && inStateFilter(s, stateFilter));
    if (narrowed && !shown.length) return;
    const ranked = q ? (a: ArmorySkill, b: ArmorySkill): number => matchRank(a, q) - matchRank(b, q) || sort(a, b) : sort;
    const g = group(kind, key, title, hint, all, shown, ranked, collapsed);
    out.push(g);
    if (q) best.set(g, g.skills.length ? matchRank(g.skills[0]!, q) : 4);
  };
  const kindIs = (k: SkillGroupKind) => (s: ArmorySkill): boolean => skillKind(s) === k;
  push('yours', 'yours', 'Yours', 'skills you wrote', pool.filter(kindIs('yours')), byName, false);
  push('imported', 'imported', 'Imported', 'added from a file or folder · off until you turn them on', pool.filter(kindIs('imported')), byName, false);
  push('personal', 'personal', 'Your Claude Code skills', 'from your own Claude Code folder', pool.filter(kindIs('claude-personal')), byName, true);
  const plugins = [...new Set(pool.filter(kindIs('claude-plugin')).map((s) => s.plugin ?? 'other'))].sort((a, b) => a.localeCompare(b));
  for (const p of plugins) {
    push('plugin', `plugin:${p}`, p, 'Claude Code plugin', pool.filter((s) => skillKind(s) === 'claude-plugin' && (s.plugin ?? 'other') === p), byName, true);
  }
  push('claude-ai', 'claude-ai', SYNCED_LABEL, 'skills from your claude.ai account', pool.filter(kindIs('claude-ai')), byName, true);
  push('builtin', 'builtin', 'Claude Code built-ins', 'ship with Claude Code · off until you turn them on', pool.filter(kindIs('claude-builtin')), byBuiltin, true);
  // A search puts the group with the best match first (the order stays as above between equals).
  return q ? out.map((g, i) => ({ g, i })).sort((a, b) => (best.get(a.g) ?? 4) - (best.get(b.g) ?? 4) || a.i - b.i).map((x) => x.g) : out;
}

/** "374 skills, 22 on." or, with a search or a state filter on, "12 shown, 3 on." The line describes what the list shows. */
export function totalLine(skills: readonly ArmorySkill[], filter: ArmoryFilter, stateFilter: ArmoryStateFilter, query: string, shown: readonly ArmorySkill[]): string {
  const pool = skills.filter((s) => inFilter(s, filter));
  if (query.trim() || stateFilter !== 'all') return `${shown.length} shown, ${shown.filter((s) => s.state === 'on').length} on.`;
  const on = pool.filter((s) => s.state === 'on').length;
  const what = filter === 'yours' ? `${plural(pool.length, 'skill')} of yours` : filter === 'imported' ? plural(pool.length, 'imported skill') : filter === 'claude' ? plural(pool.length, 'Claude Code skill') : plural(pool.length, 'skill');
  return `${what}, ${on} on.`;
}

/** The skills of one group, whatever the filter and search say (a bulk change acts on these). */
export const groupSkills = (skills: readonly ArmorySkill[], key: string): ArmorySkill[] => skills.filter((s) => groupKeyOf(s) === key);

export const matchCount = (groups: readonly ArmoryGroup[]): number => groups.reduce((n, g) => n + g.skills.length, 0);

/** The search box shows once the list is long enough that scanning it by eye is slow. */
export const SEARCH_THRESHOLD = 8;
export const showSearch = (skills: readonly ArmorySkill[]): boolean => skills.length > SEARCH_THRESHOLD;

/** What the group's header button is called: the group and its count. */
export const groupLabel = (g: Pick<ArmoryGroup, 'title' | 'countLine'>, forced = false): string => `${g.title}, ${g.countLine}${forced ? ', showing matches' : ''}`;

/** Which groups are open. Anything unreadable means "defaults". */
export function parseOpen(raw: string | null | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === 'boolean') out[k] = val;
    return out;
  } catch { return {}; }
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

/* ---- bulk changes ---- */

export type BulkTo = 'on' | 'off';
/** The skills a bulk change to `to` would change. A skill that acts on Claude Code itself is never turned on. */
export const bulkTargets = (skills: readonly ArmorySkill[], to: BulkTo): ArmorySkill[] =>
  skills.filter((s) => (to === 'on' ? s.state !== 'on' && !s.offReason : s.state !== 'off'));
/** The notice's "Turn all on": the skills inherited from Claude Code (not built-ins), that are not on yet. */
export const turnAllOnTargets = (skills: readonly ArmorySkill[]): ArmorySkill[] =>
  bulkTargets(skills.filter((s) => { const k = skillKind(s); return k === 'claude-personal' || k === 'claude-plugin' || k === 'claude-ai'; }), 'on');

/**
 * What a bulk change of one group touches. For the built-ins, "on" means only the useful ones (fit === 'fit'): the rest are not
 * Legion's to switch on in bulk, so each of those keeps its own control. Everywhere else it is bulkTargets over the whole group.
 */
export const groupBulkTargets = (skills: readonly ArmorySkill[], key: string, to: BulkTo): ArmorySkill[] => {
  const t = bulkTargets(groupSkills(skills, key), to);
  return key === 'builtin' && to === 'on' ? t.filter((s) => s.fit === 'fit') : t;
};

export const bulkLabel = (to: BulkTo, n: number, key = ''): string =>
  key === 'builtin' && to === 'on' ? (n === 1 ? 'Turn on the useful one' : `Turn on the ${n} useful ones`) : `Turn ${to} ${n}`;
export const bulkName = (to: BulkTo, n: number, groupTitle: string, key = ''): string =>
  key === 'builtin' && to === 'on' ? `${bulkLabel(to, n, key)} in ${groupTitle}` : `Turn ${to} ${plural(n, 'skill')} in ${groupTitle}`;
export const bulkDone = (to: BulkTo, n: number): string => `Turned ${to} ${plural(n, 'skill')}.`;
export const bulkUndone = (n: number): string => `Put back ${plural(n, 'skill')}.`;

/** The same list with one skill replaced. Never mutates. */
export const withSkill = (skills: readonly ArmorySkill[], next: ArmorySkill): ArmorySkill[] => skills.map((s) => (s.id === next.id ? next : s));
export const withState = (skills: readonly ArmorySkill[], id: string, state: SkillState): ArmorySkill[] => skills.map((s) => (s.id === id ? { ...s, state } : s));

/* ---- built-ins that stay off, and when the list was made ---- */

/** The built-ins Legion keeps off, named once at the top of the built-ins group (a row only carries a short tag). */
export function lockedNote(skills: readonly Pick<ArmorySkill, 'name' | 'offReason'>[]): string {
  const names = skills.filter((s) => s.offReason).map((s) => s.name).sort((a, b) => a.localeCompare(b));
  if (!names.length) return '';
  return `Kept off in Legion: ${names.join(', ')} ${names.length === 1 ? 'changes' : 'change'} Claude Code itself, not the work an agent does.`;
}
export const KEPT_OFF_TAG = 'Kept off';

/** "just now", "3 minutes ago", "2 hours ago", "5 days ago". An unreadable or future time is "just now". */
export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return '';
  const sec = Math.max(0, Math.round((nowMs - at) / 1000));
  if (sec < 45) return 'just now';
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return unit(Math.max(1, min), 'minute');
  const hr = Math.round(min / 60);
  if (hr < 24) return unit(hr, 'hour');
  return unit(Math.round(hr / 24), 'day');
}

/** The line under the header: when Claude Code was last asked. Empty when your Claude Code skills are not used at all. */
export function discoveryLine(d: Pick<ArmoryData, 'inherit' | 'discoveredAt'>, nowMs: number): string {
  if (!d.inherit) return '';
  const when = relativeTime(d.discoveredAt, nowMs);
  return when ? `Listed from Claude Code ${when}.` : 'Not listed from Claude Code yet.';
}

/**
 * Said when Claude Code could not be asked and the list was read from its folders instead. Empty when it answered, and when the
 * owner turned inheriting off (then nothing from Claude Code is listed on purpose, and the screen already says so).
 */
export function discoveryWarning(d: Pick<ArmoryData, 'inherit' | 'discovery' | 'discoveryReason'>): string {
  if (!d.inherit || d.discovery !== 'disk-fallback') return '';
  const why = String(d.discoveryReason ?? '').replace(/\s+/g, ' ').trim().replace(/[.!?…\s]+$/, '');
  return `Could not ask Claude Code${why ? ` (${why})` : ''}, so this list comes from its folders and may miss skills. Refresh to try again.`;
}

/* ---- which agents ---- */

export interface AgentRef { id: string; name: string }

/** "All", "All but Zealot", "None", "Only Builder", "Only Builder, Scout", "3 of 9". */
export function agentsLabel(grant: 'all' | readonly string[], agents: readonly AgentRef[]): string {
  if (grant === 'all') return 'All';
  const known = agents.filter((a) => grant.includes(a.id));
  if (!known.length) return 'None';
  if (known.length === agents.length) return 'All';
  const left = agents.filter((a) => !grant.includes(a.id));
  if (left.length <= 2 && left.length < known.length) return `All but ${left.map((a) => a.name).join(', ')}`;
  if (known.length <= 2) return `Only ${known.map((a) => a.name).join(', ')}`;
  return `${known.length} of ${agents.length}`;
}
export const agentsButtonName = (skillName: string, grant: 'all' | readonly string[], agents: readonly AgentRef[]): string =>
  `Agents for ${skillName}: ${agentsLabel(grant, agents)}`;

/** The list after ticking or clearing one agent. Choosing every agent turns back into 'all', so a new agent is not left out. */
export function toggleAgent(grant: 'all' | readonly string[], agents: readonly AgentRef[], id: string, on: boolean): 'all' | string[] {
  const cur = grant === 'all' ? agents.map((a) => a.id) : [...grant];
  const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
  return agents.length > 0 && agents.every((a) => next.includes(a.id)) ? 'all' : next;
}
export const agentChecked = (grant: 'all' | readonly string[], id: string): boolean => grant === 'all' || grant.includes(id);

/* ---- what an agent sees ---- */

/** "7 skills: 2 drills, 3 Armory, 2 Claude Code." When every skill comes from one place the split says nothing new: "349 Claude Code skills." */
function breakdown(c: { drills: number; armory: number; claudeCode: number; total: number }): string {
  const kinds = [{ n: c.drills, one: 'drill', many: 'drills' }, { n: c.armory, one: 'Armory skill', many: 'Armory skills' }, { n: c.claudeCode, one: 'Claude Code skill', many: 'Claude Code skills' }].filter((k) => k.n > 0);
  if (kinds.length === 1) return `${kinds[0]!.n} ${kinds[0]!.n === 1 ? kinds[0]!.one : kinds[0]!.many}.`;
  const parts = [c.drills ? plural(c.drills, 'drill') : '', c.armory ? `${c.armory} Armory` : '', c.claudeCode ? `${c.claudeCode} Claude Code` : ''].filter(Boolean);
  return `${plural(c.total, 'skill')}: ${parts.join(', ')}.`;
}
/** "Builder sees 7 skills: 2 drills, 3 Armory, 2 Claude Code." */
export function seesLine(name: string, c: { drills: number; armory: number; claudeCode: number; total: number }): string {
  if (!c.total) return `${name} sees no skills.`;
  return `${name} sees ${breakdown(c)}`;
}
/** The same line without the agent's name, for a row that already carries it: "7 skills: 2 drills, 3 Armory, 2 Claude Code." */
export function seesText(c: { drills: number; armory: number; claudeCode: number; total: number }): string {
  if (!c.total) return 'No skills.';
  return breakdown(c);
}
/** Under a row whose count is past the limit the confirm step also uses (WARN_ABOVE); empty when it is not. */
export const crowdsLine = (total: number, warnAbove = WARN_ABOVE): string => (total > warnAbove ? `More than about ${warnAbove} skill descriptions crowds out the task.` : '');
export const budgetWarning = (name: string, total: number, warnAbove: number): string =>
  `${name} would see ${total} skill descriptions; more than about ${warnAbove} crowds out the task.`;
export const WARN_ABOVE = 40;

const overWho = (over: readonly { name: string }[], everyone: number): { who: string; many: boolean } => {
  if (everyone > 1 && over.length === everyone) return { who: 'Every agent', many: false };
  if (over.length === 1) return { who: over[0]!.name, many: false };
  if (over.length <= 3) return { who: `${over.slice(0, -1).map((o) => o.name).join(', ')} and ${over[over.length - 1]!.name}`, many: true };
  return { who: `${over.length} of ${everyone} agents`, many: true };
};
const rangeText = (loads: readonly { total: number }[]): string => {
  const lo = Math.min(...loads.map((l) => l.total));
  const hi = Math.max(...loads.map((l) => l.total));
  return lo === hi ? `${hi}` : `${lo} to ${hi}`;
};
/** One line for the whole list of agents (said once, not under every agent). Empty when no agent is over. */
export function budgetSummary(over: readonly { name: string; total: number }[], everyone: number, warnAbove = WARN_ABOVE): string {
  if (!over.length) return '';
  const { who, many } = overWho(over, everyone);
  return `${who} ${many ? 'see' : 'sees'} more than about ${warnAbove} skill descriptions (${rangeText(over)}). That crowds out the task.`;
}

export interface AgentLoadRef { id: string; name: string; skills?: 'inherit' | string[] }
/** How many skill descriptions each agent would see with these skills (the same count as draftSees). No agents yet: one nominal agent. */
export function agentLoads(skills: readonly ArmorySkill[], drills: readonly DrillRef[], agents: readonly AgentLoadRef[], warnAbove = WARN_ABOVE): { name: string; total: number }[] {
  const list = agents.length ? agents : [{ id: '', name: 'An agent' }];
  return list.map((a) => ({ name: a.name, total: draftSees(skills, drills, a.id, (a as AgentLoadRef).skills ?? 'inherit', warnAbove).total }));
}
/** "Agents now see 356 descriptions." said after a bulk change, and with Undo. */
export const loadsLine = (loads: readonly { total: number }[]): string => (loads.length ? `Agents now see ${rangeText(loads)} descriptions.` : '');
/** "3 run commands when loaded and 2 have hidden characters." Empty when nothing is flagged. */
export function flagsLine(runs: number, hidden: number, lead = 'Of these'): string {
  const parts = [runs ? `${runs} ${runs === 1 ? 'runs' : 'run'} commands when loaded` : '', hidden ? `${hidden} ${hidden === 1 ? 'has' : 'have'} hidden characters` : ''].filter(Boolean);
  return parts.length ? `${lead}, ${parts.join(' and ')}.` : '';
}

export interface BulkConsequence {
  count: number;
  loads: { name: string; total: number }[];
  over: boolean;
  runs: number;
  hidden: number;
  /** What to say before turning these on when it would crowd an agent's prompt; empty when it would not. */
  message: string;
  /** The skills behind `runs` and `hidden`, by name, so the confirm can say which ones. */
  runNames: string[];
  hiddenNames: string[];
}
/** What a bulk change leaves out, said beside the count: the built-in skills are not part of "Turn all on". */
export const NOT_BUILTINS = 'the built-in skills are not included';
/** "Of the 349 you are turning on, 3 run commands when loaded (a, b, c) and 4 have hidden characters (d, e, f, g)." The names are the answer to "which ones?". */
export function flagsNamed(runNames: readonly string[], hiddenNames: readonly string[], of: number): string {
  const part = (names: readonly string[], one: string, many: string): string => (names.length ? `${names.length} ${names.length === 1 ? one : many} (${shortList(names, 4)})` : '');
  const parts = [part(runNames, 'runs commands when loaded', 'run commands when loaded'), part(hiddenNames, 'has hidden characters', 'have hidden characters')].filter(Boolean);
  return parts.length ? `Of the ${of} you are turning on, ${parts.join(' and ')}.` : '';
}
/**
 * What turning `targets` on would do, said BEFORE it is done: the most descriptions any agent would then see (the same count as the
 * agent editor), and how many of the skills carry a flag. `over` means some agent would pass the budget, so a confirm step is asked.
 */
export function bulkConsequence(skills: readonly ArmorySkill[], targets: readonly ArmorySkill[], drills: readonly DrillRef[], agents: readonly AgentLoadRef[], warnAbove = WARN_ABOVE, excluded = ''): BulkConsequence {
  const ids = new Set(targets.map((t) => t.id));
  const after = skills.map((s) => (ids.has(s.id) ? { ...s, state: 'on' as const } : s));
  const loads = agentLoads(after, drills, agents, warnAbove);
  const over = loads.filter((l) => l.total > warnAbove);
  const runNames = targets.filter((t) => t.runsCommandsOnLoad).map((t) => t.name);
  const hiddenNames = targets.filter((t) => t.hiddenText).map((t) => t.name);
  const runs = runNames.length;
  const hidden = hiddenNames.length;
  const flags = flagsNamed(runNames, hiddenNames, targets.length);
  const lead = over.length ? `${overWho(over, loads.length).who} would see ${rangeText(over)} skill descriptions if you turn on ${plural(targets.length, 'skill')}${excluded ? ` (${excluded})` : ''}.` : '';
  const message = over.length ? `${lead} More than about ${warnAbove} crowds out the task.${flags ? ` ${flags}` : ''} Turn on anyway?` : '';
  return { count: targets.length, loads, over: over.length > 0, runs, hidden, message, runNames, hiddenNames };
}

/** Mirrors `access` in src/core/armory/catalog.ts: what one agent gets of one skill. */
export function accessFor(s: Pick<ArmorySkill, 'id' | 'state' | 'agents' | 'offReason'>, agent: { id: string; skills?: 'inherit' | string[] }): SkillState {
  if (s.offReason) return 'off';
  if (s.state === 'off') return 'off';
  if (s.state === 'manual') return 'manual';
  if (s.agents !== 'all' && !s.agents.some((a) => a === agent.id)) return 'manual';
  if (!agentSkillsAllow(agent.skills, s.id)) return 'manual';
  return 'on';
}

export interface DrillRef { id: string; name: string; on: boolean }
export interface Sees { drills: number; armory: number; claudeCode: number; total: number; over: boolean }

/** What an agent would see with a draft setting: the same counts as /api/armory/effective, before the setting is saved. */
export function draftSees(skills: readonly ArmorySkill[], drills: readonly DrillRef[], agentId: string, setting: 'inherit' | string[], warnAbove = WARN_ABOVE): Sees {
  const agent = { id: agentId, skills: setting };
  const on = skills.filter((s) => accessFor(s, agent) === 'on');
  const d = drills.filter((x) => x.on && agentSkillsAllow(setting, x.id)).length;
  const armory = on.filter((s) => s.source === 'yours' || s.source === 'imported').length;
  const claudeCode = on.length - armory;
  const total = d + armory + claudeCode;
  return { drills: d, armory, claudeCode, total, over: total > warnAbove };
}

/** The choice a "Choose skills" list starts from: what the agent gets now. */
export function currentGrant(skills: readonly ArmorySkill[], drills: readonly DrillRef[], agentId: string, setting: 'inherit' | string[]): string[] {
  const agent = { id: agentId, skills: setting };
  return [...skills.filter((s) => accessFor(s, agent) === 'on').map((s) => s.id), ...drills.filter((d) => d.on && agentSkillsAllow(setting, d.id)).map((d) => d.id)];
}
/** The server takes at most this many ids in one skills list. */
export const MAX_AGENT_SKILLS = 500;

/** The checklist's rows: every skill that can be on (a skill that acts on Claude Code itself cannot). */
export const selectable = (skills: readonly ArmorySkill[]): ArmorySkill[] => skills.filter((s) => !s.offReason);

export type Tri = 'all' | 'some' | 'none';
export function triOf(ids: readonly string[], chosen: ReadonlySet<string>): Tri {
  const n = ids.filter((i) => chosen.has(i)).length;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}

/**
 * Why a tick will not reach the agent anyway (the list only narrows), said on that line: "Not for Zealot: limited to other agents in
 * the Armory. Change it there." Empty when the skill reaches the agent.
 */
export function tickReason(s: Pick<ArmorySkill, 'state' | 'agents'>, agentId: string, who: string): string {
  const why = s.state === 'off' ? 'off in the Armory' : s.state === 'manual' ? 'only when asked in the Armory'
    : s.agents !== 'all' && !s.agents.some((a) => a === agentId) ? 'limited to other agents in the Armory' : '';
  return why ? `Not for ${who}: ${why}. Change it there.` : '';
}

/* ---- the editor ---- */

export const LIMITS = { description: 500, whenToUse: 500, body: 200_000 } as const;
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

export const NAME_RULE = 'Use lower case letters, digits and hyphens, starting with a letter or digit, up to 64 characters.';
/** A suggestion for a typed name: "My Skill!" becomes "my-skill". Empty when nothing usable is left. */
export const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

/** What a typed name could be instead ("My Skill!" is "my-skill"), or '' when there is nothing better to offer. */
export const nameSuggestion = (name: string): string => { const s = slugify(name); return s && s !== name && SKILL_NAME_RE.test(s) ? s : ''; };

/** Empty string means fine. The message is shown live under the field. */
export function nameError(name: string, taken: readonly string[] = [], withSuggestion = true): string {
  if (!name) return 'Give it a name.';
  if (!SKILL_NAME_RE.test(name)) {
    const s = nameSuggestion(name);
    return `${NAME_RULE}${withSuggestion && s ? ` Try ${s}.` : ''}`;
  }
  if (taken.includes(name)) return `You already have one called ${name}. Pick another name.`;
  return '';
}
export function descriptionError(text: string, noun = 'skill'): string {
  const n = flat(text).length;
  if (!n) return `Describe it in a line. An agent reads this to decide whether to open the ${noun}.`;
  return n > LIMITS.description ? `That is ${n - LIMITS.description} over the ${LIMITS.description} character limit.` : '';
}
export const whenError = (text: string): string => (flat(text).length > LIMITS.whenToUse ? `That is ${flat(text).length - LIMITS.whenToUse} over the ${LIMITS.whenToUse} character limit.` : '');
export function bodyError(text: string, noun = 'skill'): string {
  if (!text.trim()) return `Write what the ${noun} tells an agent to do.`;
  return text.length > LIMITS.body ? `That is ${text.length - LIMITS.body} over the ${LIMITS.body} character limit.` : '';
}
export const counter = (text: string, max: number): string => `${flat(text).length} of ${max}`;
export const bodyCounter = (text: string): string => `${text.length.toLocaleString('en-US')} of ${LIMITS.body.toLocaleString('en-US')}`;

export interface EditorFields { name: string; description: string; whenToUse: string; body: string }
export interface EditorErrors { name: string; description: string; whenToUse: string; body: string }
export function editorErrors(f: EditorFields, taken: readonly string[] = [], noun = 'skill'): EditorErrors {
  return { name: nameError(f.name, taken), description: descriptionError(f.description, noun), whenToUse: whenError(f.whenToUse), body: bodyError(f.body, noun) };
}
export const editorOk = (e: EditorErrors): boolean => !e.name && !e.description && !e.whenToUse && !e.body;

/** Text that looks like a key or a password. The editor warns (it does not block): an exported skill carries it along. */
const SECRET_RES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];
export const looksLikeSecret = (text: string): boolean => SECRET_RES.some((r) => r.test(text));
export const SECRET_WARNING = 'This text looks like it holds a key or a password. A skill is plain text that agents read, and it travels with an export. Take the secret out.';

const FM = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/** Top-level `key: value` pairs of a frontmatter block (mirrors parseFrontmatter in src/core/house/skills.ts). */
export function frontmatterOf(text: string): Record<string, string> {
  const m = FM.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1]!.split(/\r?\n/);
  const indented = (l: string | undefined): boolean => l !== undefined && /^\s+\S/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(v)) {
      const folded = v.startsWith('>');
      const parts: string[] = [];
      while (i + 1 < lines.length && (indented(lines[i + 1]) || lines[i + 1]!.trim() === '')) parts.push(lines[++i]!.trim());
      v = parts.join(folded ? ' ' : '\n').replace(/\s+$/, '');
    } else if (v === '') {
      while (i + 1 < lines.length && (indented(lines[i + 1]) || lines[i + 1]!.trim() === '')) i++;
    } else {
      while (indented(lines[i + 1])) v += ' ' + lines[++i]!.trim();
      const q = /^(["'])([\s\S]*)\1$/.exec(v);
      if (q) v = q[2]!;
    }
    out[kv[1]!] = v;
  }
  return out;
}

export interface ParsedSkillMd extends EditorFields {
  /** Header keys other than name and description. Saving in the editor keeps only the two. */
  extraKeys: string[];
}
const USE_WHEN = ' Use when: ';
/** Splits a SKILL.md the editor wrote (or any SKILL.md) back into its fields. The description line splits at "Use when:" and rejoins the same way. */
export function parseSkillMd(text: string): ParsedSkillMd {
  const fm = frontmatterOf(text);
  const m = FM.exec(text);
  const desc = fm.description ?? '';
  const cut = desc.indexOf(USE_WHEN);
  const keys = m ? [...m[1]!.matchAll(/^([A-Za-z_][\w-]*):/gm)].map((x) => x[1]!) : [];
  return {
    name: fm.name ?? '',
    description: cut >= 0 ? desc.slice(0, cut) : desc,
    whenToUse: cut >= 0 ? desc.slice(cut + USE_WHEN.length) : '',
    body: (m ? text.slice(m[0].length) : text).replace(/^\s+/, '').replace(/\s+$/, ''),
    extraKeys: [...new Set(keys)].filter((k) => k !== 'name' && k !== 'description'),
  };
}

/** What Undo for Remove posts: the same text, so nothing is lost. Description carries the "Use when" part, whenToUse stays out. */
export function restorePayload(text: string): EditorFields {
  const p = parseSkillMd(text);
  const fm = frontmatterOf(text);
  return { name: p.name, description: fm.description ?? '', whenToUse: '', body: p.body };
}

/* ---- import review: the core's answer, shown as it comes (no rules live here) ---- */

/**
 * One file as the screen sends it to POST /api/armory/import. A .md file small enough to read is sent with its text; any other file
 * is sent as `{path, size, text: null}`, so its bytes never leave the disk and the core lists it as left out.
 */
export type SentFile = { path: string; text: string } | { path: string; size: number; text: null };

/** The answer to POST /api/armory/import with dryRun: what an import would do, or why it is refused. Built by the core, never here. */
export interface ImportReview {
  ok: boolean;
  /** Why nothing can be added, in plain words. Empty when ok. */
  refusal: string;
  name: string;
  id: string;
  description: string;
  /** Paths under the skill folder that would be written. */
  kept: string[];
  dropped: { path: string; reason: string }[];
  /** Frontmatter keys that would be removed. */
  stripped: string[];
  /** The SKILL.md as it would be written (stripped keys gone), for the rendered preview. */
  skillText: string;
  /** Hidden or direction-changing characters found in the kept .md files. Reported, never removed. */
  hiddenChars?: { file: string; codepoint: string; count: number }[];
}

/** What the review says about hidden characters, or '' when there are none. */
export function hiddenCharsLine(chars: readonly { file: string; codepoint: string; count: number }[] | undefined): string {
  if (!chars || !chars.length) return '';
  const parts = chars.slice(0, 6).map((c) => `${c.codepoint} x${c.count} in ${c.file}`);
  const more = chars.length > 6 ? ` and ${chars.length - 6} more` : '';
  return `Contains hidden or direction-changing characters: ${parts.join(', ')}${more}.`;
}

/**
 * The same text with every hidden or direction-changing character written out as a visible marker, "⟨U+202E⟩", so a preview shows what
 * is there instead of acting on it. The set is the core's (findHiddenChars); a byte order mark at the very start is a file marker, not text.
 */
export function showHidden(text: string): string {
  return String(text ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g, (c, i: number) =>
    c === '\uFEFF' && i === 0 ? c : `\u27E8U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}\u27E9`);
}

/** The row flag for a skill that holds hidden characters, and the one line that says why it matters. */
export const HIDDEN_TEXT_FLAG = 'Contains hidden characters';
export const HIDDEN_TEXT_WHY = 'Text that is invisible or reads in another direction can show you one thing and tell the agent another. Legion shows this flag and does not remove the characters.';

/** "This cannot be added: ..." once: a reason that already says it was refused is not prefixed twice. */
export function refusalLine(refusal: string): string {
  const r = endSentence(String(refusal ?? '').trim().replace(/^SKILL\.md was refused:\s*/i, ''));
  return /^(this cannot be added|legion does not|refused)/i.test(r) ? r : `This cannot be added: ${r}`;
}

/** The screen reads a file only when it is a .md file of at most this many bytes. A convenience, not a rule: the core decides what is kept. */
export const READ_UP_TO = 512_000;
export const isReadable = (path: string, size: number): boolean => /.md$/i.test(path) && size <= READ_UP_TO;

/** Folders a picker should not walk into: they hold tool files, not skills. They are dropped before the count limit applies. */
export const isJunkPath = (p: string): boolean => p.replace(/\\/g, '/').split('/').some((seg) => (seg.startsWith('.') && seg !== '.' && seg !== '..') || seg === 'node_modules');
export const JUNK_REASON = 'a hidden or tool folder';

/** "a.md, b.md and 3 more" for a long list of paths. */
export function shortList(items: readonly string[], max = 6): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

/** What Undo for a removed imported skill can bring back: only SKILL.md is sent again, so reference files are gone. */
export const IMPORTED_UNDO_NOTE = 'Only SKILL.md comes back, and it comes back off.';
