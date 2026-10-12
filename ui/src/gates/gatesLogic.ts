/**
 * The Gates view-model: sentences, chips, presets and the dry-run tester's model. Pure functions and constants
 * only — the same strings the Settings surface renders and stores as GateRule.label, so what the owner reads IS
 * the rule. The tester calls the real decideGate; it runs nothing.
 */
import { decideGate } from '../../../src/core/gates.js';
import type { ApprovalMode, GateContext, GateRule, GateVerdict, GatesConfig, GateWhen } from '../../../src/shared/types.js';

/** Each agent's mode, in the same plain words the agent editor uses (mode first, gates on top). */
export const MODE_TEXT: Record<ApprovalMode, string> = {
  ask: 'Ask before Bash, edits, MCP',
  'auto-edits': 'Allow edits, ask for Bash/MCP',
  full: 'Full access, never ask',
};

/** The "What" chips: the tool groups a rule may name (see GATE_TOOL_GROUPS in src/core/gates.ts). */
export const TOOL_CHIPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'shell', label: 'Shell' },
  { id: 'edits', label: 'File edits' },
  { id: 'reads', label: 'File reads' },
  { id: 'web', label: 'Web' },
  { id: 'host', label: 'Host shell' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'blender', label: 'Blender' },
];

/** The "Where" context chips, each with the one line that explains what it means. */
export const CONTEXT_CHIPS: ReadonlyArray<{ id: GateContext; label: string; why: string }> = [
  { id: 'capped', label: 'Started by Claude Code or another bot', why: 'A run another program started. Rules can only make it stricter, never looser.' },
  { id: 'room-hop', label: 'Another agent asked for this', why: 'A run woken by a message from another agent.' },
  { id: 'tainted', label: 'After outside content', why: 'The run already touched text or results from outside Legion.' },
  { id: 'connector-data', label: 'After GitHub data', why: 'The run already read data through a connector.' },
];

const TOOL_LABEL: Record<string, string> = Object.fromEntries(TOOL_CHIPS.map((c) => [c.id, c.label.toLowerCase()]));
const CONTEXT_LABEL: Record<GateContext, string> = Object.fromEntries(CONTEXT_CHIPS.map((c) => [c.id, c.label.toLowerCase()])) as Record<GateContext, string>;

/** A fresh rule id: 'gr_' plus 12 hex characters, the shape shared/config.ts accepts. */
export function newGateId(): string {
  const hex = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  return `gr_${hex}`;
}

/** Add/remove one item in a chip list (the builder's only list operation). */
export function toggleIn(list: readonly string[], x: string): string[] {
  return list.includes(x) ? list.filter((v) => v !== x) : [...list, x];
}

const joinOr = (xs: readonly string[]): string => xs.map((p) => '`' + p + '`').join(' or ');

/**
 * The sentence a rule is stored AS and shown AS. Grammar holds for every shape: the verb form follows the
 * "what" (run/running, change/changing, use/using), so no combination reads broken. `projectOf` maps a project
 * id to the name the owner knows (default: the id itself).
 */
export function gateSentence(when: GateWhen, then: GateVerdict, nameOf: (id: string) => string, projectOf: (id: string) => string = (id) => id): string {
  const who = when.agents?.length ? when.agents.map(nameOf).join(', ') : 'Every agent';
  const pats = when.commands ?? [];
  const paths = when.paths ?? [];
  const tools = (when.tools ?? []).map((t) => TOOL_LABEL[t] ?? t);
  let base: string;
  let ing: string;
  if (pats.length) { base = 'run ' + joinOr(pats); ing = 'running ' + joinOr(pats); }
  else if (paths.length) { base = 'change files matching ' + joinOr(paths); ing = 'changing files matching ' + joinOr(paths); }
  else if (tools.length) { base = 'use ' + tools.join(', '); ing = 'using ' + tools.join(', '); }
  else { base = 'do anything'; ing = 'doing anything'; }
  let s = then === 'allow' ? `${who} may ${base}`
    : then === 'deny' ? `${who} may never ${base}`
      : `${who} needs your OK before ${ing}`;
  if (when.projects?.length) s += ' \u00b7 in ' + when.projects.map(projectOf).join(', ');
  if (when.contexts?.length) s += ' \u00b7 only when ' + when.contexts.map((c) => CONTEXT_LABEL[c]).join(' or ');
  return s;
}

/** A rule touches the agent shell only when its tools name the host group, a host glob, or a host tool exactly. */
export function ruleNeedsHost(when: GateWhen): boolean {
  return (when.tools ?? []).some((t) => t === 'host' || t.startsWith('mcp__host__'));
}

/** True when no agent a rule affects has the host shell on — the card says so instead of pretending to act. */
export function ruleHostless(when: GateWhen, agents: readonly Pick<{ id: string; host?: { enabled?: boolean } }, 'id' | 'host'>[]): boolean {
  if (!ruleNeedsHost(when)) return false;
  const scope = when.agents?.length ? agents.filter((a) => when.agents!.includes(a.id)) : agents;
  return !scope.some((a) => a.host?.enabled === true);
}

/** The consequence line under "Then": computed from the rule and the agent's real mode — never a made-up number. */
export function consequenceLine(then: GateVerdict, mode: ApprovalMode): string {
  if (then === 'deny') return 'Applies in every mode, Full included — the one class that survives Full access.';
  if (then === 'ask') return mode === 'full'
    ? 'This agent has Full access, so Ask rules are off here. Block rules still apply.'
    : 'Makes matching calls ask you, on top of this agent\u2019s mode (' + MODE_TEXT[mode] + ').';
  return 'Lets matching calls run without asking. On Full access it changes nothing (nothing asks there anyway); it never loosens a run another bot started.';
}

/** The shipped preset: the Hermes "never, even under yolo" floor, offered (never auto-applied). */
export const GATE_PRESETS: ReadonlyArray<{ id: string; title: string; when: GateWhen; then: GateVerdict; label: string }> = [
  {
    id: 'destructive-block', title: 'Suggested: never rm -rf / sudo', then: 'deny',
    when: { commands: ['rm -rf *', 'sudo *', 'mkfs*', 'format *'] },
    label: 'No agent may ever run rm -rf, sudo, mkfs or format',
  },
];

/** The default rule list, stamped with the preset provenance. */
export function presetRule(p: { id: string; when: GateWhen; then: GateVerdict; label: string }): GateRule {
  return { id: newGateId(), enabled: true, then: p.then, when: structuredCloneSafe(p.when), label: p.label, source: 'preset' };
}

/** structuredClone without assuming it exists in an old webview. */
function structuredCloneSafe<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

/** The tester's view of one call. */
export interface GateTestCall { toolName: string; input: Record<string, unknown>; agentId?: string; mode: ApprovalMode }

export interface GateTestResult {
  verdict: GateVerdict | 'baseline';
  /** Every rule whose `when` matched, labels included, for the "why" readout. */
  matched: GateRule[];
}

/**
 * The "Try it" tester: the SAME decideGate the engine calls, with the rules exactly as stored. It decides, prints
 * and runs NOTHING — same contract as `hermes approvals test`.
 */
export function gateTestResult(rules: readonly GateRule[], call: GateTestCall, capped = false): GateTestResult {
  const d = decideGate({ toolName: call.toolName, input: call.input, agentId: call.agentId }, rules, call.mode, capped);
  return { verdict: d.verdict, matched: d.ruleIds.map((id) => rules.find((r) => r.id === id)).filter((r): r is GateRule => !!r) };
}

/** The verdict line the tester prints (exit-code style, consistent with allow / ask-approval / deny). */
export const VERDICT_TEXT: Record<GateTestResult['verdict'], string> = {
  allow: 'ALLOW (no card)',
  ask: 'ASK (a card appears)',
  deny: 'DENY (the call is blocked)',
  baseline: 'BASELINE (no rule matched — your agent\u2019s mode decides)',
};

/** The locked rails: decided before rules, visible so a rule can never look like it failed silently. */
export const GATE_RAILS: ReadonlyArray<{ title: string; why: string }> = [
  { title: 'Connector writes always ask', why: 'A connector gateway write raises its own card in every mode, Full included. No rule can loosen or tighten it.' },
  { title: 'Web access after connector data asks', why: 'A tainted run that already read GitHub data asks before WebFetch/WebSearch: that data can walk out with the request.' },
  { title: 'A run started by another bot is never loosened', why: 'Its approval ceiling lets rules only make it stricter; an "allow" rule is ignored there (confused-deputy guard).' },
  { title: 'Full access never shows a card', why: 'One rule, no exceptions (2026-10-04): in Full a guard never asks. Ask rules are off there; Block rules still apply.' },
  { title: 'Rules never hand over tools', why: 'The host shell and connectors stay per-agent opt-ins in the agent editor. A rule only shapes when a call asks.' },
  { title: 'Some cards stay click-only', why: 'Blender cards cannot be answered from the keyboard, whatever the rules say.' },
];

/** The empty state's teaching line: mode first, gates on top. */
export const GATES_EMPTY = 'Your agents\u2019 approval mode decides the default. Gates adjust it for one agent, one command, or one project \u2014 Block rules apply even to Full access; Ask rules never fire there.';
