// The words of the web cards and the web line on the Gates page. The text lives in src/shared/web-copy.ts (the core builds the card summary from it too).
export { WEB_CARD, WEB_NOTICE, WEB_LINE, CONSENT_LINE } from '../../../src/shared/web-copy.js';
import { WEB_LINE as WEB_LINE_TEXT } from '../../../src/shared/web-copy.js';

// The view model of the Gates page. Pure: it reads the registry and the settings the core sent, and decides nothing.
import { GATES, NO_SANDBOX_LINE, PRESETS, PRESET_LINES, gateValue, type GateSettings, type GateValue, type Preset } from '../../../src/shared/gates-registry.js';
import type { ApprovalMode, RunMode } from '../../../src/shared/types.js';

export interface GatesView { app: GateSettings; projects: Record<string, GateSettings>; unreadable: string[]; changedOutside: string[]; canSign: boolean }

const PRESET_LABEL: Record<Preset, string> = { ask: 'Ask', 'accept-edits': 'Accept edits', smart: 'Smart', bypass: 'Bypass' };

export interface PresetChoice { id: Preset; label: string; line: string; looser: boolean }
/** The four presets in order. Every one but Ask is looser than Ask. */
export function presetChoices(): PresetChoice[] {
  return PRESETS.map((id) => ({ id, label: PRESET_LABEL[id], line: PRESET_LINES[id], looser: id !== 'ask' }));
}

/** What a mode is called to a person. A project preset of Bypass runs agents in `full`, so `full` reads Bypass here. */
export const MODE_LABEL: Record<RunMode, string> = { ask: 'Ask', 'auto-edits': 'Accept edits', smart: 'Smart', 'smart-edits': 'Smart and Accept edits', full: 'Bypass' };
/** What an agent's own stored mode is called in the agent editor. */
const AGENT_MODE_LABEL: Record<ApprovalMode, string> = { ask: 'Ask', 'auto-edits': 'Accept edits', full: 'Full' };

/** The name the settings files use for a scope: `app`, or the project id. */
const scopeName = (projectId?: string): string => projectId ?? 'app';

export function scopeSummary(view: GatesView, projectId?: string): { preset: Preset | 'per-agent'; limit: boolean; overrides: number; changedOutside: boolean; unreadable: boolean } {
  const s: GateSettings | undefined = projectId === undefined ? view.app : view.projects[projectId];
  const name = scopeName(projectId);
  return {
    preset: s?.preset ?? 'per-agent',
    limit: s?.preset !== undefined && s.limit !== false,
    overrides: Object.keys(s?.overrides ?? {}).length,
    changedOutside: view.changedOutside.includes(name),
    unreadable: view.unreadable.includes(name),
  };
}

export interface GateRow { id: string; label: string; protects: string; ifOff: string; value: GateValue; overridden: boolean; presetDefault: GateValue }
/** Every permission gate the registry has, with its value for this scope and what the preset alone would give. */
export function permissionRows(view: GatesView, projectId?: string): GateRow[] {
  const project = projectId === undefined ? undefined : view.projects[projectId];
  const scope = projectId === undefined ? view.app : project;
  const preset: Preset = project?.preset ?? view.app.preset ?? 'ask';
  return GATES.filter((g) => g.family === 'permission').map((g) => ({
    id: g.id, label: g.label, protects: g.protects, ifOff: g.ifOff,
    value: gateValue(g.id, { project, app: view.app }),
    overridden: scope?.overrides?.[g.id as keyof NonNullable<GateSettings['overrides']>] !== undefined,
    presetDefault: g.defaults === 'always' ? true : g.defaults[preset],
  }));
}

/** The QA gates follow a goal's care level. Every one is on at every level today. */
export function qaRows(): Array<{ id: string; label: string; protects: string; quick: boolean; normal: boolean; thorough: boolean }> {
  return GATES.filter((g) => g.family === 'qa').map((g) => ({ id: g.id, label: g.label, protects: g.protects, quick: true, normal: true, thorough: true }));
}

/** The rails: always on, no switch. */
export function railRows(): Array<{ id: string; label: string; protects: string }> {
  return GATES.filter((g) => g.family === 'rail').map((g) => ({ id: g.id, label: g.label, protects: g.protects }));
}

/** The chip on a run: how it runs and, when that differs from the agent's own setting, why. */
export function runsAsChip(a: { effective: RunMode; agentMode: ApprovalMode; source: 'own' | 'project'; projectName?: string; projectPreset?: Preset; limit: boolean; ceiling?: ApprovalMode; lease?: boolean }): { text: string; reason?: string } {
  const text = `Runs as ${MODE_LABEL[a.effective]}`;
  if (a.ceiling !== undefined && a.ceiling !== a.agentMode) return { text, reason: 'Started by an outside app: asks' };
  if (a.lease) return { text, reason: 'Goal lease: no cards for this goal' };
  const project = a.projectName ?? 'this project';
  if (a.source === 'project') return { text, reason: `Following project ${project}${a.projectPreset ? ` (${PRESET_LABEL[a.projectPreset]})` : ''}` };
  if (a.limit && a.effective !== a.agentMode) return { text, reason: `Agent is ${AGENT_MODE_LABEL[a.agentMode]}, limited by project ${project}` };
  return { text };
}

/** The two plain paragraphs under the presets: Legion does not confine the commands it runs, and what the web check does. */
export const PAGE_NOTES: { noSandbox: string; web: string } = { noSandbox: NO_SANDBOX_LINE, web: WEB_LINE_TEXT };

/** Said on the page (and as the reason a looser preset is off) when Legion has no safe place to keep its signing key. */
export const KEYSTORE_LINE = 'Legion cannot sign settings on your computer, so only Ask is available.';

/** Why a preset cannot be picked: only Ask can be stored when Legion cannot sign. undefined = it can be picked. */
export function disabledReason(view: GatesView, preset: Preset): string | undefined {
  return preset !== 'ask' && !view.canSign ? KEYSTORE_LINE : undefined;
}

/** The live line under a project's preset. `members` are the project's agent ids; an agent follows when its approvalSource is `project`. */
export function agentsFollowLine(agents: ReadonlyArray<{ id: string; approvalSource?: 'own' | 'project' }>, members: readonly string[], limit: boolean): string {
  const inProject = agents.filter((a) => members.includes(a.id));
  if (inProject.length === 0) return 'This project has no agents yet';
  const follow = inProject.filter((a) => a.approvalSource === 'project').length;
  const own = inProject.length - follow;
  const head = follow === 0 ? 'No agent follows this preset' : `${follow} ${follow === 1 ? 'agent follows' : 'agents follow'} this preset`;
  if (own === 0) return head;
  const tail = own === 1 ? 'has its own mode' : 'have their own mode';
  const cap = limit ? (own === 1 ? ' and is limited to it' : ' and are limited to it') : '';
  return `${head}; ${own} ${tail}${cap}`;
}

/** The whole overrides map for a scope with one gate set (or, with undefined, dropped so the preset decides again). The core replaces the map, so the page always sends all of it. */
export function overridesWith(view: GatesView, projectId: string, gateId: string, value: GateValue | undefined): Record<string, GateValue> {
  const next: Record<string, GateValue> = { ...(view.projects[projectId]?.overrides ?? {}) } as Record<string, GateValue>;
  if (value === undefined) delete next[gateId]; else next[gateId] = value;
  return next;
}

// ---- approved sites ---------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
export const STALE_DAYS = 60;

export interface SiteGroup { id: 'built-in' | 'allowed' | 'goal'; label: string; removable: boolean; hosts: Array<{ host: string; lastUsed: string }> }
/** The site list in three groups, each sorted. `lastUsed` values are ISO strings, shown as yyyy-mm-dd, or Never. */
export function siteGroups(s: { builtIn: string[]; allowed: string[]; goal: string[] }, lastUsed: Record<string, string>): SiteGroup[] {
  const hosts = (list: string[]) => [...list].sort().map((host) => ({ host, lastUsed: lastUsed[host] ? lastUsed[host]!.slice(0, 10) : 'Never' }));
  return [
    { id: 'built-in', label: 'Built in', removable: false, hosts: hosts(s.builtIn) },
    { id: 'allowed', label: 'You allowed', removable: true, hosts: hosts(s.allowed) },
    { id: 'goal', label: 'From a goal', removable: false, hosts: hosts(s.goal) },
  ];
}

/** Sites you allowed that no run has read for 60 days, or ever. */
export function staleHosts(allowed: string[], lastUsed: Record<string, string>, now: number): string[] {
  return allowed.filter((h) => {
    const at = lastUsed[h] ? Date.parse(lastUsed[h]!) : NaN;
    return Number.isNaN(at) || now - at > STALE_DAYS * DAY_MS;
  });
}

/** The newest read per site: from the `Web: <provider> <tool> <host>` activity lines and the dates the core saved; the newer wins. */
export function lastUsedByHost(lines: ReadonlyArray<{ at: string; kind: string; text: string }>, saved: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...saved };
  for (const l of lines) {
    if (l.kind !== 'web-call' || !l.text.startsWith('Web: ')) continue;
    const host = l.text.split(/\s+/).pop() ?? '';
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) continue;
    const cur = out[host];
    if (!cur || Date.parse(l.at) > Date.parse(cur)) out[host] = l.at;
  }
  return out;
}

/** The chip on a run: how much of the web it read. Hidden when it read nothing. */
export function webChip(a: { pages: number; newSites: number }): string | undefined {
  if (a.pages <= 0) return undefined;
  return `web: ${a.pages} ${a.pages === 1 ? 'page' : 'pages'}, ${a.newSites} new ${a.newSites === 1 ? 'site' : 'sites'}`;
}
