// The words of the web cards and the web line on the Gates page. The text lives in src/shared/web-copy.ts (the core builds the card summary from it too).
export { WEB_CARD, WEB_NOTICE, WEB_LINE, CONSENT_LINE } from '../../../src/shared/web-copy.js';

// The view model of the Gates page. Pure: it reads the registry and the settings the core sent, and decides nothing.
import { GATES, PRESETS, PRESET_LINES, gateValue, type GateSettings, type GateValue, type Preset } from '../../../src/shared/gates-registry.js';
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
